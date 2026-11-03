/**
 * Minimal, dependency-free Unity SerializedFile reader.
 *
 * Only the subset needed by the Gakumas ADV viewer is implemented, but that
 * subset covers the exact shape used by all bundles in `cache/bundles`:
 * format version 22, little-endian, with an embedded TypeTree blob for every
 * object. Path IDs are kept as `bigint` because they exceed 2^53.
 */
const utf8 = new TextDecoder("utf-8");
const ALIGN_FLAG = 0x4000;

/** Decoded TypeTree value: objects are field-name to value maps. */
export type UnityData = Record<string, unknown>;

/** Unity's 114-entry common string table used by TypeTree blobs. */
export const COMMON_STRINGS: Record<number, string> = {
  0: "AABB",
  5: "AnimationClip",
  19: "AnimationCurve",
  34: "AnimationState",
  49: "Array",
  55: "Base",
  60: "BitField",
  69: "bitset",
  76: "bool",
  81: "char",
  86: "ColorRGBA",
  96: "Component",
  106: "data",
  111: "deque",
  117: "double",
  124: "dynamic_array",
  138: "FastPropertyName",
  155: "first",
  161: "float",
  167: "Font",
  172: "GameObject",
  183: "Generic Mono",
  196: "GradientNEW",
  208: "GUID",
  213: "GUIStyle",
  222: "int",
  226: "list",
  231: "long long",
  241: "map",
  245: "Matrix4x4f",
  256: "MdFour",
  263: "MonoBehaviour",
  277: "MonoScript",
  288: "m_ByteSize",
  299: "m_Curve",
  307: "m_EditorClassIdentifier",
  331: "m_EditorHideFlags",
  349: "m_Enabled",
  359: "m_ExtensionPtr",
  374: "m_GameObject",
  387: "m_Index",
  395: "m_IsArray",
  405: "m_IsStatic",
  416: "m_MetaFlag",
  427: "m_Name",
  434: "m_ObjectHideFlags",
  452: "m_PrefabInternal",
  469: "m_PrefabParentObject",
  490: "m_Script",
  499: "m_StaticEditorFlags",
  519: "m_Type",
  526: "m_Version",
  536: "Object",
  543: "pair",
  548: "PPtr<Component>",
  564: "PPtr<GameObject>",
  581: "PPtr<Material>",
  596: "PPtr<MonoBehaviour>",
  616: "PPtr<MonoScript>",
  633: "PPtr<Object>",
  646: "PPtr<Prefab>",
  659: "PPtr<Sprite>",
  672: "PPtr<TextAsset>",
  688: "PPtr<Texture>",
  702: "PPtr<Texture2D>",
  718: "PPtr<Transform>",
  734: "Prefab",
  741: "Quaternionf",
  753: "Rectf",
  759: "RectInt",
  767: "RectOffset",
  778: "second",
  785: "set",
  789: "short",
  795: "size",
  800: "SInt16",
  807: "SInt32",
  814: "SInt64",
  821: "SInt8",
  827: "staticvector",
  840: "string",
  847: "TextAsset",
  857: "TextMesh",
  866: "Texture",
  874: "Texture2D",
  884: "Transform",
  894: "TypelessData",
  907: "UInt16",
  914: "UInt32",
  921: "UInt64",
  928: "UInt8",
  934: "unsigned int",
  947: "unsigned long long",
  966: "unsigned short",
  981: "vector",
  988: "Vector2f",
  997: "Vector3f",
  1006: "Vector4f",
  1015: "m_ScriptingClassIdentifier",
  1042: "Gradient",
  1051: "Type*",
  1057: "int2_storage",
  1070: "int3_storage",
  1083: "BoundsInt",
  1093: "m_CorrespondingSourceObject",
  1121: "m_PrefabInstance",
  1138: "m_PrefabAsset",
  1152: "FileSize",
  1161: "Hash128",
  1169: "RenderingLayerMask",
  1188: "fixed_array",
  1200: "EntityId",
  1209: "LoadableObjectId",
  1226: "LoadableSceneId",
};

export interface TypeTreeNode {
  m_Version: number;
  m_Level: number;
  m_TypeFlags: number;
  m_TypeStrOffset: number;
  m_NameStrOffset: number;
  m_ByteSize: number;
  m_Index: number;
  m_MetaFlag: number;
  m_RefTypeHash: bigint;
  m_Type: string;
  m_Name: string;
  m_Children: TypeTreeNode[];
}

export class BinaryReader {
  buf: Uint8Array;
  view: DataView;
  pos: number;
  littleEndian: boolean;

  constructor(buf: Uint8Array, littleEndian = true, pos = 0) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = pos;
    this.littleEndian = littleEndian;
  }

  get length(): number {
    return this.buf.byteLength;
  }

  get remaining(): number {
    return this.buf.byteLength - this.pos;
  }

  align(n = 4): void {
    const rem = this.pos % n;
    if (rem !== 0) this.pos += n - rem;
  }

  skip(n: number): void {
    this.pos += n;
  }

  readInt8(): number {
    const value = this.view.getInt8(this.pos);
    this.pos += 1;
    return value;
  }

  readUint8(): number {
    const value = this.view.getUint8(this.pos);
    this.pos += 1;
    return value;
  }

  readInt16(): number {
    const value = this.view.getInt16(this.pos, this.littleEndian);
    this.pos += 2;
    return value;
  }

  readUint16(): number {
    const value = this.view.getUint16(this.pos, this.littleEndian);
    this.pos += 2;
    return value;
  }

  readInt32(): number {
    const value = this.view.getInt32(this.pos, this.littleEndian);
    this.pos += 4;
    return value;
  }

  readUint32(): number {
    const value = this.view.getUint32(this.pos, this.littleEndian);
    this.pos += 4;
    return value;
  }

  readInt64(): bigint {
    const value = this.view.getBigInt64(this.pos, this.littleEndian);
    this.pos += 8;
    return value;
  }

  readUint64(): bigint {
    const value = this.view.getBigUint64(this.pos, this.littleEndian);
    this.pos += 8;
    return value;
  }

  readFloat32(): number {
    const value = this.view.getFloat32(this.pos, this.littleEndian);
    this.pos += 4;
    return value;
  }

  readFloat64(): number {
    const value = this.view.getFloat64(this.pos, this.littleEndian);
    this.pos += 8;
    return value;
  }

  readBoolean(): boolean {
    return this.readUint8() !== 0;
  }

  readBytes(n: number): Uint8Array {
    if (n < 0) throw new RangeError(`Cannot read ${n} bytes`);
    const end = this.pos + n;
    if (end > this.buf.byteLength) {
      throw new RangeError(`Read of ${n} bytes at ${this.pos} exceeds ${this.buf.byteLength}`);
    }
    const value = this.buf.subarray(this.pos, end);
    this.pos = end;
    return value;
  }

  readCString(): string {
    let end = this.buf.indexOf(0, this.pos);
    if (end === -1) end = this.buf.byteLength;
    const value = utf8.decode(this.buf.subarray(this.pos, end));
    this.pos = end < this.buf.byteLength ? end + 1 : end;
    return value;
  }

  readAlignedString(): string {
    const length = this.readInt32();
    if (length > 0 && length <= this.buf.byteLength - this.pos) {
      const value = utf8.decode(this.buf.subarray(this.pos, this.pos + length));
      this.pos += length;
      this.align(4);
      return value;
    }
    this.align(4);
    return "";
  }

  readByteArray(): Uint8Array {
    const length = this.readInt32();
    if (length <= 0) return new Uint8Array(0);
    return this.readBytes(length);
  }

  readInt32Array(): Int32Array {
    const length = this.readInt32();
    const values = new Int32Array(length);
    for (let i = 0; i < length; i++) values[i] = this.readInt32();
    return values;
  }
}

function decodeTypeTreeStrings(stringBuffer: Uint8Array): Map<number, string> {
  const strings = new Map<number, string>();
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
export function parseTypeTreeBlob(reader: BinaryReader, version: number): TypeTreeNode {
  if (version >= 23) {
    const magic = utf8.decode(reader.readBytes(4));
    if (magic !== "mhtt") {
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
    throw new Error("Invalid type tree blob header");
  }

  interface RawNode {
    m_Version: number;
    m_Level: number;
    m_TypeFlags: number;
    m_TypeStrOffset: number;
    m_NameStrOffset: number;
    m_ByteSize: number;
    m_Index: number;
    m_MetaFlag: number;
    m_RefTypeHash: bigint;
  }

  const rawNodes: RawNode[] = new Array(nodeCount);
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

  const resolveString = (offset: number): string => {
    if ((offset & 0x80000000) === 0) {
      return strings.get(offset) ?? "";
    }
    const common = offset & 0x7fffffff;
    return COMMON_STRINGS[common] ?? String(common);
  };

  const fakeRoot: TypeTreeNode = {
    m_Version: 0,
    m_Level: -1,
    m_TypeFlags: 0,
    m_TypeStrOffset: 0,
    m_NameStrOffset: 0,
    m_ByteSize: 0,
    m_Index: 0,
    m_MetaFlag: 0,
    m_RefTypeHash: 0n,
    m_Type: "",
    m_Name: "",
    m_Children: [],
  };

  const stack: TypeTreeNode[] = [fakeRoot];
  let parent = fakeRoot;
  let prev = fakeRoot;

  for (const raw of rawNodes) {
    const node: TypeTreeNode = {
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
        parent = stack.pop() as TypeTreeNode;
      }
    }
    parent.m_Children.push(node);
    prev = node;
  }

  const root = fakeRoot.m_Children[0];
  if (!root) throw new Error("Type tree blob contains no nodes");
  return root;
}

function typeInfoString(typeInfo: unknown, key: string): string {
  if (typeInfo === null || typeof typeInfo !== "object") return "";
  const value = (typeInfo as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function getReferencedTypeNode(value: UnityData, assetsFile?: SerializedFile | null): TypeTreeNode | null {
  const typeInfo = value.type;
  const className = typeInfoString(typeInfo, "class");
  const nameSpace = typeInfoString(typeInfo, "ns");
  const assemblyName = typeInfoString(typeInfo, "asm");
  if (!className) return null;
  const refTypes = assetsFile?.refTypes;
  if (!refTypes || refTypes.length === 0) {
    throw new Error("SerializedFile has no ref_types for ReferencedObjectData");
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
export function readTypeTree(
  node: TypeTreeNode,
  reader: BinaryReader,
  assetsFile?: SerializedFile | null,
  suppressAlign = false,
): unknown {
  let align = (node.m_MetaFlag & ALIGN_FLAG) !== 0;
  let value: unknown;

  switch (node.m_Type) {
    case "SInt8":
      value = reader.readInt8();
      break;
    case "UInt8":
    case "char":
      value = reader.readUint8();
      break;
    case "short":
    case "SInt16":
      value = reader.readInt16();
      break;
    case "unsigned short":
    case "UInt16":
      value = reader.readUint16();
      break;
    case "int":
    case "SInt32":
      value = reader.readInt32();
      break;
    case "unsigned int":
    case "UInt32":
    case "Type*":
      value = reader.readUint32();
      break;
    case "long long":
    case "SInt64":
      value = reader.readInt64();
      break;
    case "unsigned long long":
    case "UInt64":
    case "FileSize":
      value = reader.readUint64();
      break;
    case "float":
      value = reader.readFloat32();
      break;
    case "double":
      value = reader.readFloat64();
      break;
    case "bool":
      value = reader.readBoolean();
      break;
    case "string":
      value = reader.readAlignedString();
      break;
    case "TypelessData":
      value = reader.readByteArray();
      break;
    case "pair":
      value = [
        readTypeTree(node.m_Children[0], reader, assetsFile),
        readTypeTree(node.m_Children[1], reader, assetsFile),
      ];
      break;
    case "ReferencedObject": {
      const object: UnityData = {};
      for (const child of node.m_Children) {
        if (child.m_Type === "ReferencedObjectData") {
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
      if (node.m_Children.length > 0 && node.m_Children[0].m_Type === "Array") {
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
        if (subtype.m_Type === "UInt8" || subtype.m_Type === "char") {
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
        const object: UnityData = {};
        let hasManagedReferencesRegistry = false;
        for (const child of node.m_Children) {
          if (child.m_Type === "ManagedReferencesRegistry") {
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

/** Snake-case alias kept for parity with the original Python pipeline. */
export const read_type_tree = readTypeTree;

export interface SerializedFileHeader {
  metadataSize: number;
  fileSize: number;
  version: number;
  dataOffset: number;
  endian: "<" | ">";
  reserved: Uint8Array;
}

export interface SerializedType {
  classId: number;
  isStrippedType: boolean;
  scriptTypeIndex: number;
  scriptId: Uint8Array | null;
  oldTypeHash: Uint8Array;
  node: TypeTreeNode | null;
  typeDependencies?: Int32Array;
  m_ClassName?: string;
  m_NameSpace?: string;
  m_AssemblyName?: string;
}

export interface ExternalReference {
  path: string;
  guid: Uint8Array;
  type: number;
  tempEmpty?: string;
}

export interface RefType {
  m_ClassName: string;
  m_NameSpace: string;
  m_AssemblyName: string;
  node: TypeTreeNode | null;
}

export class UnityObject {
  readonly pathId: bigint;
  readonly typeId: number;
  readonly classId: number;
  readonly typeName: string;
  readonly byteStart: number;
  readonly byteSize: number;
  readonly assetsFile: SerializedFile;

  private _cache: UnityData | null = null;
  private _node: TypeTreeNode | null;

  constructor(
    assetsFile: SerializedFile,
    pathId: bigint,
    typeId: number,
    byteStart: number,
    byteSize: number,
  ) {
    this.assetsFile = assetsFile;
    this.pathId = pathId;
    this.typeId = typeId;
    this.byteStart = byteStart;
    this.byteSize = byteSize;

    const serializedType = assetsFile.types[typeId];
    this.classId = serializedType ? serializedType.classId : -1;
    this._node = serializedType ? serializedType.node : null;
    this.typeName = this._node ? this._node.m_Type : `Class${this.classId}`;
  }

  get path_id(): bigint {
    return this.pathId;
  }

  get node(): TypeTreeNode | null {
    return this._node;
  }

  read(): UnityData {
    if (this._cache !== null) return this._cache;
    if (!this._node) {
      throw new Error(`Object ${this.pathId} (type ${this.typeName}) has no embedded TypeTree`);
    }
    const reader = new BinaryReader(this.assetsFile.data, this.assetsFile.littleEndian, this.byteStart);
    const value = readTypeTree(this._node, reader, this.assetsFile);
    if (value !== null && typeof value === "object") {
      Object.defineProperty(value, "_assetsFile", {
        value: this.assetsFile,
        enumerable: false,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(value, "_pathId", {
        value: this.pathId,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    // Every serialized asset root node is a class/struct, so this cast is safe.
    this._cache = value as UnityData;
    return this._cache;
  }

  read_typetree(): UnityData {
    return this.read();
  }

  readTypetree(): UnityData {
    return this.read();
  }
}

export class SerializedFile {
  name: string;
  data: Uint8Array;
  header: SerializedFileHeader;
  version: number;
  littleEndian: boolean;
  unityVersion = "";
  targetPlatform = 0;
  enableTypeTree = false;
  types: SerializedType[] = [];
  objects = new Map<bigint, UnityObject>();
  externals: ExternalReference[] = [];
  refTypes: RefType[] = [];
  userInformation = "";

  constructor(name: string, data: Uint8Array);
  constructor(data: Uint8Array, name?: string);
  constructor(nameOrData: string | Uint8Array, dataOrName?: string | Uint8Array) {
    let name: string;
    let data: Uint8Array;
    if (typeof nameOrData === "string") {
      name = nameOrData;
      if (!(dataOrName instanceof Uint8Array)) {
        throw new TypeError("SerializedFile requires a Uint8Array of file data");
      }
      data = dataOrName;
    } else {
      data = nameOrData;
      name = typeof dataOrName === "string" ? dataOrName : "";
    }
    this.name = name;
    this.data = data;

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
      endian: endianByte === 0 ? "<" : ">",
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
      let node: TypeTreeNode | null = null;
      let typeDependencies: Int32Array | undefined;
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
      let node: TypeTreeNode | null = null;
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

  static fromBytes(data: Uint8Array, name = ""): SerializedFile {
    return new SerializedFile(name, data);
  }

  getObject(pathId: bigint | number): UnityObject | undefined {
    return this.objects.get(typeof pathId === "bigint" ? pathId : BigInt(pathId));
  }

  getObjectReader(pathId: bigint | number): UnityObject | undefined {
    return this.getObject(pathId);
  }
}

export default SerializedFile;
