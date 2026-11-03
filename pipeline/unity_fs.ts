/**
 * UnityFS bundle container reader.
 *
 * Parses the big-endian UnityFS header, block info and directory nodes and
 * returns each contained file (usually a SerializedFile) keyed by its path.
 * Only the compression modes used by the Gakumas bundles are supported:
 * none (0) and LZ4/LZ4HC (2/3).
 */
import { decompressLz4Block } from "./lz4.ts";

const utf8 = new TextDecoder("utf-8");

class BigEndianReader {
  buf: Uint8Array;
  view: DataView;
  pos = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get length(): number {
    return this.buf.byteLength;
  }

  u8(): number {
    const value = this.view.getUint8(this.pos);
    this.pos += 1;
    return value;
  }

  u16(): number {
    const value = this.view.getUint16(this.pos, false);
    this.pos += 2;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.pos, false);
    this.pos += 4;
    return value;
  }

  i32(): number {
    const value = this.view.getInt32(this.pos, false);
    this.pos += 4;
    return value;
  }

  i64(): bigint {
    const value = this.view.getBigInt64(this.pos, false);
    this.pos += 8;
    return value;
  }

  cstring(): string {
    let end = this.buf.indexOf(0, this.pos);
    if (end === -1) end = this.buf.length;
    const value = utf8.decode(this.buf.subarray(this.pos, end));
    this.pos = end < this.buf.length ? end + 1 : end;
    return value;
  }
}

interface BlockInfo {
  uncompressedSize: number;
  compressedSize: number;
  flags: number;
}

interface DirectoryNode {
  offset: number;
  size: number;
  flags: number;
  path: string;
}

function decompressBlock(src: Uint8Array, uncompressedSize: number, compression: number): Uint8Array {
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

export function readUnityFS(buf: Uint8Array): Map<string, Uint8Array> {
  const reader = new BigEndianReader(buf);

  const signature = reader.cstring();
  if (signature !== "UnityFS") {
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

  let blocksInfoBytes: Uint8Array;
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

  const blocks: BlockInfo[] = new Array(blocksCount);
  for (let i = 0; i < blocksCount; i++) {
    blocks[i] = {
      uncompressedSize: infoReader.u32(),
      compressedSize: infoReader.u32(),
      flags: infoReader.u16(),
    };
  }

  const nodesCount = infoReader.i32();
  if (nodesCount < 0) throw new Error(`Invalid UnityFS node count ${nodesCount}`);

  const nodes: DirectoryNode[] = new Array(nodesCount);
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
    if (end > buf.length) throw new Error("UnityFS block data exceeds bundle size");
    const compressed = buf.subarray(reader.pos, end);
    reader.pos = end;

    const blockData = decompressBlock(compressed, block.uncompressedSize, block.flags);
    if (blockData.length < block.uncompressedSize) {
      throw new Error("UnityFS block decompressed to fewer bytes than expected");
    }
    combinedData.set(blockData.subarray(0, block.uncompressedSize), outOffset);
    outOffset += block.uncompressedSize;
  }

  const files = new Map<string, Uint8Array>();
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

/** Snake-case alias kept for parity with the original Python pipeline. */
export const read_unity_fs = readUnityFS;

export default readUnityFS;
