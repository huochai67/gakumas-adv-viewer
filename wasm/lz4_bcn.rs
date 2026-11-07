//! Standalone (no external crates) ports of the Gakumas asset primitives that
//! the browser needs: Octo bundle header unmasking, raw LZ4 block
//! decompression and Unity `Texture2D` decoding into 8-bit RGBA.
//!
//! The texture decoders are a line-for-line port of `pipeline/bcn_png.ts`
//! (itself ported from the Khronos/D3D BPTC reference behaviour of bcdec), so
//! that in-browser output is bit-identical to the offline pipeline.

/* ------------------------------------------------------------------------- */
/* Octo / Campus.Common.MaskedHeaderStream                                   */
/* ------------------------------------------------------------------------- */

/// Number of leading bytes that are XOR-masked in an encrypted bundle.
pub const HEADER_SIZE: usize = 0x100;

const UNITYF_SIGNATURE: &[u8] = b"UnityF";
const UNITY_SIGNATURE: &[u8] = b"Unity";

/// Bundles already starting with a Unity signature are stored in plaintext.
pub fn is_plaintext(data: &[u8]) -> bool {
    if data.len() >= UNITYF_SIGNATURE.len() && &data[..UNITYF_SIGNATURE.len()] == UNITYF_SIGNATURE {
        return true;
    }
    if data.len() >= UNITY_SIGNATURE.len() {
        return &data[..UNITY_SIGNATURE.len()] == UNITY_SIGNATURE;
    }
    false
}

/// Derive the repeating XOR mask from the bundle name:
///
/// ```text
/// size      = 2 * len(name)
/// b[2i]     = name[i]            b[size-1-2i] = ~name[i]
/// h         = 0x9b; for each b:  h = ror1(h) ^ b
/// mask[i]   = b[i] ^ h
/// ```
pub fn mask_for_name(name: &[u8]) -> Vec<u8> {
    let size = 2 * name.len();
    if size == 0 {
        return Vec::new();
    }
    let mut b = vec![0u8; size];
    for (i, &raw) in name.iter().enumerate() {
        let c = raw;
        b[2 * i] = c;
        b[size - 1 - 2 * i] = !c;
    }
    let mut h: u8 = 0x9b;
    for &byte in b.iter() {
        h = (h.rotate_right(1)) ^ byte;
    }
    let mut mask = vec![0u8; size];
    for i in 0..size {
        mask[i] = b[i] ^ h;
    }
    mask
}

/// Remove the Octo header mask in place (first `HEADER_SIZE` bytes only).
pub fn decrypt_bundle_in_place(data: &mut [u8], name: &[u8]) {
    if is_plaintext(data) {
        return;
    }
    let mask = mask_for_name(name);
    if mask.is_empty() {
        return;
    }
    let count = HEADER_SIZE.min(data.len());
    for i in 0..count {
        data[i] ^= mask[i % mask.len()];
    }
}

/* ------------------------------------------------------------------------- */
/* Raw LZ4 block decompression                                               */
/* ------------------------------------------------------------------------- */

/// Decompress a bare LZ4 block (no frame header / checksum).
///
/// Returns the number of bytes written to `dst`, or a negative error code.
pub fn lz4_decompress_block(src: &[u8], dst: &mut [u8]) -> i32 {
    let src_len = src.len();
    let mut ip = 0usize;
    let mut op = 0usize;

    while ip < src_len {
        let token = src[ip];
        ip += 1;

        // Literal run.
        let mut literal_len = (token >> 4) as usize;
        if literal_len == 15 {
            loop {
                if ip >= src_len {
                    return -1; // truncated literal length
                }
                let value = src[ip] as usize;
                ip += 1;
                literal_len += value;
                if value != 255 {
                    break;
                }
            }
        }

        if literal_len > src_len - ip {
            return -2; // literal run exceeds source length
        }
        if literal_len > dst.len() - op {
            return -3; // literal run exceeds output length
        }
        dst[op..op + literal_len].copy_from_slice(&src[ip..ip + literal_len]);
        ip += literal_len;
        op += literal_len;

        // The last sequence has no match part.
        if ip >= src_len || op >= dst.len() {
            break;
        }

        if src_len - ip < 2 {
            return -4; // truncated match offset
        }
        let offset = (src[ip] as usize) | ((src[ip + 1] as usize) << 8);
        ip += 2;
        if offset == 0 || offset > op {
            return -5; // invalid match offset
        }

        let mut match_len = (token & 0x0f) as usize + 4;
        if (token & 0x0f) == 15 {
            loop {
                if ip >= src_len {
                    return -6; // truncated match length
                }
                let value = src[ip] as usize;
                ip += 1;
                match_len += value;
                if value != 255 {
                    break;
                }
            }
        }
        if match_len > dst.len() - op {
            return -7; // match run exceeds output length
        }

        // Byte-by-byte so overlapping copies (offset < match_len) behave.
        let mut from = op - offset;
        for _ in 0..match_len {
            dst[op] = dst[from];
            op += 1;
            from += 1;
        }
    }

    op as i32
}

/* ------------------------------------------------------------------------- */
/* Shared BC6H / BC7 tables                                                   */
/* ------------------------------------------------------------------------- */

const PART2: [u32; 64] = [
    1347440720, 1077952576, 1414812756, 1414549568, 1346387968, 1431589968, 1431588928, 1414545408,
    1346371584, 1431655504, 1431584768, 1413480448, 1431655488, 1431633920, 1431655680, 1426063360,
    1427439872, 16468, 352387072, 4214868, 16464, 352649472, 83951616, 1079005268,
    4210768, 83951872, 336860180, 85202000, 18175040, 5592320, 352403540, 88162640,
    1145324612, 1426085120, 289673540, 84234320, 89130320, 286344260, 1091846420, 1141969220,
    352669780, 17125440, 84152400, 88428880, 339820820, 1342506320, 1094784020, 1315840,
    267524, 1070096, 273944576, 68486144, 1346438420, 1090851920, 88166420, 335888720,
    1090848020, 1095782420, 1073812820, 1410662720, 1347441920, 5591120, 353701904, 1414792196,
];

const PART3: [u32; 64] = [
    2858963024, 1784303680, 1515864576, 1414570152, 2779054080, 2694860880, 1431675040, 1515868240,
    2857697280, 2857719040, 2863289600, 2425393296, 2492765332, 2762253476, 2846200912, 705315408,
    2777960512, 172118100, 2779096320, 1436590240, 2829603924, 1785348160, 2762231808, 437912832,
    5285028, 2862977168, 342452500, 1768494080, 2693105056, 2860651540, 1352967248, 1784283648,
    2846195712, 1351655592, 2829094992, 606348324, 11162880, 613566756, 608801316, 1352993360,
    1342874960, 2863285316, 1717960704, 2778768800, 1352683680, 1764256040, 1152035396, 1717986816,
    2856600644, 1420317864, 2508232064, 2526451200, 2824098984, 2157286784, 2853442580, 2526412800,
    2863272980, 2689618080, 2695210400, 2516582400, 1082146944, 2846402984, 2863311428, 709513812,
];

const ANCHOR2: [usize; 64] = [
    15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15,
    15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2,
    15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6,
    6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15,
];

const ANCHOR3_1: [usize; 64] = [
    3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3,
    3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15,
    8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15,
    3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3,
];

const ANCHOR3_2: [usize; 64] = [
    15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8,
    15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8,
    15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8,
    15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8,
];

const W2: [i32; 4] = [0, 21, 43, 64];
const W3: [i32; 8] = [0, 9, 18, 27, 37, 46, 55, 64];
const W4: [i32; 16] = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

/* ------------------------------------------------------------------------- */
/* Bit reader (LSB-first, as used by BC6H & BC7)                             */
/* ------------------------------------------------------------------------- */

struct BitReader<'a> {
    data: &'a [u8],
    byte_pos: usize,
    acc: u32,
    nbits: u32,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        BitReader { data, byte_pos: 0, acc: 0, nbits: 0 }
    }

    fn read_bits(&mut self, count: u32) -> u32 {
        if count == 0 {
            return 0;
        }
        while self.nbits < count {
            let byte = if self.byte_pos < self.data.len() { self.data[self.byte_pos] } else { 0 };
            self.byte_pos += 1;
            self.acc |= (byte as u32) << self.nbits;
            self.nbits += 8;
        }
        let mask: u32 = if count >= 32 { 0xffff_ffff } else { (1u32 << count) - 1 };
        let value = self.acc & mask;
        self.acc >>= count;
        self.nbits -= count;
        value
    }

    fn read_bit(&mut self) -> u32 {
        self.read_bits(1)
    }

    /// Read `count` bits and reverse their order (BC6H modes 13/14).
    fn read_bits_reversed(&mut self, count: u32) -> u32 {
        let mut value = self.read_bits(count);
        let mut result = 0u32;
        for _ in 0..count {
            result = (result << 1) | (value & 1);
            value >>= 1;
        }
        result
    }
}

/* ------------------------------------------------------------------------- */
/* BC1 (DXT1) / BC3 (DXT5)                                                   */
/* ------------------------------------------------------------------------- */

fn get_u16(data: &[u8], offset: usize) -> u32 {
    let lo = if offset < data.len() { data[offset] } else { 0 } as u32;
    let hi = if offset + 1 < data.len() { data[offset + 1] } else { 0 } as u32;
    lo | (hi << 8)
}

fn get_u32(data: &[u8], offset: usize) -> u32 {
    let mut value = 0u32;
    for i in 0..4 {
        let byte = if offset + i < data.len() { data[offset + i] } else { 0 } as u32;
        value |= byte << (8 * i);
    }
    value
}

fn expand565(color: u32, out: &mut [u8; 16], at: usize) {
    let r5 = (color >> 11) & 0x1f;
    let g6 = (color >> 5) & 0x3f;
    let b5 = color & 0x1f;
    out[at] = ((r5 << 3) | (r5 >> 2)) as u8;
    out[at + 1] = ((g6 << 2) | (g6 >> 4)) as u8;
    out[at + 2] = ((b5 << 3) | (b5 >> 2)) as u8;
    out[at + 3] = 255;
}

/// Decode an 8-byte BC1 colour block (also the colour half of BC3).
fn decode_color_block(data: &[u8], offset: usize, out: &mut [u8; 64]) {
    let c0 = get_u16(data, offset);
    let c1 = get_u16(data, offset + 2);

    let mut ref_colors = [0u8; 16];
    expand565(c0, &mut ref_colors, 0);
    expand565(c1, &mut ref_colors, 4);

    if c0 > c1 {
        for ch in 0..3 {
            ref_colors[8 + ch] =
                ((2 * ref_colors[ch] as u32 + ref_colors[4 + ch] as u32) / 3) as u8;
            ref_colors[12 + ch] =
                ((ref_colors[ch] as u32 + 2 * ref_colors[4 + ch] as u32) / 3) as u8;
        }
    } else {
        for ch in 0..3 {
            ref_colors[8 + ch] =
                ((ref_colors[ch] as u32 + ref_colors[4 + ch] as u32) / 2) as u8;
            ref_colors[12 + ch] = 0;
        }
    }
    ref_colors[11] = 255;
    ref_colors[15] = 255;

    let indices = get_u32(data, offset + 4);
    for i in 0..16 {
        let idx = ((indices >> (i * 2)) & 3) as usize;
        let src = idx * 4;
        let dst = i * 4;
        out[dst] = ref_colors[src];
        out[dst + 1] = ref_colors[src + 1];
        out[dst + 2] = ref_colors[src + 2];
        out[dst + 3] = ref_colors[src + 3];
    }
}

/// Decode the 8-byte BC3 alpha block into every 4th byte of `out`.
fn decode_smooth_alpha_block(data: &[u8], offset: usize, out: &mut [u8; 64]) {
    let a0 = if offset < data.len() { data[offset] } else { 0 } as u32;
    let a1 = if offset + 1 < data.len() { data[offset + 1] } else { 0 } as u32;

    let mut palette = [0u8; 8];
    palette[0] = a0 as u8;
    palette[1] = a1 as u8;

    if a0 > a1 {
        for i in 1..=6u32 {
            palette[(i + 1) as usize] = (((7 - i) * a0 + i * a1) / 7) as u8;
        }
    } else {
        for i in 1..=4u32 {
            palette[(i + 1) as usize] = (((5 - i) * a0 + i * a1) / 5) as u8;
        }
        palette[6] = 0;
        palette[7] = 255;
    }

    for i in 0..16usize {
        let bit = i * 3;
        let byte_offset = offset + 2 + (bit >> 3);
        let bits = get_u16(data, byte_offset) >> (bit & 7);
        out[i * 4 + 3] = palette[(bits & 7) as usize];
    }
}

/* ------------------------------------------------------------------------- */
/* BC6H (unsigned float16, all 14 modes)                                      */
/* ------------------------------------------------------------------------- */

// Per mode: endpoint-0 precision (W) and delta precisions (dR/dG/dB).
const BC6H_W: [u32; 14] = [10, 7, 11, 11, 11, 9, 8, 8, 8, 6, 10, 11, 12, 16];
const BC6H_DR: [u32; 14] = [5, 6, 5, 4, 4, 5, 6, 5, 5, 6, 10, 9, 8, 4];
const BC6H_DG: [u32; 14] = [5, 6, 5, 5, 4, 5, 5, 6, 5, 6, 10, 9, 8, 4];
const BC6H_DB: [u32; 14] = [5, 6, 4, 4, 5, 5, 5, 5, 6, 6, 10, 9, 8, 4];

fn extend_sign(value: i32, bits: u32) -> i32 {
    let shift = 32 - bits;
    (value << shift) >> shift
}

fn transform_inverse(value: i32, a0: i32, bits: u32) -> i32 {
    (value + a0) & ((1i32 << bits) - 1)
}

fn unquantize_uf16(value: i32, bits: u32) -> i32 {
    if bits >= 15 {
        return value;
    }
    if value == 0 {
        return 0;
    }
    if value == (1i32 << bits) - 1 {
        return 0xffff;
    }
    ((value << 16) + 0x8000) >> bits
}

fn interpolate(a: i32, b: i32, weights: &[i32], index: u32) -> i32 {
    let w = weights[index as usize];
    (a * (64 - w) + b * w + 32) >> 6
}

fn exp2(p: i32) -> f32 {
    f32::from_bits((((p + 127) as u32) & 0xff) << 23)
}

fn half_to_float(half: u16) -> f32 {
    let sign = if half & 0x8000 != 0 { -1.0f32 } else { 1.0f32 };
    let exponent = ((half >> 10) & 0x1f) as i32;
    let mantissa = (half & 0x3ff) as f32;
    if exponent == 0 {
        sign * mantissa * exp2(-24)
    } else if exponent == 31 {
        if mantissa == 0.0 {
            sign * f32::INFINITY
        } else {
            f32::NAN
        }
    } else {
        sign * (1.0 + mantissa / 1024.0) * exp2(exponent - 15)
    }
}


/// Decode one BC6H block without clipping its unsigned half-float values.
fn decode_bc6h_half_block(data: &[u8], out: &mut [u16; 64]) {
    let mut bits = BitReader::new(data);

    let mut r = [0i32; 4];
    let mut g = [0i32; 4];
    let mut b = [0i32; 4];

    let mut mode = bits.read_bits(2);
    if mode > 1 {
        mode |= bits.read_bits(3) << 2;
    }

    let mut partition = 0u32;
    let table_mode: usize;

    match mode {
        /* mode 1 */
        0b00 => {
            g[2] |= (bits.read_bit() << 4) as i32;
            b[2] |= (bits.read_bit() << 4) as i32;
            b[3] |= (bits.read_bit() << 4) as i32;
            r[0] |= bits.read_bits(10) as i32;
            g[0] |= bits.read_bits(10) as i32;
            b[0] |= bits.read_bits(10) as i32;
            r[1] |= bits.read_bits(5) as i32;
            g[3] |= (bits.read_bit() << 4) as i32;
            g[2] |= bits.read_bits(4) as i32;
            g[1] |= bits.read_bits(5) as i32;
            b[3] |= bits.read_bit() as i32;
            g[3] |= bits.read_bits(4) as i32;
            b[1] |= bits.read_bits(5) as i32;
            b[3] |= (bits.read_bit() << 1) as i32;
            b[2] |= bits.read_bits(4) as i32;
            r[2] |= bits.read_bits(5) as i32;
            b[3] |= (bits.read_bit() << 2) as i32;
            r[3] |= bits.read_bits(5) as i32;
            b[3] |= (bits.read_bit() << 3) as i32;
            partition = bits.read_bits(5);
            table_mode = 0;
        }

        /* mode 2 */
        0b01 => {
            g[2] |= (bits.read_bit() << 5) as i32;
            g[3] |= (bits.read_bit() << 4) as i32;
            g[3] |= (bits.read_bit() << 5) as i32;
            r[0] |= bits.read_bits(7) as i32;
            b[3] |= bits.read_bit() as i32;
            b[3] |= (bits.read_bit() << 1) as i32;
            b[2] |= (bits.read_bit() << 4) as i32;
            g[0] |= bits.read_bits(7) as i32;
            b[2] |= (bits.read_bit() << 5) as i32;
            b[3] |= (bits.read_bit() << 2) as i32;
            g[2] |= (bits.read_bit() << 4) as i32;
            b[0] |= bits.read_bits(7) as i32;
            b[3] |= (bits.read_bit() << 3) as i32;
            b[3] |= (bits.read_bit() << 5) as i32;
            b[3] |= (bits.read_bit() << 4) as i32;
            r[1] |= bits.read_bits(6) as i32;
            g[2] |= bits.read_bits(4) as i32;
            g[1] |= bits.read_bits(6) as i32;
            g[3] |= bits.read_bits(4) as i32;
            b[1] |= bits.read_bits(6) as i32;
            b[2] |= bits.read_bits(4) as i32;
            r[2] |= bits.read_bits(6) as i32;
            r[3] |= bits.read_bits(6) as i32;
            partition = bits.read_bits(5);
            table_mode = 1;
        }

        /* mode 3 */
        0b00010 => {
            r[0] |= bits.read_bits(10) as i32;
            g[0] |= bits.read_bits(10) as i32;
            b[0] |= bits.read_bits(10) as i32;
            r[1] |= bits.read_bits(5) as i32;
            r[0] |= (bits.read_bit() << 10) as i32;
            g[2] |= bits.read_bits(4) as i32;
            g[1] |= bits.read_bits(4) as i32;
            g[0] |= (bits.read_bit() << 10) as i32;
            b[3] |= bits.read_bit() as i32;
            g[3] |= bits.read_bits(4) as i32;
            b[1] |= bits.read_bits(4) as i32;
            b[0] |= (bits.read_bit() << 10) as i32;
            b[3] |= (bits.read_bit() << 1) as i32;
            b[2] |= bits.read_bits(4) as i32;
            r[2] |= bits.read_bits(5) as i32;
            b[3] |= (bits.read_bit() << 2) as i32;
            r[3] |= bits.read_bits(5) as i32;
            b[3] |= (bits.read_bit() << 3) as i32;
            partition = bits.read_bits(5);
            table_mode = 2;
        }

        /* mode 4 */
        0b00110 => {
            r[0] |= bits.read_bits(10) as i32;
            g[0] |= bits.read_bits(10) as i32;
            b[0] |= bits.read_bits(10) as i32;
            r[1] |= bits.read_bits(4) as i32;
            r[0] |= (bits.read_bit() << 10) as i32;
            g[3] |= (bits.read_bit() << 4) as i32;
            g[2] |= bits.read_bits(4) as i32;
            g[1] |= bits.read_bits(5) as i32;
            g[0] |= (bits.read_bit() << 10) as i32;
            g[3] |= bits.read_bits(4) as i32;
            b[1] |= bits.read_bits(4) as i32;
            b[0] |= (bits.read_bit() << 10) as i32;
            b[3] |= (bits.read_bit() << 1) as i32;
            b[2] |= bits.read_bits(4) as i32;
            r[2] |= bits.read_bits(4) as i32;
            b[3] |= bits.read_bit() as i32;
            b[3] |= (bits.read_bit() << 2) as i32;
            r[3] |= bits.read_bits(4) as i32;
            g[2] |= (bits.read_bit() << 4) as i32;
            b[3] |= (bits.read_bit() << 3) as i32;
            partition = bits.read_bits(5);
            table_mode = 3;
        }

        /* mode 5 */
        0b01010 => {
            r[0] |= bits.read_bits(10) as i32;
            g[0] |= bits.read_bits(10) as i32;
            b[0] |= bits.read_bits(10) as i32;
            r[1] |= bits.read_bits(4) as i32;
            r[0] |= (bits.read_bit() << 10) as i32;
            b[2] |= (bits.read_bit() << 4) as i32;
            g[2] |= bits.read_bits(4) as i32;
            g[1] |= bits.read_bits(4) as i32;
            g[0] |= (bits.read_bit() << 10) as i32;
            b[3] |= bits.read_bit() as i32;
            g[3] |= bits.read_bits(4) as i32;
            b[1] |= bits.read_bits(5) as i32;
            b[0] |= (bits.read_bit() << 10) as i32;
            b[2] |= bits.read_bits(4) as i32;
            r[2] |= bits.read_bits(4) as i32;
            b[3] |= (bits.read_bit() << 1) as i32;
            b[3] |= (bits.read_bit() << 2) as i32;
            r[3] |= bits.read_bits(4) as i32;
            b[3] |= (bits.read_bit() << 4) as i32;
            b[3] |= (bits.read_bit() << 3) as i32;
            partition = bits.read_bits(5);
            table_mode = 4;
        }

        /* mode 6 */
        0b01110 => {
            r[0] |= bits.read_bits(9) as i32;
            b[2] |= (bits.read_bit() << 4) as i32;
            g[0] |= bits.read_bits(9) as i32;
            g[2] |= (bits.read_bit() << 4) as i32;
            b[0] |= bits.read_bits(9) as i32;
            b[3] |= (bits.read_bit() << 4) as i32;
            r[1] |= bits.read_bits(5) as i32;
            g[3] |= (bits.read_bit() << 4) as i32;
            g[2] |= bits.read_bits(4) as i32;
            g[1] |= bits.read_bits(5) as i32;
            b[3] |= bits.read_bit() as i32;
            g[3] |= bits.read_bits(4) as i32;
            b[1] |= bits.read_bits(5) as i32;
            b[3] |= (bits.read_bit() << 1) as i32;
            b[2] |= bits.read_bits(4) as i32;
            r[2] |= bits.read_bits(5) as i32;
            b[3] |= (bits.read_bit() << 2) as i32;
            r[3] |= bits.read_bits(5) as i32;
            b[3] |= (bits.read_bit() << 3) as i32;
            partition = bits.read_bits(5);
            table_mode = 5;
        }

        /* mode 7 */
        0b10010 => {
            r[0] |= bits.read_bits(8) as i32;
            g[3] |= (bits.read_bit() << 4) as i32;
            b[2] |= (bits.read_bit() << 4) as i32;
            g[0] |= bits.read_bits(8) as i32;
            b[3] |= (bits.read_bit() << 2) as i32;
            g[2] |= (bits.read_bit() << 4) as i32;
            b[0] |= bits.read_bits(8) as i32;
            b[3] |= (bits.read_bit() << 3) as i32;
            b[3] |= (bits.read_bit() << 4) as i32;
            r[1] |= bits.read_bits(6) as i32;
            g[2] |= bits.read_bits(4) as i32;
            g[1] |= bits.read_bits(5) as i32;
            b[3] |= bits.read_bit() as i32;
            g[3] |= bits.read_bits(4) as i32;
            b[1] |= bits.read_bits(5) as i32;
            b[3] |= (bits.read_bit() << 1) as i32;
            b[2] |= bits.read_bits(4) as i32;
            r[2] |= bits.read_bits(6) as i32;
            r[3] |= bits.read_bits(6) as i32;
            partition = bits.read_bits(5);
            table_mode = 6;
        }

        /* mode 8 */
        0b10110 => {
            r[0] |= bits.read_bits(8) as i32;
            b[3] |= bits.read_bit() as i32;
            b[2] |= (bits.read_bit() << 4) as i32;
            g[0] |= bits.read_bits(8) as i32;
            g[2] |= (bits.read_bit() << 5) as i32;
            g[2] |= (bits.read_bit() << 4) as i32;
            b[0] |= bits.read_bits(8) as i32;
            g[3] |= (bits.read_bit() << 5) as i32;
            b[3] |= (bits.read_bit() << 4) as i32;
            r[1] |= bits.read_bits(5) as i32;
            g[3] |= (bits.read_bit() << 4) as i32;
            g[2] |= bits.read_bits(4) as i32;
            g[1] |= bits.read_bits(6) as i32;
            g[3] |= bits.read_bits(4) as i32;
            b[1] |= bits.read_bits(5) as i32;
            b[3] |= (bits.read_bit() << 1) as i32;
            b[2] |= bits.read_bits(4) as i32;
            r[2] |= bits.read_bits(5) as i32;
            b[3] |= (bits.read_bit() << 2) as i32;
            r[3] |= bits.read_bits(5) as i32;
            b[3] |= (bits.read_bit() << 3) as i32;
            partition = bits.read_bits(5);
            table_mode = 7;
        }

        /* mode 9 */
        0b11010 => {
            r[0] |= bits.read_bits(8) as i32;
            b[3] |= (bits.read_bit() << 1) as i32;
            b[2] |= (bits.read_bit() << 4) as i32;
            g[0] |= bits.read_bits(8) as i32;
            b[2] |= (bits.read_bit() << 5) as i32;
            g[2] |= (bits.read_bit() << 4) as i32;
            b[0] |= bits.read_bits(8) as i32;
            b[3] |= (bits.read_bit() << 5) as i32;
            b[3] |= (bits.read_bit() << 4) as i32;
            r[1] |= bits.read_bits(5) as i32;
            g[3] |= (bits.read_bit() << 4) as i32;
            g[2] |= bits.read_bits(4) as i32;
            g[1] |= bits.read_bits(5) as i32;
            b[3] |= bits.read_bit() as i32;
            g[3] |= bits.read_bits(4) as i32;
            b[1] |= bits.read_bits(6) as i32;
            b[2] |= bits.read_bits(4) as i32;
            r[2] |= bits.read_bits(5) as i32;
            b[3] |= (bits.read_bit() << 2) as i32;
            r[3] |= bits.read_bits(5) as i32;
            b[3] |= (bits.read_bit() << 3) as i32;
            partition = bits.read_bits(5);
            table_mode = 8;
        }

        /* mode 10 */
        0b11110 => {
            r[0] |= bits.read_bits(6) as i32;
            g[3] |= (bits.read_bit() << 4) as i32;
            b[3] |= bits.read_bit() as i32;
            b[3] |= (bits.read_bit() << 1) as i32;
            b[2] |= (bits.read_bit() << 4) as i32;
            g[0] |= bits.read_bits(6) as i32;
            g[2] |= (bits.read_bit() << 5) as i32;
            b[2] |= (bits.read_bit() << 5) as i32;
            b[3] |= (bits.read_bit() << 2) as i32;
            g[2] |= (bits.read_bit() << 4) as i32;
            b[0] |= bits.read_bits(6) as i32;
            g[3] |= (bits.read_bit() << 5) as i32;
            b[3] |= (bits.read_bit() << 3) as i32;
            b[3] |= (bits.read_bit() << 5) as i32;
            b[3] |= (bits.read_bit() << 4) as i32;
            r[1] |= bits.read_bits(6) as i32;
            g[2] |= bits.read_bits(4) as i32;
            g[1] |= bits.read_bits(6) as i32;
            g[3] |= bits.read_bits(4) as i32;
            b[1] |= bits.read_bits(6) as i32;
            b[2] |= bits.read_bits(4) as i32;
            r[2] |= bits.read_bits(6) as i32;
            r[3] |= bits.read_bits(6) as i32;
            partition = bits.read_bits(5);
            table_mode = 9;
        }

        /* mode 11 */
        0b00011 => {
            r[0] |= bits.read_bits(10) as i32;
            g[0] |= bits.read_bits(10) as i32;
            b[0] |= bits.read_bits(10) as i32;
            r[1] |= bits.read_bits(10) as i32;
            g[1] |= bits.read_bits(10) as i32;
            b[1] |= bits.read_bits(10) as i32;
            table_mode = 10;
        }

        /* mode 12 */
        0b00111 => {
            r[0] |= bits.read_bits(10) as i32;
            g[0] |= bits.read_bits(10) as i32;
            b[0] |= bits.read_bits(10) as i32;
            r[1] |= bits.read_bits(9) as i32;
            r[0] |= (bits.read_bit() << 10) as i32;
            g[1] |= bits.read_bits(9) as i32;
            g[0] |= (bits.read_bit() << 10) as i32;
            b[1] |= bits.read_bits(9) as i32;
            b[0] |= (bits.read_bit() << 10) as i32;
            table_mode = 11;
        }

        /* mode 13 */
        0b01011 => {
            r[0] |= bits.read_bits(10) as i32;
            g[0] |= bits.read_bits(10) as i32;
            b[0] |= bits.read_bits(10) as i32;
            r[1] |= bits.read_bits(8) as i32;
            r[0] |= (bits.read_bits_reversed(2) << 10) as i32;
            g[1] |= bits.read_bits(8) as i32;
            g[0] |= (bits.read_bits_reversed(2) << 10) as i32;
            b[1] |= bits.read_bits(8) as i32;
            b[0] |= (bits.read_bits_reversed(2) << 10) as i32;
            table_mode = 12;
        }

        /* mode 14 */
        0b01111 => {
            r[0] |= bits.read_bits(10) as i32;
            g[0] |= bits.read_bits(10) as i32;
            b[0] |= bits.read_bits(10) as i32;
            r[1] |= bits.read_bits(4) as i32;
            r[0] |= (bits.read_bits_reversed(6) << 10) as i32;
            g[1] |= bits.read_bits(4) as i32;
            g[0] |= (bits.read_bits_reversed(6) << 10) as i32;
            b[1] |= bits.read_bits(4) as i32;
            b[0] |= (bits.read_bits_reversed(6) << 10) as i32;
            table_mode = 13;
        }

        _ => {
            // Reserved modes decode to black (RGB), opaque alpha.
            out.fill(0);
            for i in 0..16 {
                out[i * 4 + 3] = 0x3c00;
            }
            return;
        }
    }

    let num_partitions: usize = if table_mode >= 10 { 0 } else { 1 };
    let endpoint_count = (num_partitions + 1) * 2;
    let w_bits = BC6H_W[table_mode];

    // Delta-compressed modes (everything except 0b11110 and 0b00011): the
    // remaining endpoints are signed two's-complement deltas from endpoint 0.
    if table_mode != 9 && table_mode != 10 {
        let dr_bits = BC6H_DR[table_mode];
        let dg_bits = BC6H_DG[table_mode];
        let db_bits = BC6H_DB[table_mode];
        for i in 1..endpoint_count {
            r[i] = extend_sign(r[i], dr_bits);
            g[i] = extend_sign(g[i], dg_bits);
            b[i] = extend_sign(b[i], db_bits);
        }
        for i in 1..endpoint_count {
            r[i] = transform_inverse(r[i], r[0], w_bits);
            g[i] = transform_inverse(g[i], g[0], w_bits);
            b[i] = transform_inverse(b[i], b[0], w_bits);
        }
    }

    for i in 0..endpoint_count {
        r[i] = unquantize_uf16(r[i], w_bits);
        g[i] = unquantize_uf16(g[i], w_bits);
        b[i] = unquantize_uf16(b[i], w_bits);
    }

    let weights: &[i32] = if table_mode >= 10 { &W4 } else { &W3 };
    let base_index_bits: u32 = if table_mode >= 10 { 4 } else { 3 };
    let partition_index = (partition as usize) & 63;
    let anchor = if num_partitions == 1 { ANCHOR2[partition_index] } else { 0 };
    let part_pattern = if num_partitions == 1 { PART2[partition_index] } else { 0 };

    for py in 0..4usize {
        for px in 0..4usize {
            let pixel = py * 4 + px;
            let (subset, is_fix_up) = if num_partitions == 1 {
                (((part_pattern >> (pixel * 2)) & 3) as usize, pixel == 0 || pixel == anchor)
            } else {
                (0usize, pixel == 0)
            };
            let index = bits.read_bits(base_index_bits - if is_fix_up { 1 } else { 0 });
            let ep = subset * 2;
            let dst = pixel * 4;
            out[dst] = ((interpolate(r[ep], r[ep + 1], weights, index) * 31) >> 6) as u16;
            out[dst + 1] = ((interpolate(g[ep], g[ep + 1], weights, index) * 31) >> 6) as u16;
            out[dst + 2] = ((interpolate(b[ep], b[ep + 1], weights, index) * 31) >> 6) as u16;
            out[dst + 3] = 0x3c00;
        }
    }
}

fn decode_bc6h_block(data: &[u8], out: &mut [u8; 64]) {
    let mut half = [0u16; 64];
    decode_bc6h_half_block(data, &mut half);
    for i in 0..64 {
        out[i] = (half_to_float(half[i]) * 255.0).clamp(0.0, 255.0) as u8;
    }
}

/// Decode BC6H to RGBA16F, retaining HDR and rejecting truncated input.
pub fn decode_bc6h_half(src: &[u8], width: usize, height: usize, dst: &mut [u16]) -> i32 {
    let bx = (width + 3) / 4;
    let by = (height + 3) / 4;
    if width == 0 || height == 0 || dst.len() < width * height * 4 || src.len() < bx * by * 16 { return -1; }
    let mut pixels = [0u16; 64];
    for yb in 0..by {
        for xb in 0..bx {
            let off = (yb * bx + xb) * 16;
            decode_bc6h_half_block(&src[off..off + 16], &mut pixels);
            for y in 0..4 {
                for x in 0..4 {
                    if xb * 4 + x < width && yb * 4 + y < height {
                        let d = ((yb * 4 + y) * width + xb * 4 + x) * 4;
                        let s = (y * 4 + x) * 4;
                        dst[d..d + 4].copy_from_slice(&pixels[s..s + 4]);
                    }
                }
            }
        }
    }
    0
}

/* ------------------------------------------------------------------------- */
/* BC7 (all 8 modes)                                                          */
/* ------------------------------------------------------------------------- */

// [subsets, partBits, rotBits, idxModeBits, colorBits, alphaBits,
//  epPbits, spPbits, idxBits0, idxBits1]
const BC7_MODES: [[u32; 10]; 8] = [
    [3, 4, 0, 0, 4, 0, 1, 0, 3, 0], // mode 0
    [2, 6, 0, 0, 6, 0, 0, 1, 3, 0], // mode 1
    [3, 6, 0, 0, 5, 0, 0, 0, 2, 0], // mode 2
    [2, 6, 0, 0, 7, 0, 1, 0, 2, 0], // mode 3
    [1, 0, 2, 1, 5, 6, 0, 0, 2, 3], // mode 4
    [1, 0, 2, 0, 7, 8, 0, 0, 2, 2], // mode 5
    [1, 0, 0, 0, 7, 7, 1, 0, 4, 0], // mode 6
    [2, 6, 0, 0, 5, 5, 1, 0, 2, 0], // mode 7
];

/// Expand a `precision`-bit value to 8 bits with bit replication.
fn expand_to8(value: i32, precision: u32) -> i32 {
    (value << (8 - precision)) | (value >> (2 * precision - 8))
}

fn blend(e0: i32, e1: i32, w: i32) -> i32 {
    (e0 * (64 - w) + e1 * w + 32) >> 6
}

fn weights_for(idx_bits: u32) -> &'static [i32] {
    match idx_bits {
        2 => &W2,
        3 => &W3,
        _ => &W4,
    }
}

fn part2_subset(part: usize, pixel: usize) -> usize {
    ((PART2[part] >> (pixel * 2)) & 3) as usize
}

fn part3_subset(part: usize, pixel: usize) -> usize {
    ((PART3[part] >> (pixel * 2)) & 3) as usize
}

/// Decode one 16-byte BC7 block into 16 RGBA pixels (64 bytes).
fn decode_bc7_block(data: &[u8], out: &mut [u8; 64]) {
    let mut bits = BitReader::new(data);

    let mut mode = 0usize;
    while mode < 8 && bits.read_bit() == 0 {
        mode += 1;
    }
    if mode >= 8 {
        out.fill(0);
        return;
    }

    let spec = &BC7_MODES[mode];
    let subsets = spec[0] as usize;
    let part_bits = spec[1];
    let rot_bits = spec[2];
    let idx_mode_bits = spec[3];
    let color_bits = spec[4];
    let alpha_bits = spec[5];
    let ep_pbits = spec[6];
    let sp_pbits = spec[7];
    let idx_bits0 = spec[8];
    let idx_bits1 = spec[9];

    let part = bits.read_bits(part_bits) as usize & 63;
    let rotation = bits.read_bits(rot_bits);
    let idx_mode = bits.read_bits(idx_mode_bits);

    let endpoint_count = subsets * 2;
    let mut endpoints = [[0i32; 4]; 6];
    for ep in 0..endpoint_count {
        endpoints[ep][3] = if alpha_bits > 0 { 0 } else { 255 };
    }

    for ch in 0..3 {
        for ep in 0..endpoint_count {
            endpoints[ep][ch] = bits.read_bits(color_bits) as i32;
        }
    }
    if alpha_bits > 0 {
        for ep in 0..endpoint_count {
            endpoints[ep][3] = bits.read_bits(alpha_bits) as i32;
        }
    }

    let mut color_prec = color_bits;
    let mut alpha_prec = if alpha_bits > 0 { alpha_bits } else { 0 };

    if ep_pbits != 0 {
        for ep in 0..endpoint_count {
            let p = bits.read_bit() as i32;
            endpoints[ep][0] = (endpoints[ep][0] << 1) | p;
            endpoints[ep][1] = (endpoints[ep][1] << 1) | p;
            endpoints[ep][2] = (endpoints[ep][2] << 1) | p;
            if alpha_bits > 0 {
                endpoints[ep][3] = (endpoints[ep][3] << 1) | p;
            }
        }
        color_prec += 1;
        if alpha_bits > 0 {
            alpha_prec += 1;
        }
    } else if sp_pbits != 0 {
        for s in 0..subsets {
            let p = bits.read_bit() as i32;
            let e0 = s * 2;
            let e1 = e0 + 1;
            for ch in 0..3 {
                endpoints[e0][ch] = (endpoints[e0][ch] << 1) | p;
                endpoints[e1][ch] = (endpoints[e1][ch] << 1) | p;
            }
        }
        color_prec += 1;
    }

    for ep in 0..endpoint_count {
        for ch in 0..3 {
            endpoints[ep][ch] = expand_to8(endpoints[ep][ch], color_prec);
        }
        if alpha_bits > 0 {
            endpoints[ep][3] = expand_to8(endpoints[ep][3], alpha_prec);
        }
    }

    let anchor1: usize = if subsets >= 2 {
        if subsets == 3 {
            ANCHOR3_1[part]
        } else {
            ANCHOR2[part]
        }
    } else {
        usize::MAX
    };
    let anchor2: usize = if subsets == 3 { ANCHOR3_2[part] } else { usize::MAX };

    let mut idx0 = [0u32; 16];
    let mut idx1 = [0u32; 16];

    for i in 0..16 {
        let is_anchor = i == 0 || i == anchor1 || i == anchor2;
        idx0[i] = bits.read_bits(idx_bits0 - if is_anchor { 1 } else { 0 });
    }

    if idx_bits1 > 0 {
        for i in 0..16 {
            idx1[i] = bits.read_bits(idx_bits1 - if i == 0 { 1 } else { 0 });
        }
    }

    let weights0 = weights_for(idx_bits0);
    let weights1 = weights_for(idx_bits1);

    for i in 0..16 {
        let subset = if subsets == 1 {
            0
        } else if subsets == 2 {
            part2_subset(part, i)
        } else {
            part3_subset(part, i)
        };
        let e0 = endpoints[subset * 2];
        let e1 = endpoints[subset * 2 + 1];

        let mut color_index = idx0[i] as usize;
        let mut alpha_index = idx0[i] as usize;
        let mut color_weights = weights0;
        let mut alpha_weights = weights0;

        if idx_bits1 > 0 {
            if idx_mode == 0 {
                color_weights = weights0;
                color_index = idx0[i] as usize;
                alpha_weights = weights1;
                alpha_index = idx1[i] as usize;
            } else {
                color_weights = weights1;
                color_index = idx1[i] as usize;
                alpha_weights = weights0;
                alpha_index = idx0[i] as usize;
            }
        }

        let cw = color_weights[color_index];
        let aw = alpha_weights[alpha_index];

        let mut r = blend(e0[0], e1[0], cw);
        let mut g = blend(e0[1], e1[1], cw);
        let mut b = blend(e0[2], e1[2], cw);
        let mut a = blend(e0[3], e1[3], aw);

        if rotation == 1 {
            core::mem::swap(&mut a, &mut r);
        } else if rotation == 2 {
            core::mem::swap(&mut a, &mut g);
        } else if rotation == 3 {
            core::mem::swap(&mut a, &mut b);
        }

        let dst = i * 4;
        out[dst] = r as u8;
        out[dst + 1] = g as u8;
        out[dst + 2] = b as u8;
        out[dst + 3] = a as u8;
    }
}

/* ------------------------------------------------------------------------- */
/* Texture decoding entry point                                               */
/* ------------------------------------------------------------------------- */

/// Unity `TextureFormat` values handled here.
pub const FMT_RGB24: u32 = 3;
pub const FMT_RGBA32: u32 = 4;
pub const FMT_DXT1: u32 = 10;
pub const FMT_DXT5: u32 = 12;
pub const FMT_BC6H: u32 = 24;
pub const FMT_BC7: u32 = 25;

/// Decode raw `Texture2D` bytes into tightly packed RGBA8 rows.
///
/// Block-compressed formats are padded up to whole 4x4 blocks when decoding and
/// cropped back to `width x height`; `flip` mirrors rows vertically so Unity's
/// bottom-up data becomes top-down. Returns `0` on success, `< 0` on error.
pub fn decode_texture2d_rgba(
    src: &[u8],
    width: usize,
    height: usize,
    format: u32,
    flip: bool,
    dst: &mut [u8],
) -> i32 {
    if width == 0 || height == 0 {
        return -1;
    }
    let out_len = match width.checked_mul(height).and_then(|v| v.checked_mul(4)) {
        Some(v) => v,
        None => return -1,
    };
    if dst.len() < out_len {
        return -2;
    }

    // Uncompressed formats: copy rows, expanding to RGBA.
    if format == FMT_RGB24 || format == FMT_RGBA32 {
        let src_channels = if format == FMT_RGBA32 { 4usize } else { 3usize };
        let src_row = width * src_channels;
        let get = |off: usize| -> u8 {
            if off < src.len() {
                src[off]
            } else {
                0
            }
        };
        for src_y in 0..height {
            let dst_y = if flip { height - 1 - src_y } else { src_y };
            let src_base = src_y * src_row;
            let dst_base = dst_y * width * 4;
            for x in 0..width {
                let s = src_base + x * src_channels;
                let d = dst_base + x * 4;
                dst[d] = get(s);
                dst[d + 1] = get(s + 1);
                dst[d + 2] = get(s + 2);
                dst[d + 3] = if src_channels == 4 { get(s + 3) } else { 255 };
            }
        }
        return 0;
    }

    let block_bytes: usize = match format {
        FMT_DXT1 => 8,
        FMT_DXT5 | FMT_BC6H | FMT_BC7 => 16,
        _ => return -3, // unsupported texture format
    };

    let blocks_x = (width + 3) / 4;
    let blocks_y = (height + 3) / 4;
    let mut block = [0u8; 16];
    let mut pixels = [0u8; 64];

    for by in 0..blocks_y {
        for bx in 0..blocks_x {
            let offset = (by * blocks_x + bx) * block_bytes;
            block[..block_bytes].fill(0);
            if offset < src.len() {
                // Bytes past the end of the source stay zero (truncated input).
                let end = (offset + block_bytes).min(src.len());
                block[..end - offset].copy_from_slice(&src[offset..end]);
            }

            match format {
                FMT_DXT1 => decode_color_block(&block, 0, &mut pixels),
                FMT_DXT5 => {
                    decode_color_block(&block, 8, &mut pixels);
                    decode_smooth_alpha_block(&block, 0, &mut pixels);
                }
                FMT_BC6H => decode_bc6h_block(&block, &mut pixels),
                _ => decode_bc7_block(&block, &mut pixels),
            }

            for py in 0..4usize {
                let y = by * 4 + py;
                if y >= height {
                    break;
                }
                let dst_y = if flip { height - 1 - y } else { y };
                for px in 0..4usize {
                    let x = bx * 4 + px;
                    if x >= width {
                        continue;
                    }
                    let s = (py * 4 + px) * 4;
                    let d = (dst_y * width + x) * 4;
                    dst[d] = pixels[s];
                    dst[d + 1] = pixels[s + 1];
                    dst[d + 2] = pixels[s + 2];
                    dst[d + 3] = pixels[s + 3];
                }
            }
        }
    }

    0
}
