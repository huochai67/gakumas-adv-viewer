/**
 * Decryption for Octo/Gakumas asset bundles.
 *
 * Decompiled from Campus.Common.MaskedHeaderStream / MaskedHeaderStreamUtility:
 * only the first HeaderLength (0x100) bytes are XOR-masked. The mask is
 * derived from the bundle name:
 *
 *   size = 2 * len(name)
 *   b[2i] = name[i]            b[size-1-2i] = ~name[i]
 *   h = 0x9b; for each b: h = ror1(h) ^ b
 *   mask[i] = b[i] ^ h         (period size)
 *
 * Bundles already starting with a Unity signature are stored in plaintext.
 */

export const HEADER_SIZE = 0x100;

const UNITYF_SIGNATURE = new Uint8Array([0x55, 0x6e, 0x69, 0x74, 0x79, 0x46]); // "UnityF"
const UNITY_SIGNATURE = new Uint8Array([0x55, 0x6e, 0x69, 0x74, 0x79]); // "Unity"

export function maskForName(name: string): Uint8Array {
  const size = 2 * name.length;
  const b = new Uint8Array(size);
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i) & 0xff;
    b[2 * i] = c;
    b[size - 1 - 2 * i] = (~c) & 0xff;
  }
  let h = 0x9b;
  for (let i = 0; i < b.length; i++) {
    h = (((h >>> 1) | ((h & 1) << 7)) ^ b[i]) & 0xff;
  }
  const mask = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    mask[i] = b[i] ^ h;
  }
  return mask;
}

/** Snake-case alias kept for parity with the original Python pipeline. */
export const mask_for_name = maskForName;

export function isPlaintext(data: Uint8Array): boolean {
  if (data.length >= UNITYF_SIGNATURE.length) {
    let match = true;
    for (let i = 0; i < UNITYF_SIGNATURE.length; i++) {
      if (data[i] !== UNITYF_SIGNATURE[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  if (data.length >= UNITY_SIGNATURE.length) {
    for (let i = 0; i < UNITY_SIGNATURE.length; i++) {
      if (data[i] !== UNITY_SIGNATURE[i]) return false;
    }
    return true;
  }
  return false;
}

/** Snake-case alias kept for parity with the original Python pipeline. */
export const is_plaintext = isPlaintext;

export function decrypt(data: Uint8Array, bundleName: string): Uint8Array {
  if (isPlaintext(data)) return data;
  const mask = maskForName(bundleName);
  if (mask.length === 0) return data;
  const out = data.slice();
  const count = Math.min(HEADER_SIZE, out.length);
  for (let i = 0; i < count; i++) {
    out[i] ^= mask[i % mask.length];
  }
  return out;
}
