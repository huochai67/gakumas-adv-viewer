/**
 * Browser Unity asset environment.
 *
 * Ports the read-only parts of `pipeline/unity_fs.ts`, `pipeline/serialized_file.ts`,
 * `pipeline/assets.ts`, `pipeline/gltf.ts`, `pipeline/unity_anim.ts` and the CRI
 * @UTF/AFS2 reader from `pipeline/export_voices.ts` into a dependency-free ES
 * module. Bundle decryption, LZ4 decompression and (elsewhere) texture/HCA
 * decoding are performed by `wasm/gakumas_core.wasm` through `wasm_bridge.js`.
 */

import { initWasm, decryptBundle, decompressLz4Block } from './wasm_bridge.js';

const utf8 = new TextDecoder('utf-8');
const ALIGN_FLAG = 0x4000;

/* -------------------------------------------------------------------------- */
/* UnityFS container                                                          */
/* -------------------------------------------------------------------------- */

class BigEndianReader {
  constructor(buf) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = 0;
  }

  get length() {
    return this.buf.byteLength;
  }

  u8() {
    const value = this.view.getUint8(this.pos);
    this.pos += 1;
    return value;
  }

  u16() {
    const value = this.view.getUint16(this.pos, false);
    this.pos += 2;
    return value;
  }

  u32() {
    const value = this.view.getUint32(this.pos, false);
    this.pos += 4;
    return value;
  }

  i32() {
    const value = this.view.getInt32(this.pos, false);
    this.pos += 4;
    return value;
  }

  i64() {
    const value = this.view.getBigInt64(this.pos, false);
    this.pos += 8;
    return value;
  }

  cstring() {
    let end = this.buf.indexOf(0, this.pos);
    if (end === -1) end = this.buf.length;
    const value = utf8.decode(this.buf.subarray(this.pos, end));
    this.pos = end < this.buf.length ? end + 1 : end;
    return value;
  }
}

function decompressBlock(src, uncompressedSize, compression) {
  switch (compression & 0x3f) {
    case 0:
      return src;
    case 2:
    case 3:
      return decompressLz4Block(src, uncompressedSize);
    default:
      throw new Error(`Unsupported UnityFS compression mode ${compression & 0x3f}`);
  }
}

/**
 * Parse a big-endian UnityFS bundle and return every contained file keyed by
 * its directory path.
 */
export function readUnityFS(buf) {
  const reader = new BigEndianReader(buf);

  const signature = reader.cstring();
  if (signature !== 'UnityFS') {
    throw new Error(`Not a UnityFS bundle (signature ${JSON.stringify(signature)})`);
  }
  const version = reader.u32();
  reader.cstring(); // versionPlayer
  reader.cstring(); // versionEngine
  reader.i64(); // total uncompressed bundle size (unused)
  const compressedSize = reader.u32();
  const uncompressedSize = reader.u32();
  const dataflags = reader.u32();

  // Version >= 7: the header is padded to a 16-byte boundary.
  if (version >= 7) {
    reader.pos = (reader.pos + 15) & ~15;
  }

  let blocksInfoBytes;
  if ((dataflags & 0x80) !== 0) {
    // Block info lives at the end of the bundle.
    blocksInfoBytes = buf.subarray(buf.length - compressedSize);
  } else {
    blocksInfoBytes = buf.subarray(reader.pos, reader.pos + compressedSize);
    reader.pos += compressedSize;
  }

  const blocksInfo = decompressBlock(blocksInfoBytes, uncompressedSize, dataflags & 0x3f);
  const infoReader = new BigEndianReader(blocksInfo);

  infoReader.pos = 16; // uncompressedDataHash
  const blocksCount = infoReader.i32();
  if (blocksCount < 0) throw new Error(`Invalid UnityFS block count ${blocksCount}`);

  const blocks = new Array(blocksCount);
  for (let i = 0; i < blocksCount; i++) {
    blocks[i] = {
      uncompressedSize: infoReader.u32(),
      compressedSize: infoReader.u32(),
      flags: infoReader.u16(),
    };
  }

  const nodesCount = infoReader.i32();
  if (nodesCount < 0) throw new Error(`Invalid UnityFS node count ${nodesCount}`);

  const nodes = new Array(nodesCount);
  for (let i = 0; i < nodesCount; i++) {
    nodes[i] = {
      offset: Number(infoReader.i64()),
      size: Number(infoReader.i64()),
      flags: infoReader.u32(),
      path: infoReader.cstring(),
    };
  }

  // kArchiveBlockInfoNeedPaddingAtStart: 16-byte align before block data.
  if ((dataflags & 0x200) !== 0) {
    reader.pos = (reader.pos + 15) & ~15;
  }

  let totalUncompressed = 0;
  for (const block of blocks) totalUncompressed += block.uncompressedSize;

  const combinedData = new Uint8Array(totalUncompressed);
  let outOffset = 0;
  for (const block of blocks) {
    const end = reader.pos + block.compressedSize;
    if (end > buf.length) throw new Error('UnityFS block data exceeds bundle size');
    const compressed = buf.subarray(reader.pos, end);
    reader.pos = end;

    const blockData = decompressBlock(compressed, block.uncompressedSize, block.flags);
    if (blockData.length < block.uncompressedSize) {
      throw new Error('UnityFS block decompressed to fewer bytes than expected');
    }
    combinedData.set(blockData.subarray(0, block.uncompressedSize), outOffset);
    outOffset += block.uncompressedSize;
  }

  const files = new Map();
  for (const node of nodes) {
    const start = node.offset;
    const end = start + node.size;
    if (start < 0 || end > combinedData.length) {
      throw new Error(`UnityFS node ${node.path} is outside the data range`);
    }
    files.set(node.path, combinedData.subarray(start, end));
  }
  return files;
}

/* -------------------------------------------------------------------------- */
/* SerializedFile + TypeTree                                                  */
/* -------------------------------------------------------------------------- */

/** Unity's 114-entry common string table used by TypeTree blobs. */
export const COMMON_STRINGS = {
  0: 'AABB',
  5: 'AnimationClip',
  19: 'AnimationCurve',
  34: 'AnimationState',
  49: 'Array',
  55: 'Base',
  60: 'BitField',
  69: 'bitset',
  76: 'bool',
  81: 'char',
  86: 'ColorRGBA',
  96: 'Component',
  106: 'data',
  111: 'deque',
  117: 'double',
  124: 'dynamic_array',
  138: 'FastPropertyName',
  155: 'first',
  161: 'float',
  167: 'Font',
  172: 'GameObject',
  183: 'Generic Mono',
  196: 'GradientNEW',
  208: 'GUID',
  213: 'GUIStyle',
  222: 'int',
  226: 'list',
  231: 'long long',
  241: 'map',
  245: 'Matrix4x4f',
  256: 'MdFour',
  263: 'MonoBehaviour',
  277: 'MonoScript',
  288: 'm_ByteSize',
  299: 'm_Curve',
  307: 'm_EditorClassIdentifier',
  331: 'm_EditorHideFlags',
  349: 'm_Enabled',
  359: 'm_ExtensionPtr',
  374: 'm_GameObject',
  387: 'm_Index',
  395: 'm_IsArray',
  405: 'm_IsStatic',
  416: 'm_MetaFlag',
  427: 'm_Name',
  434: 'm_ObjectHideFlags',
  452: 'm_PrefabInternal',
  469: 'm_PrefabParentObject',
  490: 'm_Script',
  499: 'm_StaticEditorFlags',
  519: 'm_Type',
  526: 'm_Version',
  536: 'Object',
  543: 'pair',
  548: 'PPtr<Component>',
  564: 'PPtr<GameObject>',
  581: 'PPtr<Material>',
  596: 'PPtr<MonoBehaviour>',
  616: 'PPtr<MonoScript>',
  633: 'PPtr<Object>',
  646: 'PPtr<Prefab>',
  659: 'PPtr<Sprite>',
  672: 'PPtr<TextAsset>',
  688: 'PPtr<Texture>',
  702: 'PPtr<Texture2D>',
  718: 'PPtr<Transform>',
  734: 'Prefab',
  741: 'Quaternionf',
  753: 'Rectf',
  759: 'RectInt',
  767: 'RectOffset',
  778: 'second',
  785: 'set',
  789: 'short',
  795: 'size',
  800: 'SInt16',
  807: 'SInt32',
  814: 'SInt64',
  821: 'SInt8',
  827: 'staticvector',
  840: 'string',
  847: 'TextAsset',
  857: 'TextMesh',
  866: 'Texture',
  874: 'Texture2D',
  884: 'Transform',
  894: 'TypelessData',
  907: 'UInt16',
  914: 'UInt32',
  921: 'UInt64',
  928: 'UInt8',
  934: 'unsigned int',
  947: 'unsigned long long',
  966: 'unsigned short',
  981: 'vector',
  988: 'Vector2f',
  997: 'Vector3f',
  1006: 'Vector4f',
  1015: 'm_ScriptingClassIdentifier',
  1042: 'Gradient',
  1051: 'Type*',
  1057: 'int2_storage',
  1070: 'int3_storage',
  1083: 'BoundsInt',
  1093: 'm_CorrespondingSourceObject',
  1121: 'm_PrefabInstance',
  1138: 'm_PrefabAsset',
  1152: 'FileSize',
  1161: 'Hash128',
  1169: 'RenderingLayerMask',
  1188: 'fixed_array',
  1200: 'EntityId',
  1209: 'LoadableObjectId',
  1226: 'LoadableSceneId',
};

export class BinaryReader {
  constructor(buf, littleEndian = true, pos = 0) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = pos;
    this.littleEndian = littleEndian;
  }

  get length() {
    return this.buf.byteLength;
  }

  get remaining() {
    return this.buf.byteLength - this.pos;
  }

  align(n = 4) {
    const rem = this.pos % n;
    if (rem !== 0) this.pos += n - rem;
  }

  skip(n) {
    this.pos += n;
  }

  readInt8() {
    const value = this.view.getInt8(this.pos);
    this.pos += 1;
    return value;
  }

  readUint8() {
    const value = this.view.getUint8(this.pos);
    this.pos += 1;
    return value;
  }

  readInt16() {
    const value = this.view.getInt16(this.pos, this.littleEndian);
    this.pos += 2;
    return value;
  }

  readUint16() {
    const value = this.view.getUint16(this.pos, this.littleEndian);
    this.pos += 2;
    return value;
  }

  readInt32() {
    const value = this.view.getInt32(this.pos, this.littleEndian);
    this.pos += 4;
    return value;
  }

  readUint32() {
    const value = this.view.getUint32(this.pos, this.littleEndian);
    this.pos += 4;
    return value;
  }

  readInt64() {
    const value = this.view.getBigInt64(this.pos, this.littleEndian);
    this.pos += 8;
    return value;
  }

  readUint64() {
    const value = this.view.getBigUint64(this.pos, this.littleEndian);
    this.pos += 8;
    return value;
  }

  readFloat32() {
    const value = this.view.getFloat32(this.pos, this.littleEndian);
    this.pos += 4;
    return value;
  }

  readFloat64() {
    const value = this.view.getFloat64(this.pos, this.littleEndian);
    this.pos += 8;
    return value;
  }

  readBoolean() {
    return this.readUint8() !== 0;
  }

  readBytes(n) {
    if (n < 0) throw new RangeError(`Cannot read ${n} bytes`);
    const end = this.pos + n;
    if (end > this.buf.byteLength) {
      throw new RangeError(`Read of ${n} bytes at ${this.pos} exceeds ${this.buf.byteLength}`);
    }
    const value = this.buf.subarray(this.pos, end);
    this.pos = end;
    return value;
  }

  readCString() {
    let end = this.buf.indexOf(0, this.pos);
    if (end === -1) end = this.buf.byteLength;
    const value = utf8.decode(this.buf.subarray(this.pos, end));
    this.pos = end < this.buf.byteLength ? end + 1 : end;
    return value;
  }

  readAlignedString() {
    const length = this.readInt32();
    if (length > 0 && length <= this.buf.byteLength - this.pos) {
      const value = utf8.decode(this.buf.subarray(this.pos, this.pos + length));
      this.pos += length;
      this.align(4);
      return value;
    }
    this.align(4);
    return '';
  }

  readByteArray() {
    const length = this.readInt32();
    if (length <= 0) return new Uint8Array(0);
    return this.readBytes(length);
  }

  readInt32Array() {
    const length = this.readInt32();
    const values = new Int32Array(length);
    for (let i = 0; i < length; i++) values[i] = this.readInt32();
    return values;
  }
}

function decodeTypeTreeStrings(stringBuffer) {
  const strings = new Map();
  let pos = 0;
  while (pos < stringBuffer.length) {
    let end = stringBuffer.indexOf(0, pos);
    if (end === -1) end = stringBuffer.length;
    strings.set(pos, utf8.decode(stringBuffer.subarray(pos, end)));
    pos = end + 1;
  }
  return strings;
}

/** Parses the embedded TypeTree blob (format versions >= 12). */
export function parseTypeTreeBlob(reader, version) {
  if (version >= 23) {
    const magic = utf8.decode(reader.readBytes(4));
    if (magic !== 'mhtt') {
      throw new Error(`Invalid type tree blob magic ${JSON.stringify(magic)}`);
    }
    const formatVersion = reader.readInt32();
    if (formatVersion !== version) {
      throw new Error(`Inconsistent type tree format version ${formatVersion} (expected ${version})`);
    }
  }
  if (version < 12) {
    throw new Error(`Inline type trees are not supported (format version ${version})`);
  }

  const nodeCount = reader.readInt32();
  const stringBufferSize = reader.readInt32();
  if (nodeCount < 0 || stringBufferSize < 0) {
    throw new Error('Invalid type tree blob header');
  }

  const rawNodes = new Array(nodeCount);
  const hasRefTypeHash = version >= 19;
  for (let i = 0; i < nodeCount; i++) {
    rawNodes[i] = {
      m_Version: reader.readInt16(),
      m_Level: reader.readUint8(),
      m_TypeFlags: reader.readUint8(),
      m_TypeStrOffset: reader.readUint32(),
      m_NameStrOffset: reader.readUint32(),
      m_ByteSize: reader.readInt32(),
      m_Index: reader.readInt32(),
      m_MetaFlag: reader.readInt32(),
      m_RefTypeHash: hasRefTypeHash ? reader.readUint64() : 0n,
    };
  }

  const stringBuffer = reader.readBytes(stringBufferSize);
  const strings = decodeTypeTreeStrings(stringBuffer);

  const resolveString = (offset) => {
    if ((offset & 0x80000000) === 0) {
      return strings.get(offset) ?? '';
    }
    const common = offset & 0x7fffffff;
    return COMMON_STRINGS[common] ?? String(common);
  };

  const fakeRoot = {
    m_Version: 0,
    m_Level: -1,
    m_TypeFlags: 0,
    m_TypeStrOffset: 0,
    m_NameStrOffset: 0,
    m_ByteSize: 0,
    m_Index: 0,
    m_MetaFlag: 0,
    m_RefTypeHash: 0n,
    m_Type: '',
    m_Name: '',
    m_Children: [],
  };

  const stack = [fakeRoot];
  let parent = fakeRoot;
  let prev = fakeRoot;

  for (const raw of rawNodes) {
    const node = {
      m_Version: raw.m_Version,
      m_Level: raw.m_Level,
      m_TypeFlags: raw.m_TypeFlags,
      m_TypeStrOffset: raw.m_TypeStrOffset,
      m_NameStrOffset: raw.m_NameStrOffset,
      m_ByteSize: raw.m_ByteSize,
      m_Index: raw.m_Index,
      m_MetaFlag: raw.m_MetaFlag,
      m_RefTypeHash: raw.m_RefTypeHash,
      m_Type: resolveString(raw.m_TypeStrOffset),
      m_Name: resolveString(raw.m_NameStrOffset),
      m_Children: [],
    };
    if (node.m_Level > prev.m_Level) {
      stack.push(parent);
      parent = prev;
    } else if (node.m_Level < prev.m_Level) {
      while (node.m_Level <= parent.m_Level) {
        parent = stack.pop();
      }
    }
    parent.m_Children.push(node);
    prev = node;
  }

  const root = fakeRoot.m_Children[0];
  if (!root) throw new Error('Type tree blob contains no nodes');
  return root;
}

function typeInfoString(typeInfo, key) {
  if (typeInfo === null || typeof typeInfo !== 'object') return '';
  const value = typeInfo[key];
  return typeof value === 'string' ? value : '';
}

function getReferencedTypeNode(value, assetsFile) {
  const typeInfo = value.type;
  const className = typeInfoString(typeInfo, 'class');
  const nameSpace = typeInfoString(typeInfo, 'ns');
  const assemblyName = typeInfoString(typeInfo, 'asm');
  if (!className) return null;
  const refTypes = assetsFile?.refTypes;
  if (!refTypes || refTypes.length === 0) {
    throw new Error('SerializedFile has no ref_types for ReferencedObjectData');
  }
  for (const refType of refTypes) {
    if (
      className === refType.m_ClassName &&
      nameSpace === refType.m_NameSpace &&
      assemblyName === refType.m_AssemblyName
    ) {
      return refType.node;
    }
  }
  throw new Error(`Referenced type not found: ${className} ${nameSpace} ${assemblyName}`);
}

/**
 * Reads one value described by a TypeTree node.
 *
 * `suppressAlign` is used for array elements whose subtype itself carries the
 * 4-byte alignment flag: Unity aligns once after the whole array, not once per
 * element.
 */
export function readTypeTree(node, reader, assetsFile, suppressAlign = false) {
  let align = (node.m_MetaFlag & ALIGN_FLAG) !== 0;
  let value;

  switch (node.m_Type) {
    case 'SInt8':
      value = reader.readInt8();
      break;
    case 'UInt8':
    case 'char':
      value = reader.readUint8();
      break;
    case 'short':
    case 'SInt16':
      value = reader.readInt16();
      break;
    case 'unsigned short':
    case 'UInt16':
      value = reader.readUint16();
      break;
    case 'int':
    case 'SInt32':
      value = reader.readInt32();
      break;
    case 'unsigned int':
    case 'UInt32':
    case 'Type*':
      value = reader.readUint32();
      break;
    case 'long long':
    case 'SInt64':
      value = reader.readInt64();
      break;
    case 'unsigned long long':
    case 'UInt64':
    case 'FileSize':
      value = reader.readUint64();
      break;
    case 'float':
      value = reader.readFloat32();
      break;
    case 'double':
      value = reader.readFloat64();
      break;
    case 'bool':
      value = reader.readBoolean();
      break;
    case 'string':
      value = reader.readAlignedString();
      break;
    case 'TypelessData':
      value = reader.readByteArray();
      break;
    case 'pair':
      value = [
        readTypeTree(node.m_Children[0], reader, assetsFile),
        readTypeTree(node.m_Children[1], reader, assetsFile),
      ];
      break;
    case 'ReferencedObject': {
      const object = {};
      for (const child of node.m_Children) {
        if (child.m_Type === 'ReferencedObjectData') {
          const refNode = getReferencedTypeNode(object, assetsFile);
          if (!refNode) continue;
          object[child.m_Name] = readTypeTree(refNode, reader, assetsFile);
        } else {
          object[child.m_Name] = readTypeTree(child, reader, assetsFile);
        }
      }
      value = object;
      break;
    }
    default: {
      if (node.m_Children.length > 0 && node.m_Children[0].m_Type === 'Array') {
        const arrayNode = node.m_Children[0];
        if (arrayNode.m_Children.length < 2) {
          throw new Error(`Malformed Array node for ${node.m_Name}`);
        }
        const subtype = arrayNode.m_Children[1];
        if (((arrayNode.m_MetaFlag | subtype.m_MetaFlag) & ALIGN_FLAG) !== 0) {
          align = true;
        }
        const size = reader.readInt32();
        if (size < 0) throw new Error(`Negative array length ${size} for ${node.m_Name}`);
        if (subtype.m_Type === 'UInt8' || subtype.m_Type === 'char') {
          value = reader.readBytes(size);
        } else {
          const elementAlign = (subtype.m_MetaFlag & ALIGN_FLAG) !== 0;
          const values = new Array(size);
          for (let i = 0; i < size; i++) {
            values[i] = readTypeTree(subtype, reader, assetsFile, elementAlign);
          }
          value = values;
        }
      } else {
        // Struct / class: fields are stored in declaration order.
        const object = {};
        let hasManagedReferencesRegistry = false;
        for (const child of node.m_Children) {
          if (child.m_Type === 'ManagedReferencesRegistry') {
            if (hasManagedReferencesRegistry) continue;
            hasManagedReferencesRegistry = true;
          }
          object[child.m_Name] = readTypeTree(child, reader, assetsFile);
        }
        value = object;
      }
      break;
    }
  }

  if (align && !suppressAlign) reader.align(4);
  return value;
}

export const read_type_tree = readTypeTree;

export class UnityObject {
  constructor(assetsFile, pathId, typeId, byteStart, byteSize) {
    this.assetsFile = assetsFile;
    this.pathId = pathId;
    this.typeId = typeId;
    this.byteStart = byteStart;
    this.byteSize = byteSize;

    const serializedType = assetsFile.types[typeId];
    this.classId = serializedType ? serializedType.classId : -1;
    this._node = serializedType ? serializedType.node : null;
    this.typeName = this._node ? this._node.m_Type : `Class${this.classId}`;
    this._cache = null;
  }

  get path_id() {
    return this.pathId;
  }

  get node() {
    return this._node;
  }

  read() {
    if (this._cache !== null) return this._cache;
    if (!this._node) {
      throw new Error(`Object ${this.pathId} (type ${this.typeName}) has no embedded TypeTree`);
    }
    const reader = new BinaryReader(this.assetsFile.data, this.assetsFile.littleEndian, this.byteStart);
    const value = readTypeTree(this._node, reader, this.assetsFile);
    if (value !== null && typeof value === 'object') {
      Object.defineProperty(value, '_assetsFile', {
        value: this.assetsFile,
        enumerable: false,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(value, '_pathId', {
        value: this.pathId,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    this._cache = value;
    return this._cache;
  }

  read_typetree() {
    return this.read();
  }

  readTypetree() {
    return this.read();
  }
}

export class SerializedFile {
  constructor(nameOrData, dataOrName) {
    let name;
    let data;
    if (typeof nameOrData === 'string') {
      name = nameOrData;
      if (!(dataOrName instanceof Uint8Array)) {
        throw new TypeError('SerializedFile requires a Uint8Array of file data');
      }
      data = dataOrName;
    } else {
      data = nameOrData;
      name = typeof dataOrName === 'string' ? dataOrName : '';
    }
    this.name = name;
    this.data = data;
    this.unityVersion = '';
    this.targetPlatform = 0;
    this.enableTypeTree = false;
    this.types = [];
    this.objects = new Map();
    this.externals = [];
    this.refTypes = [];
    this.userInformation = '';

    const reader = new BinaryReader(data, false);
    reader.readUint32(); // metadataSize (legacy header field)
    reader.readUint32(); // fileSize (legacy header field)
    const version = reader.readUint32();
    reader.readUint32(); // dataOffset (legacy header field)
    const endianByte = reader.readUint8();
    const reserved = reader.readBytes(3);

    if (version < 22) {
      throw new Error(`Unsupported SerializedFile format version ${version}`);
    }

    const metadataSize = reader.readUint32();
    const fileSize = Number(reader.readInt64());
    const dataOffset = Number(reader.readInt64());
    reader.readInt64(); // unknown

    reader.littleEndian = endianByte === 0;
    this.littleEndian = reader.littleEndian;
    this.version = version;
    this.header = {
      metadataSize,
      fileSize,
      version,
      dataOffset,
      endian: endianByte === 0 ? '<' : '>',
      reserved,
    };

    this.unityVersion = reader.readCString();
    this.targetPlatform = reader.readInt32();
    this.enableTypeTree = reader.readBoolean();

    const typeCount = reader.readInt32();
    this.types = new Array(typeCount);
    for (let i = 0; i < typeCount; i++) {
      const classId = reader.readInt32();
      const isStrippedType = reader.readBoolean();
      const scriptTypeIndex = reader.readInt16();
      const scriptId = classId === 114 ? reader.readBytes(16) : null;
      const oldTypeHash = reader.readBytes(16);
      let node = null;
      let typeDependencies;
      if (this.enableTypeTree) {
        node = parseTypeTreeBlob(reader, version);
        typeDependencies = reader.readInt32Array();
      }
      this.types[i] = {
        classId,
        isStrippedType,
        scriptTypeIndex,
        scriptId,
        oldTypeHash,
        node,
        typeDependencies,
      };
    }

    const objectCount = reader.readInt32();
    for (let i = 0; i < objectCount; i++) {
      reader.align(4);
      const pathId = reader.readInt64();
      const byteStart = Number(reader.readInt64()) + dataOffset;
      const byteSize = reader.readUint32();
      const typeId = reader.readInt32();
      const object = new UnityObject(this, pathId, typeId, byteStart, byteSize);
      this.objects.set(pathId, object);
    }

    const scriptCount = reader.readInt32();
    for (let i = 0; i < scriptCount; i++) {
      reader.readInt32();
      reader.align(4);
      reader.readInt64();
    }

    const externalCount = reader.readInt32();
    for (let i = 0; i < externalCount; i++) {
      const tempEmpty = reader.readCString();
      const guid = reader.readBytes(16);
      const type = reader.readInt32();
      const path = reader.readCString();
      this.externals.push({ path, guid, type, tempEmpty });
    }

    const refTypeCount = reader.readInt32();
    for (let i = 0; i < refTypeCount; i++) {
      const classId = reader.readInt32();
      reader.readBoolean(); // isStrippedType
      const scriptTypeIndex = reader.readInt16();
      if (scriptTypeIndex >= 0 || classId === 114) {
        reader.readBytes(16); // scriptId
      }
      reader.readBytes(16); // oldTypeHash
      let node = null;
      if (this.enableTypeTree) {
        node = parseTypeTreeBlob(reader, version);
      }
      const m_ClassName = reader.readCString();
      const m_NameSpace = reader.readCString();
      const m_AssemblyName = reader.readCString();
      this.refTypes.push({ m_ClassName, m_NameSpace, m_AssemblyName, node });
    }

    this.userInformation = reader.readCString();
  }

  static fromBytes(data, name = '') {
    return new SerializedFile(name, data);
  }

  getObject(pathId) {
    return this.objects.get(typeof pathId === 'bigint' ? pathId : BigInt(pathId));
  }

  getObjectReader(pathId) {
    return this.getObject(pathId);
  }
}

/* -------------------------------------------------------------------------- */
/* Asset environment                                                          */
/* -------------------------------------------------------------------------- */

function toBytes(value) {
  if (value === null || value === undefined) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  return new Uint8Array(0);
}

export function stripBundleSuffix(name) {
  return String(name).endsWith('.bundle') ? String(name).slice(0, -'.bundle'.length) : String(name);
}

/** Per-bundle asset container: named files plus parsed SerializedFiles. */
export class BundleContainer {
  constructor(name) {
    this.name = name;
    this.files = new Map();
    this.serializedFiles = [];
  }
}

export class BrowserAssetEnv {
  constructor(index = {}) {
    this.index = {
      bundles: Array.isArray(index.bundles) ? index.bundles : [],
      resources: Array.isArray(index.resources) ? index.resources : [],
      cabToBundle: index.cabToBundle && typeof index.cabToBundle === 'object' ? index.cabToBundle : {},
    };
    this.bundles = new Map();
    this.cabs = new Map();
    this.bundleNames = new Set();
    for (const entry of this.index.bundles) this.bundleNames.add(stripBundleSuffix(entry));
    this._inflight = new Map();
    this._isScope = false;
  }

  /** One request may reuse its scope for probing and building, never globally. */
  createScope() {
    if (this._isScope) return this;
    const scope = new BrowserAssetEnv(this.index);
    scope._isScope = true;
    return scope;
  }

  updateIndex(index = {}) {
    if (Array.isArray(index.bundles)) {
      this.index.bundles = index.bundles;
      for (const entry of index.bundles) this.bundleNames.add(stripBundleSuffix(entry));
    }
    if (Array.isArray(index.resources)) {
      this.index.resources = index.resources;
    }
    if (index.cabToBundle && typeof index.cabToBundle === 'object') {
      Object.assign(this.index.cabToBundle, index.cabToBundle);
    }
  }

  async refreshIndex() {
    const response = await fetch('/cache/index.json');
    if (response.ok) {
      this.updateIndex(await response.json());
    }
  }

  hasBundle(name) {
    return this.bundleNames.has(stripBundleSuffix(name));
  }

  bundleFile(name) {
    const direct = this.bundles.get(name) ?? this.bundles.get(name + '.bundle');
    if (direct) return direct;
    const wanted = stripBundleSuffix(name);
    for (const [key, container] of this.bundles) {
      if (stripBundleSuffix(key) === wanted) return container;
    }
    throw new Error(`bundle not loaded: ${name}`);
  }

  objectsOf(container, typeName) {
    if (container instanceof SerializedFile) {
      return [...container.objects.values()].filter((o) => o.typeName === typeName);
    }
    const out = [];
    for (const sf of container.serializedFiles) {
      for (const o of sf.objects.values()) {
        if (o.typeName === typeName) out.push(o);
      }
    }
    return out;
  }

  named(container, typeName, name) {
    for (const o of this.objectsOf(container, typeName)) {
      try {
        const obj = o.read();
        if (obj.m_Name === name) return obj;
      } catch {
        // ignore malformed objects, like the reference implementation
      }
    }
    throw new Error(name);
  }

  resolvePPtr(sf, pptr) {
    if (!pptr || pptr.m_PathID === undefined || pptr.m_PathID === null) return null;
    const pid = BigInt(pptr.m_PathID);
    if (pid === 0n) return null;
    if (!pptr.m_FileID || pptr.m_FileID === 0) {
      return sf.objects.get(pid) ?? null;
    }
    const ext = sf.externals[pptr.m_FileID - 1];
    if (!ext) return null;
    const cabName = ext.path.split('/').pop().toLowerCase();
    const target = this.cabs.get(cabName);
    return target instanceof SerializedFile ? (target.objects.get(pid) ?? null) : null;
  }

  readPPtr(sf, pptr) {
    const obj = this.resolvePPtr(sf, pptr);
    return obj ? obj.read() : null;
  }

  getResourceData(sf, streamData) {
    const size = Number(streamData?.size || 0);
    if (!streamData?.path || size <= 0) return new Uint8Array(0);
    const base = streamData.path.split('/').pop();
    const stem = base.replace(/\.[^.]+$/, '');
    const candidates = [base, `${stem}.resource`, `${stem}.assets.resS`, `${stem}.resS`];
    for (const candidate of candidates) {
      const buf = this.cabs.get(candidate.toLowerCase());
      if (buf instanceof Uint8Array) {
        const offset = Number(streamData.offset);
        return buf.subarray(offset, offset + size);
      }
    }
    return new Uint8Array(0);
  }

  /** Register one already-decrypted UnityFS bundle. */
  addBundle(bundleName, decryptedBytes) {
    const name = stripBundleSuffix(bundleName);
    const existing = this.bundles.get(name);
    if (existing) return existing;

    const unpacked = readUnityFS(decryptedBytes);
    const container = new BundleContainer(name);
    for (const [entryName, entryBytes] of unpacked) {
      let value;
      if (
        !entryName.endsWith('.resS') &&
        !entryName.endsWith('.resource') &&
        !entryName.endsWith('.config') &&
        !entryName.endsWith('.xml') &&
        !entryName.endsWith('.dat')
      ) {
        const sf = new SerializedFile(entryName, entryBytes);
        container.serializedFiles.push(sf);
        value = sf;
      } else {
        value = entryBytes;
      }
      container.files.set(entryName, value);
      this.cabs.set(entryName, value);
      this.cabs.set(entryName.toLowerCase(), value);
    }

    this.bundles.set(name, container);
    this.bundles.set(name + '.bundle', container);
    this.bundleNames.add(name);
    return container;
  }

  async _loadBundle(name) {
    const url = `/cache/bundles/${encodeURIComponent(name)}.bundle`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`failed to fetch bundle ${name}.bundle (HTTP ${response.status})`);
    }
    const raw = new Uint8Array(await response.arrayBuffer());
    return this.addBundle(name, decryptBundle(raw, name));
  }

  async _ensureDependencies(container) {
    const pending = new Map();
    for (const sf of container.serializedFiles) {
      for (const ext of sf.externals) {
        const base = ext.path.split('/').pop().toLowerCase();
        const depFile = this.index.cabToBundle[base];
        if (!depFile) continue;
        const depName = stripBundleSuffix(depFile);
        if (this.bundles.has(depName) || pending.has(depName)) continue;
        pending.set(depName, this.ensureBundle(depName, true));
      }
    }
    if (pending.size > 0) await Promise.all([...pending.values()]);
  }

  /**
   * Ensure a bundle is decrypted, parsed and (optionally) all of its external
   * CAB dependencies are loaded as well.
   */
  async ensureBundle(bundleName, withDeps = true) {
    const name = stripBundleSuffix(bundleName);
    const loaded = this.bundles.get(name);
    if (loaded) {
      if (withDeps) await this._ensureDependencies(loaded);
      return loaded;
    }

    let promise = this._inflight.get(name);
    if (!promise) {
      promise = this._loadBundle(name);
      this._inflight.set(name, promise);
      promise.then(
        () => { if (this._inflight.get(name) === promise) this._inflight.delete(name); },
        () => { if (this._inflight.get(name) === promise) this._inflight.delete(name); },
      );
    }
    const container = await promise;
    if (withDeps) await this._ensureDependencies(container);
    return container;
  }
}

let _envPromise = null;

/**
 * Initialize WASM + the shared asset index. Runtime builders create request-local
 * BrowserAssetEnv instances from this index so parsed bundles are not retained
 * here; lazy texture maps own those instances until upload completes.
 */
export async function getBrowserEnv() {
  if (!_envPromise) {
    _envPromise = (async () => {
      await initWasm();
      const response = await fetch('/cache/index.json');
      if (!response.ok) {
        throw new Error(`failed to fetch /cache/index.json (HTTP ${response.status})`);
      }
      const index = await response.json();
      return new BrowserAssetEnv(index);
    })().catch((error) => {
      _envPromise = null;
      throw error;
    });
  }
  return _envPromise;
}

export const get_browser_env = getBrowserEnv;

/* -------------------------------------------------------------------------- */
/* Skeletons                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Walk a Unity transform tree. `root` may be a `UnityObject` wrapper or the
 * plain typetree record returned by `UnityObject.read()` (which carries the
 * non-enumerable `_assetsFile` / `_pathId` back-references).
 */
export function skeleton(root, env) {
  const assets = env;
  const table = new Map();
  const goCache = new Map();

  const goInfo = (sf, pptr) => {
    const key = `${Number(pptr?.m_FileID ?? 0)}:${String(pptr?.m_PathID ?? 0)}`;
    const cached = goCache.get(key);
    if (cached) return cached;
    const goObj = assets.resolvePPtr(sf, pptr);
    let info;
    if (!goObj) {
      info = { name: '', active: true };
    } else {
      const g = goObj.read();
      info = {
        name: g.m_Name,
        active: g.m_IsActive === undefined ? true : !!g.m_IsActive,
      };
    }
    goCache.set(key, info);
    return info;
  };

  const build = (nodeOrObject, parent) => {
    let sf;
    let pid;
    let transform;
    if (nodeOrObject instanceof UnityObject) {
      sf = nodeOrObject.assetsFile;
      pid = nodeOrObject.pathId;
      transform = nodeOrObject.read();
    } else {
      transform = nodeOrObject;
      sf = transform._assetsFile;
      const rawPid = transform._pathId;
      pid = rawPid === undefined || rawPid === null ? 0n : BigInt(rawPid);
      if (!sf) throw new Error('skeleton: typetree record has no _assetsFile');
    }
    const goPtr = transform.m_GameObject;
    const info = goInfo(sf, goPtr);
    const node = {
      path_id: pid,
      go: goPtr && goPtr.m_PathID !== undefined && goPtr.m_PathID !== null
        ? BigInt(goPtr.m_PathID)
        : 0n,
      name: info.name,
      active: info.active,
      transform,
      assetsFile: sf,
      parent,
      children: [],
    };
    table.set(pid, node);
    for (const childPtr of transform.m_Children ?? []) {
      const childObj = assets.resolvePPtr(sf, childPtr);
      if (childObj) node.children.push(build(childObj, node));
    }
    return node;
  };

  return [build(root, null), table];
}

export function localTrs(t) {
  const p = t.m_LocalPosition ?? {};
  const q = t.m_LocalRotation ?? {};
  const s = t.m_LocalScale ?? {};
  return [
    [Number(p.x ?? 0), Number(p.y ?? 0), Number(p.z ?? 0)],
    [Number(q.x ?? 0), Number(q.y ?? 0), Number(q.z ?? 0), Number(q.w ?? 1)],
    [Number(s.x ?? 1), Number(s.y ?? 1), Number(s.z ?? 1)],
  ];
}

export const local_trs = localTrs;

/* -------------------------------------------------------------------------- */
/* Mesh decoding (Unity 2019+ vertex layouts)                                 */
/* -------------------------------------------------------------------------- */

const COMPONENT_BYTES = {
  0: 4, // Float32
  1: 2, // Float16
  2: 1, // UNorm8
  3: 1, // SNorm8
  4: 2, // UNorm16
  5: 2, // SNorm16
  6: 1, // UInt8
  7: 1, // SInt8
  8: 2, // UInt16
  9: 2, // SInt16
  10: 4, // UInt32
  11: 4, // SInt32
};

function componentSize(format) {
  const size = COMPONENT_BYTES[format];
  if (size === undefined) throw new Error(`unknown vertex format ${format}`);
  return size;
}

function halfToFloat(h) {
  const sign = h & 0x8000 ? -1 : 1;
  const exponent = (h >>> 10) & 0x1f;
  const fraction = h & 0x3ff;
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? NaN : sign * Infinity;
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

function componentReader(format) {
  switch (format) {
    case 0:
      return (dv, o) => dv.getFloat32(o, true);
    case 1:
      return (dv, o) => halfToFloat(dv.getUint16(o, true));
    case 2:
      return (dv, o) => dv.getUint8(o);
    case 3:
      return (dv, o) => dv.getInt8(o);
    case 4:
      return (dv, o) => dv.getUint16(o, true);
    case 5:
      return (dv, o) => dv.getInt16(o, true);
    case 6:
      return (dv, o) => dv.getUint8(o);
    case 7:
      return (dv, o) => dv.getInt8(o);
    case 8:
      return (dv, o) => dv.getUint16(o, true);
    case 9:
      return (dv, o) => dv.getInt16(o, true);
    case 10:
      return (dv, o) => dv.getUint32(o, true);
    case 11:
      return (dv, o) => dv.getInt32(o, true);
    default:
      throw new Error(`unknown vertex format ${format}`);
  }
}

function buildStreams(channels, vertexCount) {
  let streamCount = 1;
  for (const ch of channels) {
    streamCount = Math.max(streamCount, Number(ch.stream ?? 0) + 1);
  }
  const streams = [];
  let offset = 0;
  for (let s = 0; s < streamCount; s++) {
    let stride = 0;
    for (let chn = 0; chn < channels.length; chn++) {
      const ch = channels[chn];
      if (Number(ch.stream ?? 0) !== s) continue;
      const dimension = Number(ch.dimension ?? 0);
      if (dimension > 0) {
        stride += (dimension & 0xf) * componentSize(Number(ch.format ?? 0));
      }
    }
    streams.push({ offset, stride });
    offset += vertexCount * stride;
    offset = Math.ceil(offset / 16) * 16;
  }
  return streams;
}

function takePad(values, count) {
  const out = values.slice(0, count);
  while (out.length < count) out.push(0);
  return out;
}

function decodeIndices(raw, use16) {
  if (use16) {
    const count = raw.length >>> 1;
    const out = new Uint32Array(count);
    const dv = new DataView(raw.buffer, raw.byteOffset, count * 2);
    for (let i = 0; i < count; i++) out[i] = dv.getUint16(i * 2, true);
    return out;
  }
  const count = raw.length >>> 2;
  const out = new Uint32Array(count);
  const dv = new DataView(raw.buffer, raw.byteOffset, count * 4);
  for (let i = 0; i < count; i++) out[i] = dv.getUint32(i * 4, true);
  return out;
}

function getTriangles(indices, submeshes, use16) {
  if (indices === null) {
    if (submeshes.some((s) => Number(s.indexCount ?? 0) > 0)) {
      throw new Error('failed getting triangles: submeshes have indices but the mesh has none');
    }
    return submeshes.map(() => []);
  }

  return submeshes.map((sub) => {
    let firstIndex = Math.floor(Number(sub.firstByte ?? 0) / 2);
    if (!use16) firstIndex = Math.floor(firstIndex / 2);
    const indexCount = Number(sub.indexCount ?? 0);
    const topology = Number(sub.topology ?? 0);
    const triangles = [];

    if (topology === 0) {
      for (let i = firstIndex; i + 2 < firstIndex + indexCount; i += 3) {
        triangles.push([indices[i], indices[i + 1], indices[i + 2]]);
      }
    } else if (topology === 1) {
      // UnityPy MeshTopology.TriangleStrip (deprecated)
      for (let i = firstIndex; i < firstIndex + indexCount - 2; i++) {
        const a = indices[i];
        const b = indices[i + 1];
        const c = indices[i + 2];
        if (a === b || a === c || b === c) continue;
        // winding flip-flop of strips
        if ((i - firstIndex) & 1) triangles.push([b, a, c]);
        else triangles.push([a, b, c]);
      }
    } else if (topology === 2) {
      // UnityPy MeshTopology.Quads: one quad is two triangles
      for (let i = firstIndex; i < firstIndex + indexCount; i += 4) {
        const a = indices[i];
        const b = indices[i + 1];
        const c = indices[i + 2];
        const d = indices[i + 3];
        triangles.push([a, b, c]);
        triangles.push([a, c, d]);
      }
    } else {
      throw new Error('failed getting triangles: submesh topology is lines or points');
    }
    return triangles;
  });
}

export function meshData(meshObj, env) {
  const assets = env;
  let sf;
  let mesh;
  if (meshObj instanceof UnityObject) {
    sf = meshObj.assetsFile;
    mesh = meshObj.read();
  } else {
    mesh = meshObj;
    sf = mesh._assetsFile;
  }

  const vd = mesh.m_VertexData ?? {};
  const channels = vd.m_Channels ?? [];
  const vertexCount = Number(vd.m_VertexCount ?? 0);
  const streams = buildStreams(channels, vertexCount);

  let vertexBytes = toBytes(vd.m_DataSize);
  const streamData = mesh.m_StreamData;
  if (vertexBytes.length === 0 && streamData && streamData.path) {
    vertexBytes = assets.getResourceData(sf, streamData);
  }
  const dv = new DataView(vertexBytes.buffer, vertexBytes.byteOffset, vertexBytes.byteLength);

  let vertices = [];
  let normals = [];
  let tangents = [];
  let colors = [];
  let uv0 = [];
  let uv1 = [];
  let boneWeights = [];
  let boneIndices = [];

  if (vertexBytes.length > 0 && vertexCount > 0) {
    for (let chn = 0; chn < channels.length; chn++) {
      const channel = channels[chn];
      const dimension = Number(channel.dimension ?? 0);
      if (dimension === 0) continue;
      if (![0, 1, 2, 3, 4, 5, 12, 13].includes(chn)) continue;

      const stream = streams[Number(channel.stream ?? 0)];
      if (!stream || stream.stride === 0) continue;
      const dim = dimension & 0xf;
      const format = Number(channel.format ?? 0);
      const size = componentSize(format);
      const read = componentReader(format);
      const channelOffset = stream.offset + Number(channel.offset ?? 0);
      const rows = [];
      for (let v = 0; v < vertexCount; v++) {
        const base = channelOffset + v * stream.stride;
        const values = [];
        for (let c = 0; c < dim; c++) values.push(read(dv, base + c * size));
        rows.push(values);
      }
      if (chn === 0) vertices = rows.map((r) => takePad(r, 3));
      else if (chn === 1) normals = rows.map((r) => takePad(r, 3));
      else if (chn === 2) tangents = rows.map((r) => takePad(r, 4));
      else if (chn === 3) colors = rows.map((r) => takePad(r, 4));
      else if (chn === 4) uv0 = rows.map((r) => takePad(r, 2));
      else if (chn === 5) uv1 = rows.map((r) => takePad(r, 2));
      else if (chn === 12) boneWeights = rows.map((r) => takePad(r, 4));
      else if (chn === 13) boneIndices = rows.map((r) => takePad(r, 4));
    }
  }

  // Legacy skin data (pre-2018 meshes / meshes that keep m_Skin around).
  if ((boneWeights.length === 0 || boneIndices.length === 0) && Array.isArray(mesh.m_Skin)) {
    const skin = mesh.m_Skin;
    if (skin.length) {
      const pick = (row, base) => {
        const out = [];
        for (let i = 0; i < 4; i++) {
          out.push(Number(row[`${base}_${i}_`] ?? row[`${base}_${i}`] ?? 0));
        }
        return out;
      };
      boneIndices = skin.map((s) => pick(s, 'boneIndex'));
      boneWeights = skin.map((s) => pick(s, 'weight'));
    }
  }

  const rawIndex = toBytes(mesh.m_IndexBuffer);
  const use16 =
    mesh.m_Use16BitIndices !== undefined && mesh.m_Use16BitIndices !== null
      ? !!mesh.m_Use16BitIndices
      : Number(mesh.m_IndexFormat ?? 0) === 0;
  const indices = rawIndex.length > 0 ? decodeIndices(rawIndex, use16) : null;
  const submeshes = mesh.m_SubMeshes ?? [];
  const perSub = getTriangles(indices, submeshes, use16);

  const triangles = [];
  const subs = [];
  for (let si = 0; si < perSub.length; si++) {
    const sub = submeshes[si];
    const base = Number(sub.baseVertex || 0);
    const start = triangles.length;
    const list = perSub[si];
    for (const t of list) triangles.push([t[0] + base, t[1] + base, t[2] + base]);
    subs.push([start, list.length, Number(sub.topology ?? 0)]);
  }

  return {
    name: mesh.m_Name,
    vertices,
    normals,
    tangents,
    uv0,
    uv1,
    colors,
    triangles,
    submeshes: subs,
    index_format: mesh.m_IndexFormat,
    n_indices: triangles.length * 3,
    bones: boneIndices,
    weights: boneWeights,
    blendshape_names: Array.isArray(mesh.m_Shapes?.shapes)
      ? mesh.m_Shapes.shapes.map((s) => s.name)
      : [],
  };
}

export const mesh_data = meshData;

/* -------------------------------------------------------------------------- */
/* Minimal GLB writer                                                         */
/* -------------------------------------------------------------------------- */

export const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
export const FLOAT = 5126;
export const UINT = 5125;
export const USHORT = 5123;
export const UBYTE = 5121;
export const ARRAY_BUFFER = 34962;
export const ELEMENT_ARRAY_BUFFER = 34963;

function bytesOfFloats(values) {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) dv.setFloat32(i * 4, values[i], true);
  return out;
}

function bytesOfUint32(values) {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) dv.setUint32(i * 4, values[i], true);
  return out;
}

function bytesOfUint16(values) {
  const out = new Uint8Array(values.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) dv.setUint16(i * 2, values[i], true);
  return out;
}

export class Glb {
  constructor() {
    this.bin = new Uint8Array(1024);
    this.binLength = 0;
    this.json = {
      asset: { version: '2.0', generator: 'adv_viewer' },
      scene: 0,
      scenes: [{ nodes: [] }],
      nodes: [],
      meshes: [],
      materials: [],
      accessors: [],
      bufferViews: [],
      buffers: [{ byteLength: 0 }],
      textures: [],
      images: [],
      samplers: [],
      skins: [],
    };
  }

  ensure(extra) {
    const need = this.binLength + extra;
    if (need <= this.bin.length) return;
    let cap = this.bin.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.bin.subarray(0, this.binLength));
    this.bin = next;
  }

  append(data) {
    this.ensure(data.length);
    const off = this.binLength;
    this.bin.set(data, off);
    this.binLength += data.length;
    return off;
  }

  appendByte(value) {
    this.ensure(1);
    this.bin[this.binLength++] = value & 0xff;
  }

  align() {
    while (this.binLength % 4) this.appendByte(0);
  }

  view(data, target) {
    this.align();
    const off = this.append(data);
    const v = {
      buffer: 0,
      byteOffset: off,
      byteLength: data.length,
    };
    if (target) v.target = target;
    this.json.bufferViews.push(v);
    return this.json.bufferViews.length - 1;
  }

  accessor(view, componentType, count, type, minv, maxv, normalized) {
    const a = {
      bufferView: view,
      componentType,
      count,
      type,
    };
    if (minv !== undefined && minv !== null) a.min = Array.from(minv);
    if (maxv !== undefined && maxv !== null) a.max = Array.from(maxv);
    if (normalized) a.normalized = true;
    this.json.accessors.push(a);
    return this.json.accessors.length - 1;
  }

  floats(values, type) {
    const n = COMPONENTS[type];
    const v = this.view(bytesOfFloats(values), ARRAY_BUFFER);
    return this.accessor(v, FLOAT, values.length / n, type);
  }

  uints(values, type) {
    const n = COMPONENTS[type];
    const v = this.view(bytesOfUint32(values), ELEMENT_ARRAY_BUFFER);
    return this.accessor(v, UINT, values.length / n, type);
  }

  ushorts(values, type) {
    const n = COMPONENTS[type];
    const v = this.view(bytesOfUint16(values), ARRAY_BUFFER);
    return this.accessor(v, USHORT, values.length / n, type);
  }

  sparse_float_accessor(count, type, indices, values) {
    const n = COMPONENTS[type];
    const vIdx = this.view(bytesOfUint32(indices), ARRAY_BUFFER);
    this.accessor(vIdx, UINT, indices.length, 'SCALAR');
    const vVal = this.view(bytesOfFloats(values), ARRAY_BUFFER);
    this.accessor(vVal, FLOAT, values.length / n, type);
    this.json.accessors.push({
      componentType: FLOAT,
      count,
      type,
      sparse: {
        count: indices.length,
        indices: { bufferView: vIdx, componentType: UINT },
        values: { bufferView: vVal },
      },
    });
    return this.json.accessors.length - 1;
  }

  sparseFloatAccessor(count, type, indices, values) {
    return this.sparse_float_accessor(count, type, indices, values);
  }

  node(name, trs, parent, mesh, skin, weights) {
    const n = { name };
    if (trs !== undefined && trs !== null) {
      const t = trs[0];
      const r = trs[1];
      const s = trs[2];
      if (t[0] !== 0.0 || t[1] !== 0.0 || t[2] !== 0.0) {
        n.translation = [t[0], t[1], t[2]];
      }
      if (r[0] !== 0.0 || r[1] !== 0.0 || r[2] !== 0.0 || r[3] !== 1.0) {
        n.rotation = [r[0], r[1], r[2], r[3]];
      }
      if (s[0] !== 1.0 || s[1] !== 1.0 || s[2] !== 1.0) {
        n.scale = [s[0], s[1], s[2]];
      }
    }
    if (mesh !== undefined && mesh !== null) n.mesh = mesh;
    if (skin !== undefined && skin !== null) n.skin = skin;
    if (weights !== undefined && weights !== null) n.weights = [...weights];
    const idx = this.json.nodes.length;
    this.json.nodes.push(n);
    if (parent !== undefined && parent !== null) {
      const p = this.json.nodes[parent];
      if (!p.children) p.children = [];
      p.children.push(idx);
    } else {
      this.json.scenes[0].nodes.push(idx);
    }
    return idx;
  }

  image_uri(name, uri) {
    this.json.images.push({ name, uri });
    return this.json.images.length - 1;
  }

  imageUri(name, uri) {
    return this.image_uri(name, uri);
  }

  image_png(name, png) {
    const v = this.view(png);
    this.json.images.push({ name, mimeType: 'image/png', bufferView: v });
    return this.json.images.length - 1;
  }

  imagePng(name, png) {
    return this.image_png(name, png);
  }

  texture(image, sampler) {
    const t = { source: image };
    if (sampler !== undefined && sampler !== null) t.sampler = sampler;
    this.json.textures.push(t);
    return this.json.textures.length - 1;
  }

  sampler(wrapS = 10497, wrapT = 10497) {
    this.json.samplers.push({
      magFilter: 9729,
      minFilter: 9987,
      wrapS,
      wrapT,
    });
    return this.json.samplers.length - 1;
  }

  material(name, baseColorTexture, baseColor = [1.0, 1.0, 1.0, 1.0], doubleSided = true, alphaMode) {
    const pbr = {
      baseColorFactor: Array.from(baseColor),
      metallicFactor: 0.0,
      roughnessFactor: 1.0,
    };
    if (baseColorTexture !== undefined && baseColorTexture !== null) {
      pbr.baseColorTexture = { index: baseColorTexture };
    }
    const m = {
      name,
      pbrMetallicRoughness: pbr,
      doubleSided,
    };
    if (alphaMode) m.alphaMode = alphaMode;
    this.json.materials.push(m);
    return this.json.materials.length - 1;
  }

  primitive(attributes, indices, material, targets) {
    const p = { attributes, indices, mode: 4 };
    if (material !== undefined && material !== null) p.material = material;
    if (targets && targets.length) p.targets = targets;
    return p;
  }

  mesh(name, primitives, weights) {
    const m = { name, primitives };
    if (weights && weights.length) m.weights = [...weights];
    this.json.meshes.push(m);
    return this.json.meshes.length - 1;
  }

  skin(name, joints, ibms, skeletonNode) {
    const v = this.view(bytesOfFloats(ibms));
    const acc = this.accessor(v, FLOAT, joints.length, 'MAT4');
    const s = {
      name,
      joints: [...joints],
      inverseBindMatrices: acc,
    };
    if (skeletonNode !== undefined && skeletonNode !== null) s.skeleton = skeletonNode;
    this.json.skins.push(s);
    return this.json.skins.length - 1;
  }

  to_glb() {
    this.align();
    this.json.buffers[0].byteLength = this.binLength;

    const rawJs = new TextEncoder().encode(JSON.stringify(this.json));
    const jsLen = (rawJs.length + 3) & ~3;
    const js = new Uint8Array(jsLen);
    js.set(rawJs);
    js.fill(0x20, rawJs.length);
    const bin = this.bin.subarray(0, this.binLength);
    const total = 12 + 8 + js.length + 8 + bin.length;

    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    out[0] = 0x67; // g
    out[1] = 0x6c; // l
    out[2] = 0x54; // T
    out[3] = 0x46; // F
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);

    let off = 12;
    dv.setUint32(off, js.length, true);
    out[off + 4] = 0x4a; // J
    out[off + 5] = 0x53; // S
    out[off + 6] = 0x4f; // O
    out[off + 7] = 0x4e; // N
    out.set(js, off + 8);
    off += 8 + js.length;

    dv.setUint32(off, bin.length, true);
    out[off + 4] = 0x42; // B
    out[off + 5] = 0x49; // I
    out[off + 6] = 0x4e; // N
    out[off + 7] = 0x00;
    out.set(bin, off + 8);
    return out;
  }

  toGlb() {
    return this.to_glb();
  }
}

/* -------------------------------------------------------------------------- */
/* Animation clip decoding                                                    */
/* -------------------------------------------------------------------------- */

const TRANSFORM_DIM = { 1: 3, 2: 4, 3: 3, 4: 3 };
const scratch = new DataView(new ArrayBuffer(4));

function u32ToF32(u) {
  scratch.setUint32(0, u >>> 0, true);
  return scratch.getFloat32(0, true);
}

/** zlib-compatible CRC32 over the UTF-8 encoding of `s`. */
export function crc32(s) {
  const data = new TextEncoder().encode(s);
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function bindingDimension(b) {
  if (Number(b.typeID) === 4) {
    return TRANSFORM_DIM[Number(b.attribute)] ?? 1;
  }
  return 1;
}

export const binding_dimension = bindingDimension;

/** Return (slot -> [binding index, component]) plus total slot count. */
export function buildCurveMap(bindings) {
  const out = [];
  for (let bi = 0; bi < bindings.length; bi++) {
    const dim = bindingDimension(bindings[bi]);
    for (let d = 0; d < dim; d++) out.push([bi, d]);
  }
  return [out, out.length];
}

export const build_curve_map = buildCurveMap;

function asWords(data) {
  if (data instanceof Uint8Array) {
    const count = data.byteLength >>> 2;
    const words = new Uint32Array(count);
    const dv = new DataView(data.buffer, data.byteOffset, count * 4);
    for (let i = 0; i < count; i++) words[i] = dv.getUint32(i * 4, true);
    return words;
  }
  return data;
}

/** Sampler for a Unity StreamedClip. */
export class StreamedFrames {
  constructor(data, declaredCount = 0) {
    this.frames = [];
    this.declaredCount = Number(declaredCount || 0);
    if (!data) return;

    const words = asWords(data);
    const n = words.length;
    let i = 0;
    while (i + 1 < n) {
      const t = u32ToF32(words[i]);
      const count = words[i + 1] | 0;
      i += 2;
      if (count <= 0) continue;
      const keys = new Map();
      for (let k = 0; k < count; k++) {
        if (i + 5 > n) {
          i = n;
          break;
        }
        const idx = words[i] | 0;
        keys.set(idx, [
          u32ToF32(words[i + 1]),
          u32ToF32(words[i + 2]),
          u32ToF32(words[i + 3]),
          u32ToF32(words[i + 4]),
        ]);
        i += 5;
      }
      this.frames.push([t, keys]);
    }
  }

  curveCount() {
    if (this.declaredCount > 0) return this.declaredCount;
    let mx = -1;
    for (const [, keys] of this.frames) {
      for (const idx of keys.keys()) if (idx > mx) mx = idx;
    }
    return mx >= 0 ? mx + 1 : 0;
  }

  curve_count() {
    return this.curveCount();
  }

  evalKey(prev, u) {
    const [c0, c1, c2, val] = prev;
    if (!(Number.isFinite(c0) && Number.isFinite(c1) && Number.isFinite(c2))) {
      return val;
    }
    return val + u * (c2 + u * (c1 + u * c0));
  }

  sample(index, t) {
    let prev = null;
    let prevTime = 0.0;
    for (const [ft, keys] of this.frames) {
      const k = keys.get(index);
      if (k === undefined) continue;
      if (t < ft) {
        if (prev === null) return k[3];
        return this.evalKey(prev, t - prevTime);
      }
      prev = k;
      prevTime = ft;
    }
    if (prev === null) return 0.0;
    return prev[3];
  }
}

/** Random access sampler for one AnimationClip's curve slots. */
export class ClipSampler {
  constructor(clipObj, bindings, stopTime) {
    const data = clipObj?.m_MuscleClip?.m_Clip?.data ?? {};
    this.stopTime = stopTime;
    [this.curveMap, this.slotCount] = buildCurveMap(bindings ?? []);

    const sc = data.m_StreamedClip;
    const streamedData = sc?.data;
    const hasStreamed = !!streamedData && streamedData.length > 0;
    this.streamed = hasStreamed
      ? new StreamedFrames(streamedData, Number(sc?.curveCount ?? 0))
      : null;
    this.streamedCount = hasStreamed ? Number(sc?.curveCount ?? 0) : 0;

    const dense = data.m_DenseClip ?? {};
    this.denseCount = Number(dense.m_CurveCount ?? 0);
    if (this.denseCount) {
      this.denseSamples = Array.from(dense.m_SampleArray ?? []);
      this.denseFrames = Number(dense.m_FrameCount ?? 0);
      this.denseRate = Number(dense.m_SampleRate ?? 0) || 30.0;
      this.denseBegin = Number(dense.m_BeginTime ?? 0);
    } else {
      this.denseSamples = [];
      this.denseFrames = 0;
      this.denseRate = 30.0;
      this.denseBegin = 0.0;
    }

    this.constOffset = this.streamedCount + this.denseCount;
    this.constData = data.m_ConstantClip ? Array.from(data.m_ConstantClip.data ?? []) : [];
  }

  value(slot, t) {
    if (slot < this.streamedCount) {
      return this.streamed ? this.streamed.sample(slot, t) : 0.0;
    }
    if (slot < this.constOffset) {
      const fi = slot - this.streamedCount;
      if (this.denseFrames === 0) return 0.0;
      // Linear interpolation between dense samples.
      const f = (t - this.denseBegin) * this.denseRate;
      let i0 = Math.trunc(f);
      i0 = Math.max(0, Math.min(this.denseFrames - 1, i0));
      const i1 = Math.max(0, Math.min(this.denseFrames - 1, i0 + 1));
      const frac = Math.min(1.0, Math.max(0.0, f - i0));
      const n = this.denseCount;
      const a = this.denseSamples[i0 * n + fi];
      const b = this.denseSamples[i1 * n + fi];
      return a + (b - a) * frac;
    }
    const ci = slot - this.constOffset;
    if (ci < this.constData.length) return this.constData[ci];
    return 0.0;
  }

  sampleAll(times) {
    const out = [];
    for (const t of times) {
      const row = [];
      for (let slot = 0; slot < this.slotCount; slot++) row.push(this.value(slot, t));
      out.push(row);
    }
    return out;
  }

  sample_all(times) {
    return this.sampleAll(times);
  }
}

/* -------------------------------------------------------------------------- */
/* CRI .acb -> HCA streams                                                    */
/* -------------------------------------------------------------------------- */

/** @UTF rows are dynamic column-name -> value maps (numbers, strings, byte arrays). */
function alignUp(v, a) {
  return a > 1 ? Math.floor((v + a - 1) / a) * a : v;
}

export function parseUtf(buf, base = 0) {
  if (
    buf[base] !== 0x40 || buf[base + 1] !== 0x55
    || buf[base + 2] !== 0x54 || buf[base + 3] !== 0x46
  ) {
    throw new Error(`Expected @UTF magic at ${base}`);
  }
  const bufDv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tableSize = bufDv.getUint32(base + 4, false);
  const t = buf.subarray(base + 8, base + 8 + tableSize);
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const rowsOff = dv.getUint16(2, false);
  const strOff = dv.getUint32(4, false);
  const dataOff = dv.getUint32(8, false);
  const ncols = dv.getUint16(16, false);
  const rowWidth = dv.getUint16(18, false);
  const nrows = dv.getUint32(20, false);

  const cstr = (off) => {
    const p = strOff + off;
    let end = p;
    while (end < t.length && t[end] !== 0) end++;
    return end === -1 ? '' : utf8.decode(t.subarray(p, end));
  };

  const readVal = (p, ctype) => {
    switch (ctype) {
      case 0:
      case 1:
        return [t[p], p + 1];
      case 2:
      case 3:
        return [dv.getUint16(p, false), p + 2];
      case 4:
      case 5:
        return [dv.getUint32(p, false), p + 4];
      case 6:
      case 7:
        return [Number(dv.getBigUint64(p, false)), p + 8];
      case 8:
        return [dv.getFloat32(p, false), p + 4];
      case 9:
        return [dv.getFloat64(p, false), p + 8];
      case 10: {
        const so = dv.getUint32(p, false);
        const s0 = strOff + so;
        let s1 = s0;
        while (s1 < t.length && t[s1] !== 0) s1++;
        return [utf8.decode(t.subarray(s0, s1)), p + 4];
      }
      case 11: {
        const bo = dv.getUint32(p, false);
        const bl = dv.getUint32(p + 4, false);
        return [t.subarray(dataOff + bo, dataOff + bo + bl), p + 8];
      }
      default:
        throw new Error(`Unsupported @UTF column type ${ctype}`);
    }
  };

  const cols = [];
  let pos = 24;
  for (let ci = 0; ci < ncols; ci++) {
    let flags = t[pos];
    pos += 1;
    if (flags === 0) {
      flags = dv.getUint32(pos, false);
      pos += 4;
    }
    const cname = cstr(dv.getUint32(pos, false));
    pos += 4;
    const ctype = flags & 0x0f;
    const storage = flags & 0xf0;
    let constVal = null;
    if (storage === 0x30) {
      [constVal, pos] = readVal(pos, ctype);
    }
    cols.push([cname, ctype, storage, constVal]);
  }

  const rows = [];
  for (let r = 0; r < nrows; r++) {
    let rp = rowsOff + r * rowWidth;
    const row = {};
    for (const [cname, ctype, storage, constVal] of cols) {
      if (storage === 0x00 || storage === 0x10) {
        row[cname] = null;
      } else if (storage === 0x30) {
        row[cname] = constVal;
      } else if (storage === 0x50) {
        const [val, next] = readVal(rp, ctype);
        row[cname] = val;
        rp = next;
      }
    }
    rows.push(row);
  }
  return rows;
}

/** Return {cueName: raw_hca_bytes} from an embedded-AWB CRI .acb container. */
export function extractAcbHcaStreams(acbBytes) {
  const top = parseUtf(acbBytes, 0)[0];
  const cueNames = parseUtf(top.CueNameTable, 0);
  const cues = parseUtf(top.CueTable, 0);
  const synths = parseUtf(top.SynthTable, 0);
  const waves = parseUtf(top.WaveformTable, 0);

  let awb = top.AwbFile ?? null;
  if (!awb || awb.length === 0) {
    let afs2Pos = -1;
    for (let i = 0; i + 3 < acbBytes.length; i++) {
      if (
        acbBytes[i] === 0x41 && acbBytes[i + 1] === 0x46
        && acbBytes[i + 2] === 0x53 && acbBytes[i + 3] === 0x32
      ) {
        afs2Pos = i;
        break;
      }
    }
    if (afs2Pos < 0) throw new Error('No embedded AFS2 (AwbFile) found in .acb');
    awb = acbBytes.subarray(afs2Pos);
  }

  const magic = String.fromCharCode(awb[0], awb[1], awb[2], awb[3]);
  const adv = new DataView(awb.buffer, awb.byteOffset, awb.byteLength);
  const offSize = adv.getUint8(5);
  const idSize = adv.getUint16(6, true);
  const count = adv.getUint32(8, true);
  const align = adv.getUint16(12, true);
  if (magic !== 'AFS2') throw new Error(`Expected AFS2 header, got ${JSON.stringify(magic)}`);

  const idsPos = 16;
  const offsPos = idsPos + count * idSize;
  const readId = (p) => (idSize === 2 ? adv.getUint16(p, true) : adv.getUint32(p, true));
  const readOff = (p) => (offSize === 2 ? adv.getUint16(p, true) : adv.getUint32(p, true));

  const awbIds = [];
  for (let i = 0; i < count; i++) awbIds.push(readId(idsPos + i * idSize));
  const rawOffs = [];
  for (let i = 0; i <= count; i++) rawOffs.push(readOff(offsPos + i * offSize));

  const byAwbId = new Map();
  for (let i = 0; i < awbIds.length; i++) {
    const s = alignUp(rawOffs[i], align);
    const e = rawOffs[i + 1];
    byAwbId.set(awbIds[i], awb.subarray(s, e));
  }

  const out = new Map();
  for (const cn of cueNames) {
    const name = cn.CueName;
    const ci = cn.CueIndex;
    if (ci >= cues.length) continue;
    const c = cues[ci];
    const refIdx = c.ReferenceIndex;
    const refType = 'ReferenceType' in c ? c.ReferenceType : 2;
    let widx;
    if ((refType === 2 || refType === 3) && refIdx < synths.length) {
      const refItems = synths[refIdx].ReferenceItems ?? new Uint8Array(0);
      if (refItems.length >= 4) {
        const rdv = new DataView(refItems.buffer, refItems.byteOffset, refItems.byteLength);
        widx = rdv.getUint16(2, false);
      } else {
        continue;
      }
    } else if (refType === 1) {
      widx = refIdx;
    } else {
      continue;
    }
    if (widx >= waves.length) continue;
    const w = waves[widx];
    let awbId = w.MemoryAwbId ?? null;
    if (awbId === null) awbId = 'Id' in w ? w.Id : widx;
    const data = awbId === null ? undefined : byAwbId.get(awbId);
    if (data) out.set(name, data);
  }
  return out;
}

export default BrowserAssetEnv;
