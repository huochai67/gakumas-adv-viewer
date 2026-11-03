/**
 * Raw LZ4 block decompression (no frame header, no checksum).
 *
 * Unity asset bundles store LZ4/LZ4HC compressed blocks as bare blocks sized
 * by an out-of-band ``uncompressedSize``, so the standard frame-aware
 * libraries cannot be used directly.
 */
export function decompressLz4Block(src: Uint8Array, uncompressedSize: number): Uint8Array {
  const out = new Uint8Array(uncompressedSize);
  const srcLength = src.length;
  let ip = 0;
  let op = 0;

  while (ip < srcLength) {
    const token = src[ip++];

    // Literal run.
    let literalLength = token >>> 4;
    if (literalLength === 15) {
      let value: number;
      do {
        if (ip >= srcLength) throw new Error("LZ4: truncated literal length");
        value = src[ip++];
        literalLength += value;
      } while (value === 255);
    }

    if (ip + literalLength > srcLength) {
      throw new Error("LZ4: literal run exceeds source length");
    }
    if (op + literalLength > out.length) {
      throw new Error("LZ4: literal run exceeds output length");
    }
    out.set(src.subarray(ip, ip + literalLength), op);
    ip += literalLength;
    op += literalLength;

    // Last sequence has no match part.
    if (ip >= srcLength || op >= out.length) break;

    if (ip + 2 > srcLength) throw new Error("LZ4: truncated match offset");
    const offset = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    if (offset === 0 || offset > op) {
      throw new Error(`LZ4: invalid match offset ${offset} at output ${op}`);
    }

    let matchLength = (token & 0x0f) + 4;
    if ((token & 0x0f) === 15) {
      let value: number;
      do {
        if (ip >= srcLength) throw new Error("LZ4: truncated match length");
        value = src[ip++];
        matchLength += value;
      } while (value === 255);
    }
    if (op + matchLength > out.length) {
      throw new Error("LZ4: match run exceeds output length");
    }

    // Byte-by-byte to allow overlapping copies (offset < matchLength).
    let from = op - offset;
    for (let i = 0; i < matchLength; i++) {
      out[op++] = out[from++];
    }
  }

  return out;
}

export default decompressLz4Block;
