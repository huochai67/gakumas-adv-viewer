// CRI HCA (v1.1 .. v3.0) decoder + 60 Hz AIUEO lip-sync analyzer.
//
// This is a faithful, dependency-free Rust port of vgmstream's clHCA
// (`pipeline/clhca/clhca.c` + `clhca_data.h`, original decompilation by nyaga,
// C port by kode54, cleanup by bnnm) and of `computeAiueoFrames` from
// `pipeline/export_voices.ts` (2048-point radix-2 FFT formant analysis).
//
// Exposed entry points:
//   * `decode_hca_mono`       raw-pointer decoder matching `pipeline/decode_hca.mjs`
//   * `compute_aiueo`         raw-pointer 60 Hz lip-sync analyzer
//   * `decode_hca_mono_slice` safe slice wrapper (empty `dst` = sample-count query)
//   * `compute_aiueo_slice`   safe slice wrapper
//
// Only `core`/`std` primitives are used; no external crates.

use std::vec::Vec;

//--------------------------------------------------
// Constants
//--------------------------------------------------

const HCA_VERSION_V101: u32 = 0x0101;
const HCA_VERSION_V102: u32 = 0x0102;
const HCA_VERSION_V103: u32 = 0x0103;
const HCA_VERSION_V200: u32 = 0x0200;
const HCA_VERSION_V300: u32 = 0x0300;

const HCA_MIN_FRAME_SIZE: u32 = 0x8;
const HCA_MAX_FRAME_SIZE: u32 = 0xFFFF;

const HCA_MASK: u32 = 0x7F7F_7F7F;
const HCA_SUBFRAMES: usize = 8;
const HCA_SAMPLES_PER_SUBFRAME: usize = 128;
const HCA_SAMPLES_PER_FRAME: usize = HCA_SUBFRAMES * HCA_SAMPLES_PER_SUBFRAME;
const HCA_MDCT_BITS: usize = 7;

const HCA_MIN_CHANNELS: u32 = 1;
const HCA_MAX_CHANNELS: usize = 16;
const HCA_CHANNEL_CONFIG_FLAG_AMBISONICS: u32 = 0x80;

const HCA_MIN_SAMPLE_RATE: u32 = 1;
const HCA_MAX_SAMPLE_RATE: u32 = 0x7F_FFFF;

const HCA_DEFAULT_RANDOM: u32 = 1;

const HCA_RESULT_OK: i32 = 0;
const HCA_ERROR_PARAMS: i32 = -1;
const HCA_ERROR_HEADER: i32 = -2;
const HCA_ERROR_CHECKSUM: i32 = -3;
const HCA_ERROR_SYNC: i32 = -4;
const HCA_ERROR_UNPACK: i32 = -5;
const HCA_ERROR_BITREADER: i32 = -6;

const DISCRETE: u8 = 0;
const STEREO_PRIMARY: u8 = 1;
const STEREO_SECONDARY: u8 = 2;

// CRC16 mask table (HCACommon_CalculateCrc)
static HCACOMMON_CRC_MASK_TABLE: [u16; 256] = [
    0x0000,0x8005,0x800F,0x000A,0x801B,0x001E,0x0014,0x8011,0x8033,0x0036,0x003C,0x8039,0x0028,0x802D,0x8027,0x0022,
    0x8063,0x0066,0x006C,0x8069,0x0078,0x807D,0x8077,0x0072,0x0050,0x8055,0x805F,0x005A,0x804B,0x004E,0x0044,0x8041,
    0x80C3,0x00C6,0x00CC,0x80C9,0x00D8,0x80DD,0x80D7,0x00D2,0x00F0,0x80F5,0x80FF,0x00FA,0x80EB,0x00EE,0x00E4,0x80E1,
    0x00A0,0x80A5,0x80AF,0x00AA,0x80BB,0x00BE,0x00B4,0x80B1,0x8093,0x0096,0x009C,0x8099,0x0088,0x808D,0x8087,0x0082,
    0x8183,0x0186,0x018C,0x8189,0x0198,0x819D,0x8197,0x0192,0x01B0,0x81B5,0x81BF,0x01BA,0x81AB,0x01AE,0x01A4,0x81A1,
    0x01E0,0x81E5,0x81EF,0x01EA,0x81FB,0x01FE,0x01F4,0x81F1,0x81D3,0x01D6,0x01DC,0x81D9,0x01C8,0x81CD,0x81C7,0x01C2,
    0x0140,0x8145,0x814F,0x014A,0x815B,0x015E,0x0154,0x8151,0x8173,0x0176,0x017C,0x8179,0x0168,0x816D,0x8167,0x0162,
    0x8123,0x0126,0x012C,0x8129,0x0138,0x813D,0x8137,0x0132,0x0110,0x8115,0x811F,0x011A,0x810B,0x010E,0x0104,0x8101,
    0x8303,0x0306,0x030C,0x8309,0x0318,0x831D,0x8317,0x0312,0x0330,0x8335,0x833F,0x033A,0x832B,0x032E,0x0324,0x8321,
    0x0360,0x8365,0x836F,0x036A,0x837B,0x037E,0x0374,0x8371,0x8353,0x0356,0x035C,0x8359,0x0348,0x834D,0x8347,0x0342,
    0x03C0,0x83C5,0x83CF,0x03CA,0x83DB,0x03DE,0x03D4,0x83D1,0x83F3,0x03F6,0x03FC,0x83F9,0x03E8,0x83ED,0x83E7,0x03E2,
    0x83A3,0x03A6,0x03AC,0x83A9,0x03B8,0x83BD,0x83B7,0x03B2,0x0390,0x8395,0x839F,0x039A,0x838B,0x038E,0x0384,0x8381,
    0x0280,0x8285,0x828F,0x028A,0x829B,0x029E,0x0294,0x8291,0x82B3,0x02B6,0x02BC,0x82B9,0x02A8,0x82AD,0x82A7,0x02A2,
    0x82E3,0x02E6,0x02EC,0x82E9,0x02F8,0x82FD,0x82F7,0x02F2,0x02D0,0x82D5,0x82DF,0x02DA,0x82CB,0x02CE,0x02C4,0x82C1,
    0x8243,0x0246,0x024C,0x8249,0x0258,0x825D,0x8257,0x0252,0x0270,0x8275,0x827F,0x027A,0x826B,0x026E,0x0264,0x8261,
    0x0220,0x8225,0x822F,0x022A,0x823B,0x023E,0x0234,0x8231,0x8213,0x0216,0x021C,0x8219,0x0208,0x820D,0x8207,0x0202,
];

// Base ATH (Absolute Threshold of Hearing) curve, for 41856 Hz
static ATH_BASE_CURVE: [u8; 656] = [
    0x78,0x5F,0x56,0x51,0x4E,0x4C,0x4B,0x49,0x48,0x48,0x47,0x46,0x46,0x45,0x45,0x45,
    0x44,0x44,0x44,0x44,0x43,0x43,0x43,0x43,0x43,0x43,0x42,0x42,0x42,0x42,0x42,0x42,
    0x42,0x42,0x41,0x41,0x41,0x41,0x41,0x41,0x41,0x41,0x41,0x41,0x40,0x40,0x40,0x40,
    0x40,0x40,0x40,0x40,0x40,0x3F,0x3F,0x3F,0x3F,0x3F,0x3F,0x3F,0x3F,0x3F,0x3F,0x3F,
    0x3F,0x3F,0x3F,0x3E,0x3E,0x3E,0x3E,0x3E,0x3E,0x3D,0x3D,0x3D,0x3D,0x3D,0x3D,0x3D,
    0x3C,0x3C,0x3C,0x3C,0x3C,0x3C,0x3C,0x3C,0x3B,0x3B,0x3B,0x3B,0x3B,0x3B,0x3B,0x3B,
    0x3B,0x3B,0x3B,0x3B,0x3B,0x3B,0x3B,0x3B,0x3B,0x3B,0x3B,0x3B,0x3B,0x3B,0x3B,0x3B,
    0x3B,0x3B,0x3B,0x3B,0x3B,0x3B,0x3B,0x3B,0x3C,0x3C,0x3C,0x3C,0x3C,0x3C,0x3C,0x3C,
    0x3D,0x3D,0x3D,0x3D,0x3D,0x3D,0x3D,0x3D,0x3E,0x3E,0x3E,0x3E,0x3E,0x3E,0x3E,0x3F,
    0x3F,0x3F,0x3F,0x3F,0x3F,0x3F,0x3F,0x3F,0x3F,0x3F,0x3F,0x3F,0x3F,0x3F,0x3F,0x3F,
    0x3F,0x3F,0x3F,0x3F,0x40,0x40,0x40,0x40,0x40,0x40,0x40,0x40,0x40,0x40,0x40,0x40,
    0x40,0x40,0x40,0x40,0x40,0x40,0x40,0x40,0x40,0x41,0x41,0x41,0x41,0x41,0x41,0x41,
    0x41,0x41,0x41,0x41,0x41,0x41,0x41,0x41,0x41,0x41,0x41,0x41,0x41,0x41,0x41,0x41,
    0x41,0x41,0x41,0x41,0x41,0x41,0x41,0x42,0x42,0x42,0x42,0x42,0x42,0x42,0x42,0x42,
    0x42,0x42,0x42,0x42,0x42,0x42,0x42,0x42,0x42,0x42,0x42,0x42,0x42,0x43,0x43,0x43,
    0x43,0x43,0x43,0x43,0x43,0x43,0x43,0x43,0x43,0x43,0x43,0x43,0x43,0x43,0x44,0x44,
    0x44,0x44,0x44,0x44,0x44,0x44,0x44,0x44,0x44,0x44,0x44,0x44,0x45,0x45,0x45,0x45,
    0x45,0x45,0x45,0x45,0x45,0x45,0x45,0x45,0x46,0x46,0x46,0x46,0x46,0x46,0x46,0x46,
    0x46,0x46,0x47,0x47,0x47,0x47,0x47,0x47,0x47,0x47,0x47,0x47,0x48,0x48,0x48,0x48,
    0x48,0x48,0x48,0x48,0x49,0x49,0x49,0x49,0x49,0x49,0x49,0x49,0x4A,0x4A,0x4A,0x4A,
    0x4A,0x4A,0x4A,0x4A,0x4B,0x4B,0x4B,0x4B,0x4B,0x4B,0x4B,0x4C,0x4C,0x4C,0x4C,0x4C,
    0x4C,0x4D,0x4D,0x4D,0x4D,0x4D,0x4D,0x4E,0x4E,0x4E,0x4E,0x4E,0x4E,0x4F,0x4F,0x4F,
    0x4F,0x4F,0x4F,0x50,0x50,0x50,0x50,0x50,0x51,0x51,0x51,0x51,0x51,0x52,0x52,0x52,
    0x52,0x52,0x53,0x53,0x53,0x53,0x54,0x54,0x54,0x54,0x54,0x55,0x55,0x55,0x55,0x56,
    0x56,0x56,0x56,0x57,0x57,0x57,0x57,0x57,0x58,0x58,0x58,0x59,0x59,0x59,0x59,0x5A,
    0x5A,0x5A,0x5A,0x5B,0x5B,0x5B,0x5B,0x5C,0x5C,0x5C,0x5D,0x5D,0x5D,0x5D,0x5E,0x5E,
    0x5E,0x5F,0x5F,0x5F,0x60,0x60,0x60,0x61,0x61,0x61,0x61,0x62,0x62,0x62,0x63,0x63,
    0x63,0x64,0x64,0x64,0x65,0x65,0x66,0x66,0x66,0x67,0x67,0x67,0x68,0x68,0x68,0x69,
    0x69,0x6A,0x6A,0x6A,0x6B,0x6B,0x6B,0x6C,0x6C,0x6D,0x6D,0x6D,0x6E,0x6E,0x6F,0x6F,
    0x70,0x70,0x70,0x71,0x71,0x72,0x72,0x73,0x73,0x73,0x74,0x74,0x75,0x75,0x76,0x76,
    0x77,0x77,0x78,0x78,0x78,0x79,0x79,0x7A,0x7A,0x7B,0x7B,0x7C,0x7C,0x7D,0x7D,0x7E,
    0x7E,0x7F,0x7F,0x80,0x80,0x81,0x81,0x82,0x83,0x83,0x84,0x84,0x85,0x85,0x86,0x86,
    0x87,0x88,0x88,0x89,0x89,0x8A,0x8A,0x8B,0x8C,0x8C,0x8D,0x8D,0x8E,0x8F,0x8F,0x90,
    0x90,0x91,0x92,0x92,0x93,0x94,0x94,0x95,0x95,0x96,0x97,0x97,0x98,0x99,0x99,0x9A,
    0x9B,0x9B,0x9C,0x9D,0x9D,0x9E,0x9F,0xA0,0xA0,0xA1,0xA2,0xA2,0xA3,0xA4,0xA5,0xA5,
    0xA6,0xA7,0xA7,0xA8,0xA9,0xAA,0xAA,0xAB,0xAC,0xAD,0xAE,0xAE,0xAF,0xB0,0xB1,0xB1,
    0xB2,0xB3,0xB4,0xB5,0xB6,0xB6,0xB7,0xB8,0xB9,0xBA,0xBA,0xBB,0xBC,0xBD,0xBE,0xBF,
    0xC0,0xC1,0xC1,0xC2,0xC3,0xC4,0xC5,0xC6,0xC7,0xC8,0xC9,0xC9,0xCA,0xCB,0xCC,0xCD,
    0xCE,0xCF,0xD0,0xD1,0xD2,0xD3,0xD4,0xD5,0xD6,0xD7,0xD8,0xD9,0xDA,0xDB,0xDC,0xDD,
    0xDE,0xDF,0xE0,0xE1,0xE2,0xE3,0xE4,0xE5,0xE6,0xE7,0xE8,0xE9,0xEA,0xEB,0xED,0xEE,
    0xEF,0xF0,0xF1,0xF2,0xF3,0xF4,0xF5,0xF7,0xF8,0xF9,0xFA,0xFB,0xFC,0xFD,0xFF,0xFF,
];

// curve/scale to quantized resolution
static HCADECODER_INVERT_TABLE: [u8; 66] = [
    14,14,14,14,14,14,13,13,13,13,13,13,12,12,12,12,
    12,12,11,11,11,11,11,11,10,10,10,10,10,10,10,9,
    9,9,9,9,9,8,8,8,8,8,8,7,6,6,5,4,
    4,4,3,3,3,2,2,2,2,1,1,1,1,1,1,1,
    1,1,
];

// scalefactor-to-scaling table: sqrt(128) * (2^(53/128))^(scale_factor - 63)
static HCADEQUANTIZER_SCALING_TABLE_FLOAT_HEX: [u32; 64] = [
    0x342A8D26,0x34633F89,0x3497657D,0x34C9B9BE,0x35066491,0x353311C4,0x356E9910,0x359EF532,0x35D3CCF1,0x360D1ADF,0x363C034A,0x367A83B3,0x36A6E595,0x36DE60F5,0x371426FF,0x3745672A,
    0x37838359,0x37AF3B79,0x37E97C38,0x381B8D3A,0x384F4319,0x388A14D5,0x38B7FBF0,0x38F5257D,0x3923520F,0x39599D16,0x3990FA4D,0x39C12C4D,0x3A00B1ED,0x3A2B7A3A,0x3A647B6D,0x3A9837F0,
    0x3ACAD226,0x3B071F62,0x3B340AAF,0x3B6FE4BA,0x3B9FD228,0x3BD4F35B,0x3C0DDF04,0x3C3D08A4,0x3C7BDFED,0x3CA7CD94,0x3CDF9613,0x3D14F4F0,0x3D467991,0x3D843A29,0x3DB02F0E,0x3DEAC0C7,
    0x3E1C6573,0x3E506334,0x3E8AD4C6,0x3EB8FBAF,0x3EF67A41,0x3F243516,0x3F5ACB94,0x3F91C3D3,0x3FC238D2,0x400164D2,0x402C6897,0x4065B907,0x40990B88,0x40CBEC15,0x4107DB35,0x413504F3,
];

// resolution scale table
static HCADEQUANTIZER_RANGE_TABLE_FLOAT_HEX: [u32; 16] = [
    0x3F800000,0x3F2AAAAB,0x3ECCCCCD,0x3E924925,0x3E638E39,0x3E3A2E8C,0x3E1D89D9,0x3E088889,0x3D842108,0x3D020821,0x3C810204,0x3C008081,0x3B804020,0x3B002008,0x3A801002,0x3A000801,
];

// coded resolution to max bits
static HCATBDECODER_MAX_BIT_TABLE: [u8; 16] = [
    0,2,3,3,4,4,4,4,5,6,7,8,9,10,11,12,
];

// bits used for quant codes
static HCATBDECODER_READ_BIT_TABLE: [u8; 128] = [
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    1,1,2,2,0,0,0,0,0,0,0,0,0,0,0,0,
    2,2,2,2,2,2,3,3,0,0,0,0,0,0,0,0,
    2,2,3,3,3,3,3,3,0,0,0,0,0,0,0,0,
    3,3,3,3,3,3,3,3,3,3,3,3,3,3,4,4,
    3,3,3,3,3,3,3,3,3,3,4,4,4,4,4,4,
    3,3,3,3,3,3,4,4,4,4,4,4,4,4,4,4,
    3,3,4,4,4,4,4,4,4,4,4,4,4,4,4,4,
];

// code to quantized spectrum value
static HCATBDECODER_READ_VAL_TABLE: [f32; 128] = [
    0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,
    0.0f32,0.0f32,1.0f32,-1.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,
    0.0f32,0.0f32,1.0f32,1.0f32,-1.0f32,-1.0f32,2.0f32,-2.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,
    0.0f32,0.0f32,1.0f32,-1.0f32,2.0f32,-2.0f32,3.0f32,-3.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,0.0f32,
    0.0f32,0.0f32,1.0f32,1.0f32,-1.0f32,-1.0f32,2.0f32,2.0f32,-2.0f32,-2.0f32,3.0f32,3.0f32,-3.0f32,-3.0f32,4.0f32,-4.0f32,
    0.0f32,0.0f32,1.0f32,1.0f32,-1.0f32,-1.0f32,2.0f32,2.0f32,-2.0f32,-2.0f32,3.0f32,-3.0f32,4.0f32,-4.0f32,5.0f32,-5.0f32,
    0.0f32,0.0f32,1.0f32,1.0f32,-1.0f32,-1.0f32,2.0f32,-2.0f32,3.0f32,-3.0f32,4.0f32,-4.0f32,5.0f32,-5.0f32,6.0f32,-6.0f32,
    0.0f32,0.0f32,1.0f32,-1.0f32,2.0f32,-2.0f32,3.0f32,-3.0f32,4.0f32,-4.0f32,5.0f32,-5.0f32,6.0f32,-6.0f32,7.0f32,-7.0f32,
];

// spectrum scale conversion table
static HCADECODER_SCALE_CONVERSION_TABLE_HEX: [u32; 128] = [
    0x00000000,0x32A0B051,0x32D61B5E,0x330EA43A,0x333E0F68,0x337D3E0C,0x33A8B6D5,0x33E0CCDF,0x3415C3FF,0x34478D75,0x3484F1F6,0x34B123F6,0x34EC0719,0x351D3EDA,0x355184DF,0x358B95C2,
    0x35B9FCD2,0x35F7D0DF,0x36251958,0x365BFBB8,0x36928E72,0x36C346CD,0x370218AF,0x372D583F,0x3766F85B,0x3799E046,0x37CD078C,0x3808980F,0x38360094,0x38728177,0x38A18FAF,0x38D744FD,
    0x390F6A81,0x393F179A,0x397E9E11,0x39A9A15B,0x39E2055B,0x3A16942D,0x3A48A2D8,0x3A85AAC3,0x3AB21A32,0x3AED4F30,0x3B1E196E,0x3B52A81E,0x3B8C57CA,0x3BBAFF5B,0x3BF9295A,0x3C25FED7,
    0x3C5D2D82,0x3C935A2B,0x3CC4563F,0x3D02CD87,0x3D2E4934,0x3D68396A,0x3D9AB62B,0x3DCE248C,0x3E0955EE,0x3E36FD92,0x3E73D290,0x3EA27043,0x3ED87039,0x3F1031DC,0x3F40213B,0x3F800000,
    0x3FAA8D26,0x3FE33F89,0x4017657D,0x4049B9BE,0x40866491,0x40B311C4,0x40EE9910,0x411EF532,0x4153CCF1,0x418D1ADF,0x41BC034A,0x41FA83B3,0x4226E595,0x425E60F5,0x429426FF,0x42C5672A,
    0x43038359,0x432F3B79,0x43697C38,0x439B8D3A,0x43CF4319,0x440A14D5,0x4437FBF0,0x4475257D,0x44A3520F,0x44D99D16,0x4510FA4D,0x45412C4D,0x4580B1ED,0x45AB7A3A,0x45E47B6D,0x461837F0,
    0x464AD226,0x46871F62,0x46B40AAF,0x46EFE4BA,0x471FD228,0x4754F35B,0x478DDF04,0x47BD08A4,0x47FBDFED,0x4827CD94,0x485F9613,0x4894F4F0,0x48C67991,0x49043A29,0x49302F0E,0x496AC0C7,
    0x499C6573,0x49D06334,0x4A0AD4C6,0x4A38FBAF,0x4A767A41,0x4AA43516,0x4ADACB94,0x4B11C3D3,0x4B4238D2,0x4B8164D2,0x4BAC6897,0x4BE5B907,0x4C190B88,0x4C4BEC15,0x00000000,0x00000000,
];

// intensity index to scale
static HCADECODER_INTENSITY_RATIO_TABLE_HEX: [u32; 16] = [
    0x40000000,0x3FEDB6DB,0x3FDB6DB7,0x3FC92492,0x3FB6DB6E,0x3FA49249,0x3F924925,0x3F800000,0x3F5B6DB7,0x3F36DB6E,0x3F124925,0x3EDB6DB7,0x3E924925,0x3E124925,0x00000000,0x00000000,
];

static SIN_TABLES_HEX: [[u32; 64]; 7] = [
    [
        0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,
        0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,
        0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,
        0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,
        0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,
        0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,
        0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,
        0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,0x3DA73D75,
    ],
    [
        0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,
        0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,
        0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,
        0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,
        0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,
        0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,
        0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,
        0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,0x3F7B14BE,0x3F54DB31,
    ],
    [
        0x3F7EC46D,0x3F74FA0B,0x3F61C598,0x3F45E403,0x3F7EC46D,0x3F74FA0B,0x3F61C598,0x3F45E403,
        0x3F7EC46D,0x3F74FA0B,0x3F61C598,0x3F45E403,0x3F7EC46D,0x3F74FA0B,0x3F61C598,0x3F45E403,
        0x3F7EC46D,0x3F74FA0B,0x3F61C598,0x3F45E403,0x3F7EC46D,0x3F74FA0B,0x3F61C598,0x3F45E403,
        0x3F7EC46D,0x3F74FA0B,0x3F61C598,0x3F45E403,0x3F7EC46D,0x3F74FA0B,0x3F61C598,0x3F45E403,
        0x3F7EC46D,0x3F74FA0B,0x3F61C598,0x3F45E403,0x3F7EC46D,0x3F74FA0B,0x3F61C598,0x3F45E403,
        0x3F7EC46D,0x3F74FA0B,0x3F61C598,0x3F45E403,0x3F7EC46D,0x3F74FA0B,0x3F61C598,0x3F45E403,
        0x3F7EC46D,0x3F74FA0B,0x3F61C598,0x3F45E403,0x3F7EC46D,0x3F74FA0B,0x3F61C598,0x3F45E403,
        0x3F7EC46D,0x3F74FA0B,0x3F61C598,0x3F45E403,0x3F7EC46D,0x3F74FA0B,0x3F61C598,0x3F45E403,
    ],
    [
        0x3F7FB10F,0x3F7D3AAC,0x3F7853F8,0x3F710908,0x3F676BD8,0x3F5B941A,0x3F4D9F02,0x3F3DAEF9,
        0x3F7FB10F,0x3F7D3AAC,0x3F7853F8,0x3F710908,0x3F676BD8,0x3F5B941A,0x3F4D9F02,0x3F3DAEF9,
        0x3F7FB10F,0x3F7D3AAC,0x3F7853F8,0x3F710908,0x3F676BD8,0x3F5B941A,0x3F4D9F02,0x3F3DAEF9,
        0x3F7FB10F,0x3F7D3AAC,0x3F7853F8,0x3F710908,0x3F676BD8,0x3F5B941A,0x3F4D9F02,0x3F3DAEF9,
        0x3F7FB10F,0x3F7D3AAC,0x3F7853F8,0x3F710908,0x3F676BD8,0x3F5B941A,0x3F4D9F02,0x3F3DAEF9,
        0x3F7FB10F,0x3F7D3AAC,0x3F7853F8,0x3F710908,0x3F676BD8,0x3F5B941A,0x3F4D9F02,0x3F3DAEF9,
        0x3F7FB10F,0x3F7D3AAC,0x3F7853F8,0x3F710908,0x3F676BD8,0x3F5B941A,0x3F4D9F02,0x3F3DAEF9,
        0x3F7FB10F,0x3F7D3AAC,0x3F7853F8,0x3F710908,0x3F676BD8,0x3F5B941A,0x3F4D9F02,0x3F3DAEF9,
    ],
    [
        0x3F7FEC43,0x3F7F4E6D,0x3F7E1324,0x3F7C3B28,0x3F79C79D,0x3F76BA07,0x3F731447,0x3F6ED89E,
        0x3F6A09A7,0x3F64AA59,0x3F5EBE05,0x3F584853,0x3F514D3D,0x3F49D112,0x3F41D870,0x3F396842,
        0x3F7FEC43,0x3F7F4E6D,0x3F7E1324,0x3F7C3B28,0x3F79C79D,0x3F76BA07,0x3F731447,0x3F6ED89E,
        0x3F6A09A7,0x3F64AA59,0x3F5EBE05,0x3F584853,0x3F514D3D,0x3F49D112,0x3F41D870,0x3F396842,
        0x3F7FEC43,0x3F7F4E6D,0x3F7E1324,0x3F7C3B28,0x3F79C79D,0x3F76BA07,0x3F731447,0x3F6ED89E,
        0x3F6A09A7,0x3F64AA59,0x3F5EBE05,0x3F584853,0x3F514D3D,0x3F49D112,0x3F41D870,0x3F396842,
        0x3F7FEC43,0x3F7F4E6D,0x3F7E1324,0x3F7C3B28,0x3F79C79D,0x3F76BA07,0x3F731447,0x3F6ED89E,
        0x3F6A09A7,0x3F64AA59,0x3F5EBE05,0x3F584853,0x3F514D3D,0x3F49D112,0x3F41D870,0x3F396842,
    ],
    [
        0x3F7FFB11,0x3F7FD397,0x3F7F84AB,0x3F7F0E58,0x3F7E70B0,0x3F7DABCC,0x3F7CBFC9,0x3F7BACCD,
        0x3F7A7302,0x3F791298,0x3F778BC5,0x3F75DEC6,0x3F740BDD,0x3F721352,0x3F6FF573,0x3F6DB293,
        0x3F6B4B0C,0x3F68BF3C,0x3F660F88,0x3F633C5A,0x3F604621,0x3F5D2D53,0x3F59F26A,0x3F5695E5,
        0x3F531849,0x3F4F7A1F,0x3F4BBBF8,0x3F47DE65,0x3F43E200,0x3F3FC767,0x3F3B8F3B,0x3F373A23,
        0x3F7FFB11,0x3F7FD397,0x3F7F84AB,0x3F7F0E58,0x3F7E70B0,0x3F7DABCC,0x3F7CBFC9,0x3F7BACCD,
        0x3F7A7302,0x3F791298,0x3F778BC5,0x3F75DEC6,0x3F740BDD,0x3F721352,0x3F6FF573,0x3F6DB293,
        0x3F6B4B0C,0x3F68BF3C,0x3F660F88,0x3F633C5A,0x3F604621,0x3F5D2D53,0x3F59F26A,0x3F5695E5,
        0x3F531849,0x3F4F7A1F,0x3F4BBBF8,0x3F47DE65,0x3F43E200,0x3F3FC767,0x3F3B8F3B,0x3F373A23,
    ],
    [
        0x3F7FFEC4,0x3F7FF4E6,0x3F7FE129,0x3F7FC38F,0x3F7F9C18,0x3F7F6AC7,0x3F7F2F9D,0x3F7EEA9D,
        0x3F7E9BC9,0x3F7E4323,0x3F7DE0B1,0x3F7D7474,0x3F7CFE73,0x3F7C7EB0,0x3F7BF531,0x3F7B61FC,
        0x3F7AC516,0x3F7A1E84,0x3F796E4E,0x3F78B47B,0x3F77F110,0x3F772417,0x3F764D97,0x3F756D97,
        0x3F748422,0x3F73913F,0x3F7294F8,0x3F718F57,0x3F708066,0x3F6F6830,0x3F6E46BE,0x3F6D1C1D,
        0x3F6BE858,0x3F6AAB7B,0x3F696591,0x3F6816A8,0x3F66BECC,0x3F655E0B,0x3F63F473,0x3F628210,
        0x3F6106F2,0x3F5F8327,0x3F5DF6BE,0x3F5C61C7,0x3F5AC450,0x3F591E6A,0x3F577026,0x3F55B993,
        0x3F53FAC3,0x3F5233C6,0x3F5064AF,0x3F4E8D90,0x3F4CAE79,0x3F4AC77F,0x3F48D8B3,0x3F46E22A,
        0x3F44E3F5,0x3F42DE29,0x3F40D0DA,0x3F3EBC1B,0x3F3CA003,0x3F3A7CA4,0x3F385216,0x3F36206C,
    ],
];

static COS_TABLES_HEX: [[u32; 64]; 7] = [
    [
        0xBD0A8BD4,0x3D0A8BD4,0x3D0A8BD4,0xBD0A8BD4,0x3D0A8BD4,0xBD0A8BD4,0xBD0A8BD4,0x3D0A8BD4,
        0x3D0A8BD4,0xBD0A8BD4,0xBD0A8BD4,0x3D0A8BD4,0xBD0A8BD4,0x3D0A8BD4,0x3D0A8BD4,0xBD0A8BD4,
        0x3D0A8BD4,0xBD0A8BD4,0xBD0A8BD4,0x3D0A8BD4,0xBD0A8BD4,0x3D0A8BD4,0x3D0A8BD4,0xBD0A8BD4,
        0xBD0A8BD4,0x3D0A8BD4,0x3D0A8BD4,0xBD0A8BD4,0x3D0A8BD4,0xBD0A8BD4,0xBD0A8BD4,0x3D0A8BD4,
        0x3D0A8BD4,0xBD0A8BD4,0xBD0A8BD4,0x3D0A8BD4,0xBD0A8BD4,0x3D0A8BD4,0x3D0A8BD4,0xBD0A8BD4,
        0xBD0A8BD4,0x3D0A8BD4,0x3D0A8BD4,0xBD0A8BD4,0x3D0A8BD4,0xBD0A8BD4,0xBD0A8BD4,0x3D0A8BD4,
        0xBD0A8BD4,0x3D0A8BD4,0x3D0A8BD4,0xBD0A8BD4,0x3D0A8BD4,0xBD0A8BD4,0xBD0A8BD4,0x3D0A8BD4,
        0x3D0A8BD4,0xBD0A8BD4,0xBD0A8BD4,0x3D0A8BD4,0xBD0A8BD4,0x3D0A8BD4,0x3D0A8BD4,0xBD0A8BD4,
    ],
    [
        0xBE47C5C2,0xBF0E39DA,0x3E47C5C2,0x3F0E39DA,0x3E47C5C2,0x3F0E39DA,0xBE47C5C2,0xBF0E39DA,
        0x3E47C5C2,0x3F0E39DA,0xBE47C5C2,0xBF0E39DA,0xBE47C5C2,0xBF0E39DA,0x3E47C5C2,0x3F0E39DA,
        0x3E47C5C2,0x3F0E39DA,0xBE47C5C2,0xBF0E39DA,0xBE47C5C2,0xBF0E39DA,0x3E47C5C2,0x3F0E39DA,
        0xBE47C5C2,0xBF0E39DA,0x3E47C5C2,0x3F0E39DA,0x3E47C5C2,0x3F0E39DA,0xBE47C5C2,0xBF0E39DA,
        0x3E47C5C2,0x3F0E39DA,0xBE47C5C2,0xBF0E39DA,0xBE47C5C2,0xBF0E39DA,0x3E47C5C2,0x3F0E39DA,
        0xBE47C5C2,0xBF0E39DA,0x3E47C5C2,0x3F0E39DA,0x3E47C5C2,0x3F0E39DA,0xBE47C5C2,0xBF0E39DA,
        0xBE47C5C2,0xBF0E39DA,0x3E47C5C2,0x3F0E39DA,0x3E47C5C2,0x3F0E39DA,0xBE47C5C2,0xBF0E39DA,
        0x3E47C5C2,0x3F0E39DA,0xBE47C5C2,0xBF0E39DA,0xBE47C5C2,0xBF0E39DA,0x3E47C5C2,0x3F0E39DA,
    ],
    [
        0xBDC8BD36,0xBE94A031,0xBEF15AEA,0xBF226799,0x3DC8BD36,0x3E94A031,0x3EF15AEA,0x3F226799,
        0x3DC8BD36,0x3E94A031,0x3EF15AEA,0x3F226799,0xBDC8BD36,0xBE94A031,0xBEF15AEA,0xBF226799,
        0x3DC8BD36,0x3E94A031,0x3EF15AEA,0x3F226799,0xBDC8BD36,0xBE94A031,0xBEF15AEA,0xBF226799,
        0xBDC8BD36,0xBE94A031,0xBEF15AEA,0xBF226799,0x3DC8BD36,0x3E94A031,0x3EF15AEA,0x3F226799,
        0x3DC8BD36,0x3E94A031,0x3EF15AEA,0x3F226799,0xBDC8BD36,0xBE94A031,0xBEF15AEA,0xBF226799,
        0xBDC8BD36,0xBE94A031,0xBEF15AEA,0xBF226799,0x3DC8BD36,0x3E94A031,0x3EF15AEA,0x3F226799,
        0xBDC8BD36,0xBE94A031,0xBEF15AEA,0xBF226799,0x3DC8BD36,0x3E94A031,0x3EF15AEA,0x3F226799,
        0x3DC8BD36,0x3E94A031,0x3EF15AEA,0x3F226799,0xBDC8BD36,0xBE94A031,0xBEF15AEA,0xBF226799,
    ],
    [
        0xBD48FB30,0xBE164083,0xBE78CFCC,0xBEAC7CD4,0xBEDAE880,0xBF039C3D,0xBF187FC0,0xBF2BEB4A,
        0x3D48FB30,0x3E164083,0x3E78CFCC,0x3EAC7CD4,0x3EDAE880,0x3F039C3D,0x3F187FC0,0x3F2BEB4A,
        0x3D48FB30,0x3E164083,0x3E78CFCC,0x3EAC7CD4,0x3EDAE880,0x3F039C3D,0x3F187FC0,0x3F2BEB4A,
        0xBD48FB30,0xBE164083,0xBE78CFCC,0xBEAC7CD4,0xBEDAE880,0xBF039C3D,0xBF187FC0,0xBF2BEB4A,
        0x3D48FB30,0x3E164083,0x3E78CFCC,0x3EAC7CD4,0x3EDAE880,0x3F039C3D,0x3F187FC0,0x3F2BEB4A,
        0xBD48FB30,0xBE164083,0xBE78CFCC,0xBEAC7CD4,0xBEDAE880,0xBF039C3D,0xBF187FC0,0xBF2BEB4A,
        0xBD48FB30,0xBE164083,0xBE78CFCC,0xBEAC7CD4,0xBEDAE880,0xBF039C3D,0xBF187FC0,0xBF2BEB4A,
        0x3D48FB30,0x3E164083,0x3E78CFCC,0x3EAC7CD4,0x3EDAE880,0x3F039C3D,0x3F187FC0,0x3F2BEB4A,
    ],
    [
        0xBCC90AB0,0xBD96A905,0xBDFAB273,0xBE2F10A2,0xBE605C13,0xBE888E93,0xBEA09AE5,0xBEB8442A,
        0xBECF7BCA,0xBEE63375,0xBEFC5D27,0xBF08F59B,0xBF13682A,0xBF1D7FD1,0xBF273656,0xBF3085BB,
        0x3CC90AB0,0x3D96A905,0x3DFAB273,0x3E2F10A2,0x3E605C13,0x3E888E93,0x3EA09AE5,0x3EB8442A,
        0x3ECF7BCA,0x3EE63375,0x3EFC5D27,0x3F08F59B,0x3F13682A,0x3F1D7FD1,0x3F273656,0x3F3085BB,
        0x3CC90AB0,0x3D96A905,0x3DFAB273,0x3E2F10A2,0x3E605C13,0x3E888E93,0x3EA09AE5,0x3EB8442A,
        0x3ECF7BCA,0x3EE63375,0x3EFC5D27,0x3F08F59B,0x3F13682A,0x3F1D7FD1,0x3F273656,0x3F3085BB,
        0xBCC90AB0,0xBD96A905,0xBDFAB273,0xBE2F10A2,0xBE605C13,0xBE888E93,0xBEA09AE5,0xBEB8442A,
        0xBECF7BCA,0xBEE63375,0xBEFC5D27,0xBF08F59B,0xBF13682A,0xBF1D7FD1,0xBF273656,0xBF3085BB,
    ],
    [
        0xBC490E90,0xBD16C32C,0xBD7B2B74,0xBDAFB680,0xBDE1BC2E,0xBE09CF86,0xBE22ABB6,0xBE3B6ECF,
        0xBE541501,0xBE6C9A7F,0xBE827DC0,0xBE8E9A22,0xBE9AA086,0xBEA68F12,0xBEB263EF,0xBEBE1D4A,
        0xBEC9B953,0xBED53641,0xBEE0924F,0xBEEBCBBB,0xBEF6E0CB,0xBF00E7E4,0xBF064B82,0xBF0B9A6B,
        0xBF10D3CD,0xBF15F6D9,0xBF1B02C6,0xBF1FF6CB,0xBF24D225,0xBF299415,0xBF2E3BDE,0xBF32C8C9,
        0x3C490E90,0x3D16C32C,0x3D7B2B74,0x3DAFB680,0x3DE1BC2E,0x3E09CF86,0x3E22ABB6,0x3E3B6ECF,
        0x3E541501,0x3E6C9A7F,0x3E827DC0,0x3E8E9A22,0x3E9AA086,0x3EA68F12,0x3EB263EF,0x3EBE1D4A,
        0x3EC9B953,0x3ED53641,0x3EE0924F,0x3EEBCBBB,0x3EF6E0CB,0x3F00E7E4,0x3F064B82,0x3F0B9A6B,
        0x3F10D3CD,0x3F15F6D9,0x3F1B02C6,0x3F1FF6CB,0x3F24D225,0x3F299415,0x3F2E3BDE,0x3F32C8C9,
    ],
    [
        0xBBC90F88,0xBC96C9B6,0xBCFB49BA,0xBD2FE007,0xBD621469,0xBD8A200A,0xBDA3308C,0xBDBC3AC3,
        0xBDD53DB9,0xBDEE3876,0xBE039502,0xBE1008B7,0xBE1C76DE,0xBE28DEFC,0xBE354098,0xBE419B37,
        0xBE4DEE60,0xBE5A3997,0xBE667C66,0xBE72B651,0xBE7EE6E1,0xBE8586CE,0xBE8B9507,0xBE919DDD,
        0xBE97A117,0xBE9D9E78,0xBEA395C5,0xBEA986C4,0xBEAF713A,0xBEB554EC,0xBEBB31A0,0xBEC1071E,
        0xBEC6D529,0xBECC9B8B,0xBED25A09,0xBED8106B,0xBEDDBE79,0xBEE363FA,0xBEE900B7,0xBEEE9479,
        0xBEF41F07,0xBEF9A02D,0xBEFF17B2,0xBF0242B1,0xBF04F484,0xBF07A136,0xBF0A48AD,0xBF0CEAD0,
        0xBF0F8784,0xBF121EB0,0xBF14B039,0xBF173C07,0xBF19C200,0xBF1C420C,0xBF1EBC12,0xBF212FF9,
        0xBF239DA9,0xBF26050A,0xBF286605,0xBF2AC082,0xBF2D1469,0xBF2F61A5,0xBF31A81D,0xBF33E7BC,
    ],
];

// HCA window function (KBD-like, alpha ~3.82)
static HCAIMDCT_WINDOW_FLOAT_HEX: [u32; 128] = [
    0x3A3504F0,0x3B0183B8,0x3B70C538,0x3BBB9268,0x3C04A809,0x3C308200,0x3C61284C,0x3C8B3F17,0x3CA83992,0x3CC77FBD,0x3CE91110,0x3D0677CD,0x3D198FC4,0x3D2DD35C,0x3D434643,0x3D59ECC1,
    0x3D71CBA8,0x3D85741E,0x3D92A413,0x3DA078B4,0x3DAEF522,0x3DBE1C9E,0x3DCDF27B,0x3DDE7A1D,0x3DEFB6ED,0x3E00D62B,0x3E0A2EDA,0x3E13E72A,0x3E1E00B1,0x3E287CF2,0x3E335D55,0x3E3EA321,
    0x3E4A4F75,0x3E56633F,0x3E62DF37,0x3E6FC3D1,0x3E7D1138,0x3E8563A2,0x3E8C72B7,0x3E93B561,0x3E9B2AEF,0x3EA2D26F,0x3EAAAAAB,0x3EB2B222,0x3EBAE706,0x3EC34737,0x3ECBD03D,0x3ED47F46,
    0x3EDD5128,0x3EE6425C,0x3EEF4EFF,0x3EF872D7,0x3F00D4A9,0x3F0576CA,0x3F0A1D3B,0x3F0EC548,0x3F136C25,0x3F180EF2,0x3F1CAAC2,0x3F213CA2,0x3F25C1A5,0x3F2A36E7,0x3F2E9998,0x3F32E705,
    0xBF371C9E,0xBF3B37FE,0xBF3F36F2,0xBF431780,0xBF46D7E6,0xBF4A76A4,0xBF4DF27C,0xBF514A6F,0xBF547DC5,0xBF578C03,0xBF5A74EE,0xBF5D3887,0xBF5FD707,0xBF6250DA,0xBF64A699,0xBF66D908,
    0xBF68E90E,0xBF6AD7B1,0xBF6CA611,0xBF6E5562,0xBF6FE6E7,0xBF715BEF,0xBF72B5D1,0xBF73F5E6,0xBF751D89,0xBF762E13,0xBF7728D7,0xBF780F20,0xBF78E234,0xBF79A34C,0xBF7A5397,0xBF7AF439,
    0xBF7B8648,0xBF7C0ACE,0xBF7C82C8,0xBF7CEF26,0xBF7D50CB,0xBF7DA88E,0xBF7DF737,0xBF7E3D86,0xBF7E7C2A,0xBF7EB3CC,0xBF7EE507,0xBF7F106C,0xBF7F3683,0xBF7F57CA,0xBF7F74B6,0xBF7F8DB6,
    0xBF7FA32E,0xBF7FB57B,0xBF7FC4F6,0xBF7FD1ED,0xBF7FDCAD,0xBF7FE579,0xBF7FEC90,0xBF7FF22E,0xBF7FF688,0xBF7FF9D0,0xBF7FFC32,0xBF7FFDDA,0xBF7FFEED,0xBF7FFF8F,0xBF7FFFDF,0xBF7FFFFC,
];


//--------------------------------------------------
// Checksums
//--------------------------------------------------

fn crc16_checksum(data: *const u8, size: u32) -> u16 {
    let mut sum: u16 = 0;
    let mut i: u32 = 0;
    while i < size {
        let byte = unsafe { *data.add(i as usize) } as u16;
        sum = (sum << 8) ^ HCACOMMON_CRC_MASK_TABLE[((sum >> 8) ^ byte) as usize];
        i += 1;
    }
    sum
}

//--------------------------------------------------
// Bitstream reader
//--------------------------------------------------

#[derive(Clone, Copy)]
struct ClData {
    data: *const u8,
    size: i32,
    bit: i32,
}

unsafe fn bitreader_init(br: &mut ClData, data: *const u8, size: i32) {
    br.data = data;
    br.size = size.wrapping_mul(8);
    br.bit = 0;
}

unsafe fn bitreader_peek(br: &ClData, bits_read: i32) -> u32 {
    let bit_pos = br.bit;
    let bit_rem = (bit_pos & 7) as u32;
    let bit_size = br.size;
    let mut v: u32 = 0;

    if bit_pos + bits_read > bit_size {
        return v;
    }
    if bits_read == 0 {
        return v;
    }

    let bit_offset = bits_read + bit_rem as i32;
    let bits_left = bit_size - bit_pos;
    let data = br.data;

    if bits_left >= 32 && bit_offset >= 25 {
        let mask: [u32; 8] = [
            0xFFFF_FFFF, 0x7FFF_FFFF, 0x3FFF_FFFF, 0x1FFF_FFFF,
            0x0FFF_FFFF, 0x07FF_FFFF, 0x03FF_FFFF, 0x01FF_FFFF,
        ];
        let p = data.add((bit_pos >> 3) as usize);
        v = *p as u32;
        v = (v << 8) | *p.add(1) as u32;
        v = (v << 8) | *p.add(2) as u32;
        v = (v << 8) | *p.add(3) as u32;
        v &= mask[bit_rem as usize];
        let sh = 32 - bit_rem as i32 - bits_read;
        v >>= (sh as u32) & 31;
    } else if bits_left >= 24 && bit_offset >= 17 {
        let mask: [u32; 8] = [
            0x00FF_FFFF, 0x007F_FFFF, 0x003F_FFFF, 0x001F_FFFF,
            0x000F_FFFF, 0x0007_FFFF, 0x0003_FFFF, 0x0001_FFFF,
        ];
        let p = data.add((bit_pos >> 3) as usize);
        v = *p as u32;
        v = (v << 8) | *p.add(1) as u32;
        v = (v << 8) | *p.add(2) as u32;
        v &= mask[bit_rem as usize];
        let sh = 24 - bit_rem as i32 - bits_read;
        v >>= (sh as u32) & 31;
    } else if bits_left >= 16 && bit_offset >= 9 {
        let mask: [u32; 8] = [
            0x0000_FFFF, 0x0000_7FFF, 0x0000_3FFF, 0x0000_1FFF,
            0x0000_0FFF, 0x0000_07FF, 0x0000_03FF, 0x0000_01FF,
        ];
        let p = data.add((bit_pos >> 3) as usize);
        v = *p as u32;
        v = (v << 8) | *p.add(1) as u32;
        v &= mask[bit_rem as usize];
        let sh = 16 - bit_rem as i32 - bits_read;
        v >>= (sh as u32) & 31;
    } else {
        let mask: [u32; 8] = [0xFF, 0x7F, 0x3F, 0x1F, 0x0F, 0x07, 0x03, 0x01];
        let p = data.add((bit_pos >> 3) as usize);
        v = *p as u32;
        v &= mask[bit_rem as usize];
        let sh = 8 - bit_rem as i32 - bits_read;
        v >>= (sh as u32) & 31;
    }
    v
}

unsafe fn bitreader_read(br: &mut ClData, bitsize: i32) -> u32 {
    let v = bitreader_peek(br, bitsize);
    br.bit += bitsize;
    v
}

unsafe fn bitreader_skip(br: &mut ClData, bitsize: i32) {
    br.bit += bitsize;
}

//--------------------------------------------------
// Decoder state
//--------------------------------------------------

struct StChannel {
    // HCA channel config
    ctype: u8,      // channel_type_t
    coded_count: u32,
    // subframe state
    intensity: [u8; HCA_SUBFRAMES],
    scalefactors: [u8; HCA_SAMPLES_PER_SUBFRAME],
    resolution: [u8; HCA_SAMPLES_PER_SUBFRAME],
    noises: [u8; HCA_SAMPLES_PER_SUBFRAME],
    noise_count: u32,
    valid_count: u32,
    gain: [f32; HCA_SAMPLES_PER_SUBFRAME],
    spectra: [[f32; HCA_SAMPLES_PER_SUBFRAME]; HCA_SUBFRAMES],
    temp: [f32; HCA_SAMPLES_PER_SUBFRAME],
    dct: [f32; HCA_SAMPLES_PER_SUBFRAME],
    imdct_previous: [f32; HCA_SAMPLES_PER_SUBFRAME],
    // frame state
    wave: [[f32; HCA_SAMPLES_PER_SUBFRAME]; HCA_SUBFRAMES],
}

pub struct Hca {
    // header config
    is_valid: u32,
    // hca chunk
    version: u32,
    header_size: u32,
    // fmt chunk
    channels: u32,
    sample_rate: u32,
    frame_count: u32,
    encoder_delay: u32,
    encoder_padding: u32,
    // comp/dec chunk
    frame_size: u32,
    min_resolution: u32,
    max_resolution: u32,
    track_count: u32,
    channel_config: u32,
    stereo_type: u32,
    total_band_count: u32,
    base_band_count: u32,
    stereo_band_count: u32,
    bands_per_hfr_group: u32,
    ms_stereo: u32,
    reserved: u32,
    // vbr chunk
    vbr_max_frame_size: u32,
    vbr_noise_level: u32,
    // ath chunk
    ath_type: u32,
    // loop chunk
    loop_start_frame: u32,
    loop_end_frame: u32,
    loop_start_delay: u32,
    loop_end_padding: u32,
    loop_flag: u32,
    // ciph chunk
    ciph_type: u32,
    keycode: u64,
    // rva chunk
    rva_volume: f32,
    // comm chunk
    comment_len: u32,
    comment: [u8; 256],
    // initial state
    hfr_group_count: u32,
    ath_curve: [u8; HCA_SAMPLES_PER_SUBFRAME],
    cipher_table: [u8; 256],
    // variable state
    random: u32,
    channel: [StChannel; HCA_MAX_CHANNELS],
}

impl Hca {
    fn new() -> Hca {
        // All fields are POD and zero is a valid value.
        unsafe { core::mem::zeroed() }
    }
}

impl StChannel {
    fn new() -> StChannel {
        unsafe { core::mem::zeroed() }
    }
}

pub struct HcaInfo {
    pub version: u32,
    pub header_size: u32,
    pub sampling_rate: u32,
    pub channel_count: u32,
    pub block_size: u32,
    pub block_count: u32,
    pub encoder_delay: u32,
    pub encoder_padding: u32,
    pub loop_enabled: u32,
    pub loop_start_block: u32,
    pub loop_end_block: u32,
    pub loop_start_delay: u32,
    pub loop_end_padding: u32,
    pub samples_per_block: u32,
    pub comment: *const u8,
    pub encryption_enabled: u32,
    // derived
    pub sample_count: u32,
    pub loop_start_sample: u32,
    pub loop_end_sample: u32,
    pub ambisonics: u32,
}

impl HcaInfo {
    fn new() -> HcaInfo {
        unsafe { core::mem::zeroed() }
    }
}

//--------------------------------------------------
// Public API / utilities
//--------------------------------------------------

pub unsafe fn clhca_is_our_file(data: *const u8, size: u32) -> i32 {
    if data.is_null() || size < 0x08 {
        return HCA_ERROR_PARAMS;
    }

    let mut br = ClData { data, size: 0, bit: 0 };
    bitreader_init(&mut br, data, 8);
    let mut header_size: u32 = 0;

    if (bitreader_peek(&br, 32) & HCA_MASK) == 0x4843_4100 {
        // "HCA\0"
        bitreader_skip(&mut br, 32 + 16);
        header_size = bitreader_read(&mut br, 16);
    }

    if header_size == 0 {
        return HCA_ERROR_HEADER;
    }
    header_size as i32
}

pub unsafe fn clhca_clear(hca: &mut Hca) {
    *hca = Hca::new();
}

pub unsafe fn clhca_done(hca: &mut Hca) {
    hca.is_valid = 0;
}

pub fn clhca_sizeof() -> i32 {
    core::mem::size_of::<Hca>() as i32
}

pub unsafe fn clhca_new() -> *mut Hca {
    Box::into_raw(Box::new(Hca::new()))
}

pub unsafe fn clhca_delete(hca: *mut Hca) {
    if !hca.is_null() {
        drop(Box::from_raw(hca));
    }
}

pub unsafe fn clhca_get_info(hca: &Hca, info: &mut HcaInfo) -> i32 {
    if hca.is_valid == 0 {
        return HCA_ERROR_PARAMS;
    }

    info.version = hca.version;
    info.header_size = hca.header_size;
    info.sampling_rate = hca.sample_rate;
    info.channel_count = hca.channels;
    info.block_size = hca.frame_size;
    info.block_count = hca.frame_count;
    info.encoder_delay = hca.encoder_delay;
    info.encoder_padding = hca.encoder_padding;
    info.loop_enabled = hca.loop_flag;
    info.loop_start_block = hca.loop_start_frame;
    info.loop_end_block = hca.loop_end_frame;
    info.loop_start_delay = hca.loop_start_delay;
    info.loop_end_padding = hca.loop_end_padding;
    info.samples_per_block = HCA_SAMPLES_PER_FRAME as u32;
    info.comment = hca.comment.as_ptr();
    info.encryption_enabled = if hca.ciph_type == 56 { 1 } else { 0 };

    // derived
    info.sample_count = info
        .block_count
        .wrapping_mul(info.samples_per_block)
        .wrapping_sub(info.encoder_delay)
        .wrapping_sub(info.encoder_padding);
    info.loop_start_sample = info
        .loop_start_block
        .wrapping_mul(info.samples_per_block)
        .wrapping_sub(info.encoder_delay)
        .wrapping_add(info.loop_start_delay);
    info.loop_end_sample = info
        .loop_end_block
        .wrapping_mul(info.samples_per_block)
        .wrapping_sub(info.encoder_delay)
        .wrapping_add(info.samples_per_block.wrapping_sub(info.loop_end_padding));

    info.ambisonics = if (hca.channel_config & HCA_CHANNEL_CONFIG_FLAG_AMBISONICS) != 0 {
        1
    } else {
        0
    };

    HCA_RESULT_OK
}

pub unsafe fn clhca_read_samples16(hca: &Hca, samples: *mut i16) {
    let scale_f = 32768.0f32;
    let mut out = samples;

    for i in 0..HCA_SUBFRAMES {
        for j in 0..HCA_SAMPLES_PER_SUBFRAME {
            for k in 0..hca.channels as usize {
                let f = hca.channel[k].wave[i][j];
                let mut s = (f * scale_f) as i32;
                if s > 32767 {
                    s = 32767;
                } else if s < -32768 {
                    s = -32768;
                }
                *out = s as i16;
                out = out.add(1);
            }
        }
    }
}

pub unsafe fn clhca_read_samples(hca: &Hca, samples: *mut f32) {
    let mut out = samples;

    // interleave output
    for i in 0..HCA_SUBFRAMES {
        for j in 0..HCA_SAMPLES_PER_SUBFRAME {
            for k in 0..hca.channels as usize {
                *out = hca.channel[k].wave[i][j];
                out = out.add(1);
            }
        }
    }
}

//--------------------------------------------------
// ATH
//--------------------------------------------------

fn ath_init0(ath_curve: &mut [u8; HCA_SAMPLES_PER_SUBFRAME]) {
    for v in ath_curve.iter_mut() {
        *v = 0;
    }
}

fn ath_init1(ath_curve: &mut [u8; HCA_SAMPLES_PER_SUBFRAME], sample_rate: u32) {
    let mut acc: u32 = 0;

    for i in 0..HCA_SAMPLES_PER_SUBFRAME {
        acc = acc.wrapping_add(sample_rate);
        let index = acc >> 13;

        if index >= 654 {
            for j in i..HCA_SAMPLES_PER_SUBFRAME {
                ath_curve[j] = 0xFF;
            }
            break;
        }
        ath_curve[i] = ATH_BASE_CURVE[index as usize];
    }
}

fn ath_init(ath_curve: &mut [u8; HCA_SAMPLES_PER_SUBFRAME], atype: u32, sample_rate: u32) -> i32 {
    match atype {
        0 => {
            ath_init0(ath_curve);
        }
        1 => {
            ath_init1(ath_curve, sample_rate);
        }
        _ => return HCA_ERROR_HEADER,
    }
    HCA_RESULT_OK
}

//--------------------------------------------------
// Encryption
//--------------------------------------------------

unsafe fn cipher_decrypt(cipher_table: &[u8; 256], data: *mut u8, size: i32) {
    let mut i: i32 = 0;
    while i < size {
        let p = data.add(i as usize);
        *p = cipher_table[*p as usize];
        i += 1;
    }
}

fn cipher_init0(cipher_table: &mut [u8; 256]) {
    for i in 0..256 {
        cipher_table[i] = i as u8;
    }
}

fn cipher_init1(cipher_table: &mut [u8; 256]) {
    let mul: i32 = 13;
    let add: i32 = 11;
    let mut v: i32 = 0;

    // keyless encryption (rare)
    for i in 1..256 - 1 {
        v = (v * mul + add) & 0xFF;
        if v == 0 || v == 0xFF {
            v = (v * mul + add) & 0xFF;
        }
        cipher_table[i] = v as u8;
    }
    cipher_table[0] = 0;
    cipher_table[0xFF] = 0xFF;
}

fn cipher_init56_create_table(r: &mut [u8; 16], key: u8) {
    let mul: i32 = (((key & 1) << 3) | 5) as i32;
    let add: i32 = ((key & 0xE) | 1) as i32;
    let mut key = (key >> 4) as i32;

    for i in 0..16 {
        key = (key * mul + add) & 0xF;
        r[i] = key as u8;
    }
}

fn cipher_init56(cipher_table: &mut [u8; 256], keycode_in: u64) {
    let mut kc = [0u8; 8];
    let mut seed = [0u8; 16];
    let mut base = [0u8; 256];
    let mut base_r = [0u8; 16];
    let mut base_c = [0u8; 16];
    let mut keycode = keycode_in;

    // keycode = keycode - 1
    if keycode != 0 {
        keycode = keycode.wrapping_sub(1);
    }

    // init keycode table
    for r in 0..(8 - 1) {
        kc[r] = (keycode & 0xFF) as u8;
        keycode >>= 8;
    }

    // init seed table
    seed[0x00] = kc[1];
    seed[0x01] = kc[1] ^ kc[6];
    seed[0x02] = kc[2] ^ kc[3];
    seed[0x03] = kc[2];
    seed[0x04] = kc[2] ^ kc[1];
    seed[0x05] = kc[3] ^ kc[4];
    seed[0x06] = kc[3];
    seed[0x07] = kc[3] ^ kc[2];
    seed[0x08] = kc[4] ^ kc[5];
    seed[0x09] = kc[4];
    seed[0x0A] = kc[4] ^ kc[3];
    seed[0x0B] = kc[5] ^ kc[6];
    seed[0x0C] = kc[5];
    seed[0x0D] = kc[5] ^ kc[4];
    seed[0x0E] = kc[6] ^ kc[1];
    seed[0x0F] = kc[6];

    // init base table
    cipher_init56_create_table(&mut base_r, kc[0]);
    for r in 0..16 {
        cipher_init56_create_table(&mut base_c, seed[r]);
        let nb = base_r[r] << 4;
        for c in 0..16 {
            base[r * 16 + c] = nb | base_c[c]; // combine nibbles
        }
    }

    // final shuffle table
    {
        let mut x: u32 = 0;
        let mut pos: usize = 1;

        for _ in 0..256 {
            x = (x + 17) & 0xFF;
            if base[x as usize] != 0 && base[x as usize] != 0xFF {
                cipher_table[pos] = base[x as usize];
                pos += 1;
            }
        }
        cipher_table[0] = 0;
        cipher_table[0xFF] = 0xFF;
    }
}

fn cipher_init(cipher_table: &mut [u8; 256], ctype: u32, keycode: u64) -> i32 {
    let mut ctype = ctype;
    if ctype == 56 && keycode == 0 {
        ctype = 0;
    }

    match ctype {
        0 => cipher_init0(cipher_table),
        1 => cipher_init1(cipher_table),
        56 => cipher_init56(cipher_table, keycode),
        _ => return HCA_ERROR_HEADER,
    }
    HCA_RESULT_OK
}

//--------------------------------------------------
// Parse
//--------------------------------------------------

fn header_ceil2(a: u32, b: u32) -> u32 {
    if b < 1 {
        return 0;
    }
    (a / b) + if a % b != 0 { 1 } else { 0 }
}

// HCAHeaderUtility_GetElementTypes
fn setup_channel_types(
    channels: u32,
    track_count: u32,
    channel_config: u32,
    stereo_band_count: u32,
    channel_types: &mut [u8; HCA_MAX_CHANNELS],
) {
    let channels_per_track = channels / track_count;

    if stereo_band_count > 0 && channels_per_track > 1 {
        for i in 0..track_count {
            let ct = (i * channels_per_track) as usize;

            match channels_per_track {
                2 => {
                    channel_types[ct] = STEREO_PRIMARY;
                    channel_types[ct + 1] = STEREO_SECONDARY;
                }
                3 => {
                    channel_types[ct] = STEREO_PRIMARY;
                    channel_types[ct + 1] = STEREO_SECONDARY;
                    channel_types[ct + 2] = DISCRETE;
                }
                4 => {
                    channel_types[ct] = STEREO_PRIMARY;
                    channel_types[ct + 1] = STEREO_SECONDARY;
                    if channel_config == 0 {
                        channel_types[ct + 2] = STEREO_PRIMARY;
                        channel_types[ct + 3] = STEREO_SECONDARY;
                    } else {
                        channel_types[ct + 2] = DISCRETE;
                        channel_types[ct + 3] = DISCRETE;
                    }
                }
                5 => {
                    channel_types[ct] = STEREO_PRIMARY;
                    channel_types[ct + 1] = STEREO_SECONDARY;
                    channel_types[ct + 2] = DISCRETE;
                    if channel_config <= 2 {
                        channel_types[ct + 3] = STEREO_PRIMARY;
                        channel_types[ct + 4] = STEREO_SECONDARY;
                    } else {
                        channel_types[ct + 3] = DISCRETE;
                        channel_types[ct + 4] = DISCRETE;
                    }
                }
                6 => {
                    channel_types[ct] = STEREO_PRIMARY;
                    channel_types[ct + 1] = STEREO_SECONDARY;
                    channel_types[ct + 2] = DISCRETE;
                    channel_types[ct + 3] = DISCRETE;
                    channel_types[ct + 4] = STEREO_PRIMARY;
                    channel_types[ct + 5] = STEREO_SECONDARY;
                }
                7 => {
                    channel_types[ct] = STEREO_PRIMARY;
                    channel_types[ct + 1] = STEREO_SECONDARY;
                    channel_types[ct + 2] = DISCRETE;
                    channel_types[ct + 3] = DISCRETE;
                    channel_types[ct + 4] = STEREO_PRIMARY;
                    channel_types[ct + 5] = STEREO_SECONDARY;
                    channel_types[ct + 6] = DISCRETE;
                }
                8 => {
                    channel_types[ct] = STEREO_PRIMARY;
                    channel_types[ct + 1] = STEREO_SECONDARY;
                    channel_types[ct + 2] = DISCRETE;
                    channel_types[ct + 3] = DISCRETE;
                    channel_types[ct + 4] = STEREO_PRIMARY;
                    channel_types[ct + 5] = STEREO_SECONDARY;
                    channel_types[ct + 6] = STEREO_PRIMARY;
                    channel_types[ct + 7] = STEREO_SECONDARY;
                }
                _ => {
                    // all 0 (DISCRETE), as in the reference implementation
                    for _ch in 0..channels_per_track {
                        channel_types[i as usize] = DISCRETE;
                    }
                }
            }
        }
    }
}

pub unsafe fn clhca_decode_header(hca: &mut Hca, data: *const u8, size_in: u32) -> i32 {
    if data.is_null() {
        return HCA_ERROR_PARAMS;
    }

    hca.is_valid = 0;

    if size_in < 0x08 {
        return HCA_ERROR_PARAMS;
    }

    let mut size = size_in;
    let mut br = ClData { data, size: 0, bit: 0 };
    bitreader_init(&mut br, data, size as i32);

    // read header chunks (in HCA chunks must follow a fixed order)

    // HCA base header
    if (bitreader_peek(&br, 32) & HCA_MASK) == 0x4843_4100 {
        // "HCA\0"
        bitreader_skip(&mut br, 32);
        hca.version = bitreader_read(&mut br, 16);
        hca.header_size = bitreader_read(&mut br, 16);

        if hca.version != HCA_VERSION_V101
            && hca.version != HCA_VERSION_V102
            && hca.version != HCA_VERSION_V103
            && hca.version != HCA_VERSION_V200
            && hca.version != HCA_VERSION_V300
        {
            return HCA_ERROR_HEADER;
        }

        if size < hca.header_size {
            return HCA_ERROR_PARAMS;
        }

        if crc16_checksum(data, hca.header_size) != 0 {
            return HCA_ERROR_CHECKSUM;
        }

        size -= 0x08;
    } else {
        return HCA_ERROR_HEADER;
    }

    // format info
    if size >= 0x10 && (bitreader_peek(&br, 32) & HCA_MASK) == 0x666D_7400 {
        // "fmt\0"
        bitreader_skip(&mut br, 32);
        hca.channels = bitreader_read(&mut br, 8);
        hca.sample_rate = bitreader_read(&mut br, 24);
        hca.frame_count = bitreader_read(&mut br, 32);
        hca.encoder_delay = bitreader_read(&mut br, 16);
        hca.encoder_padding = bitreader_read(&mut br, 16);

        if !(hca.channels >= HCA_MIN_CHANNELS && (hca.channels as usize) <= HCA_MAX_CHANNELS) {
            return HCA_ERROR_HEADER;
        }

        if hca.frame_count == 0 {
            return HCA_ERROR_HEADER;
        }

        if !(hca.sample_rate >= HCA_MIN_SAMPLE_RATE && hca.sample_rate <= HCA_MAX_SAMPLE_RATE) {
            return HCA_ERROR_HEADER;
        }

        size -= 0x10;
    } else {
        return HCA_ERROR_HEADER;
    }

    // compression (v2.0) or decode (v1.x) info
    if size >= 0x10 && (bitreader_peek(&br, 32) & HCA_MASK) == 0x636F_6D70 {
        // "comp"
        bitreader_skip(&mut br, 32);
        hca.frame_size = bitreader_read(&mut br, 16);
        hca.min_resolution = bitreader_read(&mut br, 8);
        hca.max_resolution = bitreader_read(&mut br, 8);
        hca.track_count = bitreader_read(&mut br, 8);
        hca.channel_config = bitreader_read(&mut br, 8);
        hca.total_band_count = bitreader_read(&mut br, 8);
        hca.base_band_count = bitreader_read(&mut br, 8);
        hca.stereo_band_count = bitreader_read(&mut br, 8);
        hca.bands_per_hfr_group = bitreader_read(&mut br, 8);
        hca.ms_stereo = bitreader_read(&mut br, 8);
        hca.reserved = bitreader_read(&mut br, 8);

        size -= 0x10;
    } else if size >= 0x0c && (bitreader_peek(&br, 32) & HCA_MASK) == 0x6465_6300 {
        // "dec\0"
        bitreader_skip(&mut br, 32);
        hca.frame_size = bitreader_read(&mut br, 16);
        hca.min_resolution = bitreader_read(&mut br, 8);
        hca.max_resolution = bitreader_read(&mut br, 8);
        hca.total_band_count = bitreader_read(&mut br, 8) + 1;
        hca.base_band_count = bitreader_read(&mut br, 8) + 1;
        hca.track_count = bitreader_read(&mut br, 4);
        hca.channel_config = bitreader_read(&mut br, 4);
        hca.stereo_type = bitreader_read(&mut br, 8);

        if hca.stereo_type == 0 {
            hca.base_band_count = hca.total_band_count;
        }
        hca.stereo_band_count = hca.total_band_count.wrapping_sub(hca.base_band_count);
        hca.bands_per_hfr_group = 0;

        size -= 0x0c;
    } else {
        return HCA_ERROR_HEADER;
    }

    // VBR (variable bit rate) info
    if size >= 0x08 && (bitreader_peek(&br, 32) & HCA_MASK) == 0x7662_7200 {
        // "vbr\0"
        bitreader_skip(&mut br, 32);
        hca.vbr_max_frame_size = bitreader_read(&mut br, 16);
        hca.vbr_noise_level = bitreader_read(&mut br, 16);

        if !(hca.frame_size == 0 && hca.vbr_max_frame_size > 8 && hca.vbr_max_frame_size <= 0x1FF) {
            return HCA_ERROR_HEADER;
        }

        size -= 0x08;
    } else {
        // removed in v2.0, probably unused in v1.x
        hca.vbr_max_frame_size = 0;
        hca.vbr_noise_level = 0;
    }

    // ATH (Absolute Threshold of Hearing) info
    if size >= 0x06 && (bitreader_peek(&br, 32) & HCA_MASK) == 0x6174_6800 {
        // "ath\0"
        bitreader_skip(&mut br, 32);
        hca.ath_type = bitreader_read(&mut br, 16);
    } else {
        // removed in v2.0, default in v1.x
        hca.ath_type = if hca.version < HCA_VERSION_V200 { 1 } else { 0 };
    }

    // loop info
    if size >= 0x10 && (bitreader_peek(&br, 32) & HCA_MASK) == 0x6C6F_6F70 {
        // "loop"
        bitreader_skip(&mut br, 32);
        hca.loop_start_frame = bitreader_read(&mut br, 32);
        hca.loop_end_frame = bitreader_read(&mut br, 32);
        hca.loop_start_delay = bitreader_read(&mut br, 16);
        hca.loop_end_padding = bitreader_read(&mut br, 16);

        hca.loop_flag = 1;

        if !(hca.loop_start_frame <= hca.loop_end_frame && hca.loop_end_frame < hca.frame_count) {
            return HCA_ERROR_HEADER;
        }

        size -= 0x10;
    } else {
        hca.loop_start_frame = 0;
        hca.loop_end_frame = 0;
        hca.loop_start_delay = 0;
        hca.loop_end_padding = 0;

        hca.loop_flag = 0;
    }

    // cipher/encryption info
    if size >= 0x06 && (bitreader_peek(&br, 32) & HCA_MASK) == 0x6369_7068 {
        // "ciph"
        bitreader_skip(&mut br, 32);
        hca.ciph_type = bitreader_read(&mut br, 16);

        if !(hca.ciph_type == 0 || hca.ciph_type == 1 || hca.ciph_type == 56) {
            return HCA_ERROR_HEADER;
        }

        size -= 0x06;
    } else {
        hca.ciph_type = 0;
    }

    // RVA (relative volume adjustment) info
    if size >= 0x08 && (bitreader_peek(&br, 32) & HCA_MASK) == 0x7276_6100 {
        // "rva\0"
        bitreader_skip(&mut br, 32);
        hca.rva_volume = f32::from_bits(bitreader_read(&mut br, 32));

        size -= 0x08;
    } else {
        hca.rva_volume = 1.0f32; // encoder volume setting is pre-applied to data
    }

    // comment
    if size >= 0x05 && (bitreader_peek(&br, 32) & HCA_MASK) == 0x636F_6D6D {
        // "comm"
        bitreader_skip(&mut br, 32);
        hca.comment_len = bitreader_read(&mut br, 8);

        if hca.comment_len > size {
            return HCA_ERROR_HEADER;
        }

        let mut i: u32 = 0;
        while i < hca.comment_len {
            hca.comment[i as usize] = bitreader_read(&mut br, 8) as u8;
            i += 1;
        }
        hca.comment[hca.comment_len as usize] = 0;

        size -= 0x05 + hca.comment_len;
    } else {
        hca.comment_len = 0;
    }

    // padding info (fills up to header_size, sans checksum)
    if size >= 0x04 && (bitreader_peek(&br, 32) & HCA_MASK) == 0x7061_6400 {
        size -= size - 0x02;
    }

    // extra validations
    if !(hca.frame_size >= HCA_MIN_FRAME_SIZE && hca.frame_size <= HCA_MAX_FRAME_SIZE) {
        return HCA_ERROR_HEADER;
    }

    if hca.version <= HCA_VERSION_V200 {
        if hca.min_resolution != 1 || hca.max_resolution != 15 {
            return HCA_ERROR_HEADER;
        }
    } else if hca.min_resolution > hca.max_resolution || hca.max_resolution > 15 {
        return HCA_ERROR_HEADER;
    }

    // init state
    if hca.track_count == 0 {
        hca.track_count = 1;
    }

    if hca.track_count > hca.channels {
        return HCA_ERROR_HEADER;
    }

    // encoded coefs (up to 128) depend on the encoder's "cutoff" hz option
    if hca.total_band_count as usize > HCA_SAMPLES_PER_SUBFRAME
        || hca.total_band_count == 0
        || hca.base_band_count.wrapping_add(hca.stereo_band_count) > hca.total_band_count
        || hca.base_band_count.wrapping_add(hca.stereo_band_count) == 0
        || hca.stereo_band_count > hca.base_band_count
        || hca.bands_per_hfr_group as usize > HCA_SAMPLES_PER_SUBFRAME
    {
        return HCA_ERROR_HEADER;
    }

    // leftover upper HRF coefs to groups
    hca.hfr_group_count = header_ceil2(
        hca.total_band_count.wrapping_sub(hca.base_band_count).wrapping_sub(hca.stereo_band_count),
        hca.bands_per_hfr_group,
    );

    // init channels
    {
        let mut channel_types = [0u8; HCA_MAX_CHANNELS];

        setup_channel_types(
            hca.channels,
            hca.track_count,
            hca.channel_config,
            hca.stereo_band_count,
            &mut channel_types,
        );

        for ch in hca.channel.iter_mut() {
            *ch = StChannel::new();
        }

        for i in 0..hca.channels as usize {
            let ch_stereo_band_count = if channel_types[i] == STEREO_SECONDARY {
                0
            } else {
                hca.stereo_band_count
            };

            hca.channel[i].coded_count = hca.base_band_count + ch_stereo_band_count;
            hca.channel[i].ctype = channel_types[i];
        }
    }

    hca.random = HCA_DEFAULT_RANDOM;

    let res = ath_init(&mut hca.ath_curve, hca.ath_type, hca.sample_rate);
    if res < 0 {
        return res;
    }

    let res = cipher_init(&mut hca.cipher_table, hca.ciph_type, hca.keycode);
    if res < 0 {
        return res;
    }

    if hca.ms_stereo != 0 {
        return HCA_ERROR_HEADER;
    }

    hca.is_valid = 1;

    HCA_RESULT_OK
}

pub unsafe fn clhca_set_key(hca: &mut Hca, keycode: u64) {
    hca.keycode = keycode;

    // May be called even if the header wasn't parsed yet (used during DecodeHeader
    // ciph init). If the header was already parsed, reinitialize the cipher table.
    if hca.is_valid != 0 {
        cipher_init(&mut hca.cipher_table, hca.ciph_type, hca.keycode);
    }
}

//--------------------------------------------------
// Decode 1st step
//--------------------------------------------------

unsafe fn unpack_scalefactors(
    ch: &mut StChannel,
    br: &mut ClData,
    hfr_group_count: u32,
    version: u32,
) -> i32 {
    let cs_count = ch.coded_count as usize;
    let hs_count: usize;
    let sf_count: usize;

    let delta_bits = bitreader_read(br, 3) as u8;

    // added in v3.0
    if ch.ctype == STEREO_SECONDARY || hfr_group_count == 0 || version <= HCA_VERSION_V200 {
        hs_count = 0;
    } else {
        hs_count = hfr_group_count as usize;
    }
    sf_count = cs_count + hs_count;

    if delta_bits >= 6 {
        // fixed scalefactors
        let mut value = bitreader_read(br, 6) as u8;

        ch.scalefactors[0] = value;
        for i in 1..sf_count {
            value = bitreader_read(br, 6) as u8;
            ch.scalefactors[i] = value;
        }
    } else if delta_bits > 0 {
        // delta scalefactors
        let expected_delta = ((1u32 << delta_bits) - 1) as i32;
        let mut value = bitreader_read(br, 6) as i32;

        ch.scalefactors[0] = value as u8;
        for i in 1..sf_count {
            let delta = bitreader_read(br, delta_bits as i32) as i32;

            if delta == expected_delta {
                value = bitreader_read(br, 6) as i32; // encoded
            } else {
                // may happen with bad keycodes, scalefactors must be 6b indexes
                let scalefactor_test = value + (delta - (expected_delta >> 1));
                if scalefactor_test < 0 || scalefactor_test >= 64 {
                    return HCA_ERROR_UNPACK;
                }

                value = value - (expected_delta >> 1) + delta;
                value &= 0x3F;
            }
            ch.scalefactors[i] = value as u8;
        }
    } else {
        // no scalefactors
        for i in 0..HCA_SAMPLES_PER_SUBFRAME {
            ch.scalefactors[i] = 0;
        }
    }

    // copy v3.0 HFR scalefactors towards the end
    let mut i = hs_count;
    while i > 0 {
        ch.scalefactors[HCA_SAMPLES_PER_SUBFRAME - 1 - hs_count + i] =
            ch.scalefactors[cs_count - 1 + i];
        i -= 1;
    }

    HCA_RESULT_OK
}

unsafe fn unpack_intensity(
    ch: &mut StChannel,
    br: &mut ClData,
    hfr_group_count: u32,
    version: u32,
) -> i32 {
    if ch.ctype == STEREO_SECONDARY {
        // read subframe intensity for channel pair
        if version <= HCA_VERSION_V200 {
            let value = bitreader_peek(br, 4) as u8;

            ch.intensity[0] = value;
            if value < 15 {
                bitreader_skip(br, 4);
                for i in 1..HCA_SUBFRAMES {
                    ch.intensity[i] = bitreader_read(br, 4) as u8;
                }
            }
        } else {
            let value = bitreader_peek(br, 4) as u8;

            if value < 15 {
                bitreader_skip(br, 4);

                let delta_bits = bitreader_read(br, 2) as u8; // +1

                ch.intensity[0] = value;
                if delta_bits == 3 {
                    // fixed intensities
                    for i in 1..HCA_SUBFRAMES {
                        ch.intensity[i] = bitreader_read(br, 4) as u8;
                    }
                } else {
                    // delta intensities
                    let bmax = ((2u32 << delta_bits) - 1) as i32;
                    let bits = delta_bits as i32 + 1;
                    let mut value = value as i32;

                    for i in 1..HCA_SUBFRAMES {
                        let delta = bitreader_read(br, bits) as i32;
                        if delta == bmax {
                            value = bitreader_read(br, 4) as i32; // encoded
                        } else {
                            // C stores into an unsigned char, so the result wraps mod 256
                            value = (value - (bmax >> 1) + delta) & 0xFF;
                            if value > 15 {
                                return HCA_ERROR_UNPACK;
                            }
                        }

                        ch.intensity[i] = value as u8;
                    }
                }
            } else {
                bitreader_skip(br, 4);
                for i in 0..HCA_SUBFRAMES {
                    ch.intensity[i] = 7;
                }
            }
        }
    } else if version <= HCA_VERSION_V200 {
        // read high frequency scalefactors (v3.0 derives them in unpack_scalefactors)
        let base = HCA_SAMPLES_PER_SUBFRAME - hfr_group_count as usize;
        for i in 0..hfr_group_count as usize {
            ch.scalefactors[base + i] = bitreader_read(br, 6) as u8;
        }
    }

    HCA_RESULT_OK
}

fn calculate_resolution(
    ch: &mut StChannel,
    packed_noise_level: u32,
    ath_curve: &[u8; HCA_SAMPLES_PER_SUBFRAME],
    min_resolution: u32,
    max_resolution: u32,
) {
    let cr_count = ch.coded_count as usize;
    let mut noise_count: u32 = 0;
    let mut valid_count: u32 = 0;

    for i in 0..cr_count {
        let mut new_resolution: u8 = 0;
        let scalefactor = ch.scalefactors[i];

        if scalefactor > 0 {
            let noise_level = ath_curve[i] as i32
                + ((packed_noise_level.wrapping_add(i as u32) >> 8) as i32);
            let curve_position = noise_level + 1 - ((5 * scalefactor as i32) >> 1);

            if curve_position < 0 {
                new_resolution = 15;
            } else if curve_position <= 65 {
                new_resolution = HCADECODER_INVERT_TABLE[curve_position as usize];
            } else {
                new_resolution = 0;
            }

            if new_resolution as u32 > max_resolution {
                new_resolution = max_resolution as u8;
            } else if (new_resolution as u32) < min_resolution {
                new_resolution = min_resolution as u8;
            }

            // save resolution 0 indexes (from 0..N), and regular indexes (from N..0)
            if new_resolution < 1 {
                ch.noises[noise_count as usize] = i as u8;
                noise_count += 1;
            } else {
                ch.noises[HCA_SAMPLES_PER_SUBFRAME - 1 - valid_count as usize] = i as u8;
                valid_count += 1;
            }
        }
        ch.resolution[i] = new_resolution;
    }

    ch.noise_count = noise_count;
    ch.valid_count = valid_count;

    for i in cr_count..HCA_SAMPLES_PER_SUBFRAME {
        ch.resolution[i] = 0;
    }
}

// HCADequantizer_CalculateGain
fn calculate_gain(ch: &mut StChannel) {
    let cg_count = ch.coded_count as usize;

    for i in 0..cg_count {
        let scalefactor_scale =
            f32::from_bits(HCADEQUANTIZER_SCALING_TABLE_FLOAT_HEX[ch.scalefactors[i] as usize]);
        let resolution_scale =
            f32::from_bits(HCADEQUANTIZER_RANGE_TABLE_FLOAT_HEX[ch.resolution[i] as usize]);
        ch.gain[i] = scalefactor_scale * resolution_scale;
    }
}

//--------------------------------------------------
// Decode 2nd step (spectral coefficients)
//--------------------------------------------------

unsafe fn dequantize_coefficients(ch: &mut StChannel, br: &mut ClData, subframe: usize) {
    let cc_count = ch.coded_count as usize;

    for i in 0..cc_count {
        let resolution = ch.resolution[i];
        let bits = HCATBDECODER_MAX_BIT_TABLE[resolution as usize] as i32;
        let code = bitreader_read(br, bits);

        let qc: f32;

        if resolution > 7 {
            // sign-magnitude form (lowest bit = sign)
            let signed_code =
                (1i32.wrapping_sub(((code & 1) << 1) as i32)) * ((code >> 1) as i32);
            if signed_code == 0 {
                bitreader_skip(br, -1); // zero uses one less bit since it has no sign
            }
            qc = signed_code as f32;
        } else {
            // prefix codebooks for lower resolutions
            let index = (resolution as usize) * 16 + code as usize;
            let skip = HCATBDECODER_READ_BIT_TABLE[index] as i32 - bits;
            bitreader_skip(br, skip);
            qc = HCATBDECODER_READ_VAL_TABLE[index];
        }

        ch.spectra[subframe][i] = ch.gain[i] * qc;
    }

    for i in cc_count..HCA_SAMPLES_PER_SUBFRAME {
        ch.spectra[subframe][i] = 0.0f32;
    }
}

//--------------------------------------------------
// Decode 3rd step (band reconstruction)
//--------------------------------------------------

unsafe fn reconstruct_noise(
    ch: &mut StChannel,
    min_resolution: u32,
    ms_stereo: u32,
    random_p: &mut u32,
    subframe: usize,
) {
    if min_resolution > 0 {
        return;
    }
    if ch.valid_count == 0 || ch.noise_count == 0 {
        return;
    }
    if !(ms_stereo == 0 || ch.ctype == STEREO_PRIMARY) {
        return;
    }

    let mut random = *random_p;

    for i in 0..ch.noise_count as usize {
        random = 0x343FDu32
            .wrapping_mul(random)
            .wrapping_add(0x269EC3);
        let random_out = (random >> 16) & 0x7FFF;

        let random_index = HCA_SAMPLES_PER_SUBFRAME - ch.valid_count as usize
            + (((random_out as usize) * (ch.valid_count as usize)) >> 15);

        // points to next resolution 0 index and random non-resolution 0 index
        let target_index = ch.noises[i] as usize;
        let source_index = ch.noises[random_index] as usize;

        // get final scale index
        let sf_target = ch.scalefactors[target_index] as i32;
        let sf_source = ch.scalefactors[source_index] as i32;

        let mut sc_index = sf_target - sf_source + 62;
        sc_index &= !(sc_index >> 31); // clamp 0..62

        ch.spectra[subframe][target_index] = f32::from_bits(
            HCADECODER_SCALE_CONVERSION_TABLE_HEX[sc_index as usize],
        ) * ch.spectra[subframe][source_index];
    }

    *random_p = random;
}

unsafe fn reconstruct_high_frequency(
    ch: &mut StChannel,
    hfr_group_count: u32,
    bands_per_hfr_group: u32,
    stereo_band_count: u32,
    base_band_count: u32,
    total_band_count: u32,
    version: u32,
    subframe: usize,
) {
    if bands_per_hfr_group == 0 {
        return;
    }
    if ch.ctype == STEREO_SECONDARY {
        return;
    }

    let start_band = (stereo_band_count + base_band_count) as i32;
    let mut highband = start_band;
    let mut lowband = start_band - 1;
    let hfr_base = HCA_SAMPLES_PER_SUBFRAME - hfr_group_count as usize;

    let group_limit: i32 = if version <= HCA_VERSION_V200 {
        hfr_group_count as i32
    } else {
        (hfr_group_count as i32) >> 1
    };

    for group in 0..hfr_group_count as usize {
        // v3.0 moves lowband towards 0 only until group reaches limit
        let lowband_adjust: i32 = if (group as i32) < group_limit { -1 } else { 1 };

        if highband >= total_band_count as i32 || lowband < 0 {
            break;
        }

        for _i in 0..bands_per_hfr_group as usize {
            if highband >= total_band_count as i32 || lowband < 0 {
                break;
            }

            let mut sc_index = ch.scalefactors[hfr_base + group] as i32
                - ch.scalefactors[lowband as usize] as i32
                + 63;
            sc_index &= !(sc_index >> 31);

            ch.spectra[subframe][highband as usize] = f32::from_bits(
                HCADECODER_SCALE_CONVERSION_TABLE_HEX[sc_index as usize],
            ) * ch.spectra[subframe][lowband as usize];

            highband += 1;
            lowband += lowband_adjust;
        }
    }

    // last spectrum coefficient is 0
    ch.spectra[subframe][(highband - 1) as usize] = 0.0f32;
}

//--------------------------------------------------
// Decode 4th step (joint stereo)
//--------------------------------------------------

fn apply_intensity_stereo(
    primary: &mut StChannel,
    secondary: &mut StChannel,
    subframe: usize,
    base_band_count: u32,
    total_band_count: u32,
) {
    if primary.ctype != STEREO_PRIMARY {
        return;
    }

    let min_band = base_band_count as usize;
    let max_bands = total_band_count as usize;

    let ratio_l = f32::from_bits(HCADECODER_INTENSITY_RATIO_TABLE_HEX[secondary.intensity[subframe] as usize]);
    let ratio_r = 2.0f32 - ratio_l;

    for band in min_band..max_bands {
        let coef_l = primary.spectra[subframe][band] * ratio_l;
        let coef_r = primary.spectra[subframe][band] * ratio_r;
        primary.spectra[subframe][band] = coef_l;
        secondary.spectra[subframe][band] = coef_r;
    }
}

fn apply_ms_stereo(
    primary: &mut StChannel,
    secondary: &mut StChannel,
    ms_stereo: u32,
    base_band_count: u32,
    subframe: usize,
) {
    if ms_stereo == 0 {
        return;
    }
    if primary.ctype != STEREO_PRIMARY {
        return;
    }

    let max_bands = base_band_count as usize;
    let ratio = 0.707106769084930419921875f32; // 1 / sqrt(2)

    for band in 0..max_bands {
        let coef_l = (primary.spectra[subframe][band] + secondary.spectra[subframe][band]) * ratio;
        let coef_r = (primary.spectra[subframe][band] - secondary.spectra[subframe][band]) * ratio;
        primary.spectra[subframe][band] = coef_l;
        secondary.spectra[subframe][band] = coef_r;
    }
}

//--------------------------------------------------
// Decode 5th step (IMDCT)
//--------------------------------------------------

unsafe fn imdct_transform(ch: &mut StChannel, subframe: usize) {
    let size = HCA_SAMPLES_PER_SUBFRAME;
    let half = HCA_SAMPLES_PER_SUBFRAME / 2;
    let mdct_bits = HCA_MDCT_BITS;

    let spectra_start = ch.spectra[subframe].as_mut_ptr();
    let temp_start = ch.temp.as_mut_ptr();

    // pre-rotation butterflies
    {
        let mut count1: usize = 1;
        let mut count2: usize = half;
        let mut temp1 = spectra_start;
        let mut temp2 = temp_start;

        for _ in 0..mdct_bits {
            let mut d1: usize = 0;
            let mut d2: usize = count2;

            for _j in 0..count1 {
                for _k in 0..count2 {
                    let a = *temp1;
                    let b = *temp1.add(1);
                    temp1 = temp1.add(2);

                    *temp2.add(d1) = a + b;
                    d1 += 1;
                    *temp2.add(d2) = a - b;
                    d2 += 1;
                }
                d1 += count2;
                d2 += count2;
            }

            let swap = temp1.sub(HCA_SAMPLES_PER_SUBFRAME);
            temp1 = temp2;
            temp2 = swap;

            count1 <<= 1;
            count2 >>= 1;
        }
    }

    // main DCT-IV twiddles
    {
        let mut count1: usize = half;
        let mut count2: usize = 1;
        let mut temp1 = ch.temp.as_mut_ptr();
        let mut temp2 = ch.spectra[subframe].as_mut_ptr();

        for i in 0..mdct_bits {
            let mut idx: usize = 0;
            let mut d1: usize = 0;
            let mut d2: usize = count2 * 2 - 1;
            let mut s1: usize = 0;
            let mut s2: usize = count2;

            for _j in 0..count1 {
                for _k in 0..count2 {
                    let a = *temp1.add(s1);
                    s1 += 1;
                    let b = *temp1.add(s2);
                    s2 += 1;
                    let sin = f32::from_bits(SIN_TABLES_HEX[i][idx]);
                    let cos = f32::from_bits(COS_TABLES_HEX[i][idx]);
                    idx += 1;

                    *temp2.add(d1) = a * sin - b * cos;
                    d1 += 1;
                    *temp2.add(d2) = a * cos + b * sin;
                    d2 = d2.wrapping_sub(1);
                }
                s1 += count2;
                s2 += count2;
                d1 += count2;
                d2 += count2 * 3;
            }

            let swap = temp1;
            temp1 = temp2;
            temp2 = swap;

            count1 >>= 1;
            count2 <<= 1;
        }
    }

    // update output/imdct with overlapped window
    {
        let dct = ch.spectra[subframe].as_ptr();
        let prev = ch.imdct_previous.as_mut_ptr();
        let wave = ch.wave[subframe].as_mut_ptr();

        for i in 0..half {
            let w0 = f32::from_bits(HCAIMDCT_WINDOW_FLOAT_HEX[i]);
            let w1 = f32::from_bits(HCAIMDCT_WINDOW_FLOAT_HEX[i + half]);
            let w2 = f32::from_bits(HCAIMDCT_WINDOW_FLOAT_HEX[size - 1 - i]);
            let w3 = f32::from_bits(HCAIMDCT_WINDOW_FLOAT_HEX[half - i - 1]);

            *wave.add(i) = w0 * *dct.add(i + half) + *prev.add(i);
            *wave.add(i + half) = w1 * *dct.add(size - 1 - i) - *prev.add(i + half);
            *prev.add(i) = w2 * *dct.add(half - i - 1);
            *prev.add(i + half) = w3 * *dct.add(i);
        }
    }
}

//--------------------------------------------------
// Decode orchestration
//--------------------------------------------------

unsafe fn decode_block_unpack(hca: &mut Hca, data: *mut u8, size: u32) -> i32 {
    if data.is_null() || hca.is_valid == 0 {
        return HCA_ERROR_PARAMS;
    }
    if size < hca.frame_size {
        return HCA_ERROR_PARAMS;
    }

    let mut br = ClData { data: data as *const u8, size: 0, bit: 0 };
    bitreader_init(&mut br, data as *const u8, hca.frame_size as i32);

    // test sync (not encrypted)
    let sync = bitreader_read(&mut br, 16);
    if sync != 0xFFFF {
        return HCA_ERROR_SYNC;
    }

    if crc16_checksum(data, hca.frame_size) != 0 {
        return HCA_ERROR_CHECKSUM;
    }

    cipher_decrypt(&hca.cipher_table, data, hca.frame_size as i32);

    // unpack frame values
    {
        let frame_acceptable_noise_level = bitreader_read(&mut br, 9);
        let frame_evaluation_boundary = bitreader_read(&mut br, 7);

        let packed_noise_level =
            (frame_acceptable_noise_level << 8).wrapping_sub(frame_evaluation_boundary);

        for ch in 0..hca.channels as usize {
            let err = unpack_scalefactors(
                &mut hca.channel[ch],
                &mut br,
                hca.hfr_group_count,
                hca.version,
            );
            if err < 0 {
                return err;
            }

            unpack_intensity(
                &mut hca.channel[ch],
                &mut br,
                hca.hfr_group_count,
                hca.version,
            );

            calculate_resolution(
                &mut hca.channel[ch],
                packed_noise_level,
                &hca.ath_curve,
                hca.min_resolution,
                hca.max_resolution,
            );

            calculate_gain(&mut hca.channel[ch]);
        }
    }

    // unpack channel data and get dequantized spectra
    for subframe in 0..HCA_SUBFRAMES {
        for ch in 0..hca.channels as usize {
            dequantize_coefficients(&mut hca.channel[ch], &mut br, subframe);
        }
    }

    br.bit
}

unsafe fn decode_block_transform(hca: &mut Hca) {
    let channels = hca.channels as usize;

    for subframe in 0..HCA_SUBFRAMES {
        let hfr_channels = if (hca.channel_config & HCA_CHANNEL_CONFIG_FLAG_AMBISONICS) != 0 {
            1
        } else {
            channels
        };

        // restore missing bands from spectra
        for ch in 0..hfr_channels {
            reconstruct_noise(
                &mut hca.channel[ch],
                hca.min_resolution,
                hca.ms_stereo,
                &mut hca.random,
                subframe,
            );

            reconstruct_high_frequency(
                &mut hca.channel[ch],
                hca.hfr_group_count,
                hca.bands_per_hfr_group,
                hca.stereo_band_count,
                hca.base_band_count,
                hca.total_band_count,
                hca.version,
                subframe,
            );
        }

        // restore missing joint stereo bands
        if hca.stereo_band_count > 0 {
            let base_band_count = hca.base_band_count;
            let total_band_count = hca.total_band_count;
            let ms_stereo = hca.ms_stereo;

            for ch in 0..channels - 1 {
                let (left, right) = hca.channel.split_at_mut(ch + 1);
                let primary = &mut left[ch];
                let secondary = &mut right[0];

                apply_intensity_stereo(
                    &mut *primary,
                    &mut *secondary,
                    subframe,
                    base_band_count,
                    total_band_count,
                );
                apply_ms_stereo(
                    &mut *primary,
                    &mut *secondary,
                    ms_stereo,
                    base_band_count,
                    subframe,
                );
            }
        }

        // apply imdct
        for ch in 0..channels {
            imdct_transform(&mut hca.channel[ch], subframe);
        }
    }
}

pub unsafe fn clhca_decode_block(hca: &mut Hca, data: *mut u8, size: u32) -> i32 {
    let res = decode_block_unpack(&mut *hca, data, size);
    if res < 0 {
        return res;
    }
    decode_block_transform(&mut *hca);

    res
}

pub unsafe fn clhca_test_block(hca: &mut Hca, data: *mut u8, size: u32) -> i32 {
    let frame_samples = HCA_SUBFRAMES * HCA_SAMPLES_PER_SUBFRAME;
    let scale = 32768.0f32;
    let mut clips: i32 = 0;
    let mut blanks: i32 = 0;
    let mut channel_blanks = [0i32; HCA_MAX_CHANNELS];
    let mut overread_bytes: i32 = 0;

    // first blocks can be empty/silent, check all bytes but sync/crc
    if size > 4 {
        let mut is_empty = true;
        for i in 2..(size as usize - 2) {
            if *data.add(i) != 0 {
                is_empty = false;
                break;
            }
        }
        if is_empty {
            return 0;
        }
    }

    // return if decode fails (happens often with wrong keys)
    let status = decode_block_unpack(&mut *hca, data, size);
    if status < 0 {
        return -1;
    }

    // detect data errors
    {
        let bits_max = (size as i32).wrapping_mul(8);
        let bits_used = status;

        if bits_used + 14 > bits_max {
            return HCA_ERROR_BITREADER;
        }

        let byte_start = bits_used / 8 + if bits_used % 8 != 0 { 1 } else { 0 };

        let mut i = byte_start;
        while i < size as i32 - 2 {
            if *data.add(i as usize) != 0x00 {
                return -1;
            }
            i += 1;
        }

        let mut i = byte_start;
        while i > 2 {
            if *data.add(i as usize) != 0x00 {
                break;
            }
            overread_bytes += 1;
            i -= 1;
        }
    }

    // check decode results
    decode_block_transform(&mut *hca);

    for ch in 0..hca.channels as usize {
        for sf in 0..HCA_SUBFRAMES {
            for s in 0..HCA_SAMPLES_PER_SUBFRAME {
                let fsample = hca.channel[ch].wave[sf][s];

                if fsample > 1.0f32 || fsample < -1.0f32 {
                    clips += 1;
                } else {
                    let psample = (fsample * scale) as i32;
                    if psample == 0 || psample == -1 {
                        blanks += 1;
                        channel_blanks[ch] += 1;
                    }
                }
            }
        }
    }

    // if block is silent result is not useful
    if blanks == (hca.channels as i32) * (frame_samples as i32) {
        return 0;
    }

    let mut top_score: i32 = 1;

    if clips >= 1 {
        top_score += clips;
    }

    if hca.channels >= 2 {
        if channel_blanks[0] == frame_samples as i32 && channel_blanks[1] != frame_samples as i32 {
            top_score += 3;
        }
    }

    if overread_bytes > 1 {
        let mut score = overread_bytes;
        if score > 15 {
            score = 15;
        }
        top_score += score;
    }

    top_score
}

pub unsafe fn clhca_decode_reset(hca: &mut Hca) {
    if hca.is_valid == 0 {
        return;
    }

    hca.random = HCA_DEFAULT_RANDOM;

    for i in 0..hca.channels as usize {
        hca.channel[i].imdct_previous = [0.0f32; HCA_SAMPLES_PER_SUBFRAME];
    }
}

//--------------------------------------------------
// Batch decoder entry points
//--------------------------------------------------

unsafe fn decode_hca_mono_core(
    data: *const u8,
    size: usize,
    keycode: u64,
    out_pcm: *mut f32,
    max_samples: usize,
    out_sr: *mut i32,
    count_only: bool,
) -> i32 {
    let mut hca = Box::new(Hca::new());
    clhca_clear(&mut *hca);

    if keycode != 0 {
        clhca_set_key(&mut *hca, keycode);
    }

    let err = clhca_decode_header(&mut *hca, data, size as u32);
    if err < 0 {
        return err;
    }

    let mut info = HcaInfo::new();
    clhca_get_info(&*hca, &mut info);
    if !out_sr.is_null() {
        *out_sr = info.sampling_rate as i32;
    }
    if info.channel_count < 1 || info.channel_count > 16 {
        return -101;
    }
    if info.block_size > 65536 {
        return -102;
    }

    let ch = info.channel_count as usize;
    let block_size = info.block_size as usize;
    let total_size = size as u32;

    let mut pos: u32 = info.header_size;
    let mut total_written: usize = 0;
    let mut raw_frame_idx: u32 = 0;
    let keep_start = info.encoder_delay;
    let keep_end = info.encoder_delay.wrapping_add(info.sample_count);

    let mut block_buf = vec![0u8; block_size];
    let mut block_pcm = vec![0.0f32; HCA_SAMPLES_PER_FRAME * HCA_MAX_CHANNELS];

    for _b in 0..info.block_count {
        if pos.wrapping_add(info.block_size) > total_size {
            break;
        }

        core::ptr::copy_nonoverlapping(
            data.add(pos as usize),
            block_buf.as_mut_ptr(),
            block_size,
        );
        pos = pos.wrapping_add(info.block_size);

        let err = clhca_decode_block(&mut *hca, block_buf.as_mut_ptr(), info.block_size);
        if err < 0 {
            return -200 + err;
        }

        clhca_read_samples(&*hca, block_pcm.as_mut_ptr());

        for s in 0..info.samples_per_block as usize {
            if raw_frame_idx >= keep_start && raw_frame_idx < keep_end {
                if count_only {
                    total_written += 1;
                } else if total_written < max_samples {
                    if ch == 1 {
                        *out_pcm.add(total_written) = block_pcm[s];
                    } else {
                        let mut acc = 0.0f32;
                        for c in 0..ch {
                            acc += block_pcm[s * ch + c];
                        }
                        *out_pcm.add(total_written) = acc / ch as f32;
                    }
                    total_written += 1;
                }
            }
            raw_frame_idx = raw_frame_idx.wrapping_add(1);
        }
    }

    total_written as i32
}

/// Raw-pointer entry point matching `pipeline/decode_hca.mjs`'s `decode_hca_mono`.
///
/// * `keycode` 0 means "not encrypted" (`ciph_type` is used as-is).
/// * At most `max_samples` mono `f32` values are written to `out_pcm`; the return
///   value is the number written (C semantics, capped by `max_samples`), or `< 0`.
/// * `*out_sr` receives the stream sample rate on success.
pub unsafe fn decode_hca_mono(
    data: *const u8,
    size: usize,
    keycode: u64,
    out_pcm: *mut f32,
    max_samples: usize,
    out_sr: *mut i32,
) -> i32 {
    decode_hca_mono_core(data, size, keycode, out_pcm, max_samples, out_sr, false)
}

/// Safe slice wrapper used by `wasm/lib.rs`.
///
/// Writes mono `f32` PCM into `dst` (at most `dst.len()` samples). Passing an empty
/// `dst` performs a size query: nothing is written and the total decodable sample
/// count is returned. `*out_sr` receives the stream sample rate on success.
pub fn decode_hca_mono_slice(
    data: &[u8],
    keycode: u64,
    dst: &mut [f32],
    out_sr: &mut u32,
) -> i32 {
    let mut sr: i32 = 0;
    let result = unsafe {
        if dst.is_empty() {
            decode_hca_mono_core(
                data.as_ptr(),
                data.len(),
                keycode,
                core::ptr::null_mut(),
                0,
                &mut sr as *mut i32,
                true,
            )
        } else {
            decode_hca_mono_core(
                data.as_ptr(),
                data.len(),
                keycode,
                dst.as_mut_ptr(),
                dst.len(),
                &mut sr as *mut i32,
                false,
            )
        }
    };
    if sr > 0 {
        *out_sr = sr as u32;
    }
    result
}

//--------------------------------------------------
// AIUEO lip-sync analyzer (port of pipeline/export_voices.ts)
//--------------------------------------------------

const FFT_N: usize = 2048;
const FFT_BITS: usize = 11;
const FFT_HALF: usize = FFT_N >> 1;

fn fft_in_place(
    re: &mut [f64],
    im: &mut [f64],
    bitrev: &[u16],
    tw_cos: &[f64],
    tw_sin: &[f64],
) {
    for i in 0..FFT_N {
        let j = bitrev[i] as usize;
        if j > i {
            re.swap(i, j);
            im.swap(i, j);
        }
    }

    let mut fft_size = 2usize;
    while fft_size <= FFT_N {
        let half = fft_size >> 1;
        let step = FFT_N / fft_size;

        let mut start = 0usize;
        while start < FFT_N {
            for k in 0..half {
                let cos = tw_cos[k * step];
                let sin = tw_sin[k * step];
                let a = start + k;
                let b = a + half;

                let tre = re[b] * cos - im[b] * sin;
                let tim = re[b] * sin + im[b] * cos;

                re[b] = re[a] - tre;
                im[b] = im[a] - tim;
                re[a] += tre;
                im[a] += tim;
            }
            start += fft_size;
        }

        fft_size <<= 1;
    }
}

fn band_bins(sr: u32, lo: f64, hi: f64) -> Vec<usize> {
    let mut bins = Vec::new();
    for k in 0..=FFT_HALF {
        let f = (k as f64 * sr as f64) / FFT_N as f64;
        if f >= lo && f < hi {
            bins.push(k);
        }
    }
    bins
}

fn band_mean(mag: &[f64], bins: &[usize]) -> f64 {
    if bins.is_empty() {
        return 1e-6;
    }
    let mut sum = 0.0f64;
    for &k in bins {
        sum += mag[k];
    }
    sum / bins.len() as f64 + 1e-6
}

fn percentile95(values: &[f64]) -> f64 {
    let mut sorted: Vec<f64> = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));

    let p = 95.0f64;
    let idx = ((sorted.len() - 1) as f64 * p) / 100.0;
    let lo = idx.floor() as usize;
    let hi = idx.ceil() as usize;
    if lo == hi {
        sorted[lo]
    } else {
        sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo as f64)
    }
}

/// Raw-pointer entry point: computes 60 Hz `[a, i, u, e, o]` weights (`0..100`)
/// from mono `f32` PCM, writing 5 bytes per frame and returning the frame count.
pub unsafe fn compute_aiueo(
    pcm_ptr: *const f32,
    num_samples: usize,
    sr: u32,
    fps: u32,
    out_frames_ptr: *mut u8,
    max_frames: usize,
) -> i32 {
    if pcm_ptr.is_null() || out_frames_ptr.is_null() || sr == 0 || fps == 0 {
        return -1;
    }
    if num_samples < 256 {
        return 0;
    }

    let hop = (sr / fps) as usize;
    if hop == 0 {
        return -1;
    }

    let pcm = core::slice::from_raw_parts(pcm_ptr, num_samples);

    // ---- pre-emphasis (lifts F1/F2 vowel formants) ----
    let mut emph = vec![0.0f32; num_samples];
    emph[0] = pcm[0];
    for i in 1..num_samples {
        emph[i] = (pcm[i] as f64 - 0.96 * pcm[i - 1] as f64) as f32;
    }

    // ---- np.hanning(2048): denominator is M - 1 ----
    let mut hann = vec![0.0f64; FFT_N];
    for i in 0..FFT_N {
        hann[i] = 0.5
            - 0.5
                * ((2.0 * core::f64::consts::PI * i as f64) / (FFT_N as f64 - 1.0)).cos();
    }

    // ---- bit-reversal + twiddle tables ----
    let mut bitrev = vec![0u16; FFT_N];
    for i in 0..FFT_N {
        let mut r = 0u16;
        for b in 0..FFT_BITS {
            r |= (((i >> b) & 1) as u16) << (FFT_BITS - 1 - b);
        }
        bitrev[i] = r;
    }

    let mut tw_cos = vec![0.0f64; FFT_HALF];
    let mut tw_sin = vec![0.0f64; FFT_HALF];
    for i in 0..FFT_HALF {
        let ang = (-2.0 * core::f64::consts::PI * i as f64) / FFT_N as f64;
        tw_cos[i] = ang.cos();
        tw_sin[i] = ang.sin();
    }

    // ---- formant bands (Hz) ----
    let m0 = band_bins(sr, 240.0, 480.0);
    let m1 = band_bins(sr, 480.0, 780.0);
    let m2 = band_bins(sr, 780.0, 1250.0);
    let m3 = band_bins(sr, 1250.0, 1950.0);
    let m4 = band_bins(sr, 1950.0, 3400.0);
    let msib = band_bins(sr, 4200.0, 8500.0);

    let n_frames = ((num_samples + hop - 1) / hop).max(1);

    let mut rms_arr = vec![0.0f64; n_frames];
    let mut band_e = vec![[0.0f64; 5]; n_frames];

    let mut re = vec![0.0f64; FFT_N];
    let mut im = vec![0.0f64; FFT_N];
    let mut mag = vec![0.0f64; FFT_HALF + 1];

    for fi in 0..n_frames {
        let c = (fi * hop) as i64;
        let pad = FFT_HALF as i64;

        let mut sum_sq = 0.0f64;
        for i in 0..FFT_N {
            let idx = c + i as i64 - pad;
            let v = if idx >= 0 && (idx as usize) < num_samples {
                pcm[idx as usize] as f64
            } else {
                0.0
            };
            sum_sq += v * v;
        }
        rms_arr[fi] = (sum_sq / FFT_N as f64 + 1e-12).sqrt();

        for i in 0..FFT_N {
            let idx = c + i as i64 - pad;
            let v = if idx >= 0 && (idx as usize) < num_samples {
                emph[idx as usize] as f64
            } else {
                0.0
            };
            re[i] = v * hann[i];
            im[i] = 0.0;
        }

        fft_in_place(&mut re, &mut im, &bitrev, &tw_cos, &tw_sin);

        for k in 0..=FFT_HALF {
            mag[k] = (re[k] * re[k] + im[k] * im[k]).sqrt();
        }

        let e0 = band_mean(&mag, &m0);
        let e1 = band_mean(&mag, &m1);
        let e2 = band_mean(&mag, &m2);
        let e3 = band_mean(&mag, &m3);
        let e4 = band_mean(&mag, &m4);
        let esib = band_mean(&mag, &msib);

        let voiced_sum = e0 + e1 + e2 + e3 + e4;
        let sib_penalty = (1.0 - 0.65 * (esib / (voiced_sum * 0.22)).min(1.0)).max(0.25);

        // score Japanese vowels from F1/F2 spectral distribution
        let s_a = (1.35 * e2 + 1.05 * e3 + 0.35 * e1) * sib_penalty;
        let s_i = (1.15 * e0 + 1.55 * e4) * sib_penalty;
        let s_u = 1.30 * e0 + 0.80 * e2 + 0.45 * e1 - 0.35 * e4;
        let s_e = (1.15 * e1 + 1.15 * e3 + 0.85 * e4) * sib_penalty;
        let s_o = (1.20 * e1 + 1.25 * e2 - 0.30 * e4) * sib_penalty;

        let mut scores = [
            s_a.max(0.0),
            s_i.max(0.0),
            s_u.max(0.0),
            s_e.max(0.0),
            s_o.max(0.0),
        ];

        // sharpen dominant vowel softly (power=2.2)
        let mut tot = 0.0f64;
        for k in 0..5 {
            scores[k] = scores[k].powf(2.2);
            tot += scores[k];
        }

        let out = &mut band_e[fi];
        if tot > 1e-9 {
            for k in 0..5 {
                out[k] = scores[k] / tot;
            }
        } else {
            out[0] = 0.4;
            out[1] = 0.15;
            out[2] = 0.15;
            out[3] = 0.15;
            out[4] = 0.15;
        }
    }

    let ref_rms = percentile95(&rms_arr).max(0.015);
    let noise_floor = ref_rms * 0.085;

    // attack / release envelope smoothing
    let mut frames = vec![[0u8; 5]; n_frames];
    let mut cur = [0.0f64; 5];

    for fi in 0..n_frames {
        let amp = ((rms_arr[fi] - noise_floor) / (ref_rms - noise_floor).max(1e-5)).max(0.0);
        let mut open_env = (amp.powf(0.68) * 1.05).min(1.0);
        if open_env < 0.05 {
            open_env = 0.0;
        }

        for k in 0..5 {
            let target = band_e[fi][k] * open_env;
            let alpha = if target > cur[k] { 0.52 } else { 0.28 };
            cur[k] += (target - cur[k]) * alpha;
        }

        for k in 0..5 {
            let v = cur[k].max(0.0).min(1.0);
            frames[fi][k] = (v * 100.0).round() as u8;
        }
    }

    // ensure clean mouth closure on final 2 frames
    if frames.len() >= 2 {
        let last = frames.len() - 1;
        for k in 0..5 {
            frames[last - 1][k] = frames[last - 1][k] / 2;
        }
        frames[last] = [0u8; 5];
    }

    let writable = n_frames.min(max_frames);
    for fi in 0..writable {
        let dst = out_frames_ptr.add(fi * 5);
        for k in 0..5 {
            *dst.add(k) = frames[fi][k];
        }
    }

    n_frames as i32
}

/// Safe slice wrapper used by `wasm/lib.rs` (5 bytes per 60 Hz frame).
pub fn compute_aiueo_slice(pcm: &[f32], sr: u32, fps: u32, out: &mut [u8]) -> i32 {
    unsafe {
        compute_aiueo(
            pcm.as_ptr(),
            pcm.len(),
            sr,
            fps,
            out.as_mut_ptr(),
            out.len() / 5,
        )
    }
}
