"""Decryption for Octo/Gakumas asset bundles.

Decompiled from Campus.Common.MaskedHeaderStream / MaskedHeaderStreamUtility:
only the first ``HeaderLength`` (0x100) bytes are XOR-masked.  The mask is
derived from the bundle name:

  size = 2 * len(name)
  b[2i] = name[i]            b[size-1-2i] = ~name[i]
  h = 0x9b; for each b: h = ror1(h) ^ b
  mask[i] = b[i] ^ h         (period size)

Bundles already starting with a Unity signature are stored in plaintext.
"""

HEADER_SIZE = 0x100


def mask_for_name(name: str) -> bytes:
    size = 2 * len(name)
    b = bytearray(size)
    for i, ch in enumerate(name):
        b[2 * i] = ord(ch)
        b[size - 1 - 2 * i] = (~ord(ch)) & 0xFF
    h = 0x9B
    for v in b:
        h = ((h >> 1) | ((h & 1) << 7)) ^ v
    return bytes(v ^ h for v in b)


def is_plaintext(data: bytes) -> bool:
    return data[:6] == b"UnityF" or data[:5] == b"Unity"


def decrypt(data: bytes, bundle_name: str) -> bytes:
    if is_plaintext(data):
        return data
    mask = mask_for_name(bundle_name)
    head = bytearray(data[:HEADER_SIZE])
    for i in range(min(HEADER_SIZE, len(head))):
        head[i] ^= mask[i % len(mask)]
    return bytes(head) + data[HEADER_SIZE:]
