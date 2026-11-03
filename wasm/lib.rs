//! `gakumas_core` — the WebAssembly core of the in-browser asset pipeline.
//!
//! Compiled with:
//!
//! ```text
//! rustc --target wasm32-unknown-unknown -C opt-level=3 --crate-type cdylib \
//!     wasm/lib.rs -o web/wasm/gakumas_core.wasm
//! ```
//!
//! Every exported symbol is a thin `extern "C"` wrapper around the pure-Rust
//! implementations in [`lz4_bcn`] (Octo unmasking, raw LZ4 blocks and all six
//! Unity `TextureFormat` decoders) and [`clhca`] (CRI HCA decoding plus 60Hz
//! AIUEO lip-sync analysis).

pub mod clhca;
pub mod lz4_bcn;

use core::slice;

/* ------------------------------------------------------------------------- */
/* Linear-memory helpers                                                     */
/* ------------------------------------------------------------------------- */

/// Allocate `size` bytes (16-byte aligned) inside the WASM linear memory.
#[no_mangle]
pub unsafe extern "C" fn wasm_alloc(size: usize) -> *mut u8 {
    let layout = std::alloc::Layout::from_size_align_unchecked(size.max(1), 16);
    std::alloc::alloc(layout)
}

/// Release a buffer previously obtained from [`wasm_alloc`].
#[no_mangle]
pub unsafe extern "C" fn wasm_free(ptr: *mut u8, size: usize) {
    if ptr.is_null() {
        return;
    }
    let layout = std::alloc::Layout::from_size_align_unchecked(size.max(1), 16);
    std::alloc::dealloc(ptr, layout);
}

#[inline]
unsafe fn input<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        slice::from_raw_parts(ptr, len)
    }
}

/* ------------------------------------------------------------------------- */
/* Bundle header unmasking                                                   */
/* ------------------------------------------------------------------------- */

/// XOR-unmask the first `0x100` bytes of an encrypted Octo bundle in place.
#[no_mangle]
pub unsafe extern "C" fn wasm_decrypt_bundle(
    data_ptr: *mut u8,
    data_len: usize,
    name_ptr: *const u8,
    name_len: usize,
) {
    if data_ptr.is_null() || data_len == 0 {
        return;
    }
    let data = slice::from_raw_parts_mut(data_ptr, data_len);
    let name = input(name_ptr, name_len);
    lz4_bcn::decrypt_bundle_in_place(data, name);
}

/* ------------------------------------------------------------------------- */
/* LZ4                                                                      */
/* ------------------------------------------------------------------------- */

/// Decompress a bare LZ4 block. Returns bytes written, or `< 0` on error.
#[no_mangle]
pub unsafe extern "C" fn wasm_lz4_decompress(
    src_ptr: *const u8,
    src_len: usize,
    dst_ptr: *mut u8,
    dst_len: usize,
) -> i32 {
    if dst_ptr.is_null() || dst_len == 0 {
        return -1;
    }
    let src = input(src_ptr, src_len);
    let dst = slice::from_raw_parts_mut(dst_ptr, dst_len);
    lz4_bcn::lz4_decompress_block(src, dst)
}

/* ------------------------------------------------------------------------- */
/* Texture2D decoding                                                       */
/* ------------------------------------------------------------------------- */

/// Decode Unity texture bytes into `width * height * 4` bytes of RGBA8.
#[no_mangle]
pub unsafe extern "C" fn wasm_decode_texture2d_rgba(
    src_ptr: *const u8,
    src_len: usize,
    width: u32,
    height: u32,
    format: u32,
    flip: u32,
    dst_ptr: *mut u8,
) -> i32 {
    if dst_ptr.is_null() || width == 0 || height == 0 {
        return -1;
    }
    let out_len = match (width as usize)
        .checked_mul(height as usize)
        .and_then(|v| v.checked_mul(4))
    {
        Some(v) => v,
        None => return -1,
    };
    let src = input(src_ptr, src_len);
    let dst = slice::from_raw_parts_mut(dst_ptr, out_len);
    lz4_bcn::decode_texture2d_rgba(src, width as usize, height as usize, format, flip != 0, dst)
}

/* ------------------------------------------------------------------------- */
/* CRI HCA + lip-sync                                                       */
/* ------------------------------------------------------------------------- */

/// Decode an HCA stream to mono f32 PCM, reporting the sample rate.
///
/// `max_samples == 0` (or a null PCM pointer) acts as a size query: nothing is
/// written and the total sample count is returned.
#[no_mangle]
pub unsafe extern "C" fn wasm_decode_hca_mono(
    src_ptr: *const u8,
    src_len: usize,
    key_lo: u32,
    key_hi: u32,
    dst_pcm_ptr: *mut f32,
    max_samples: usize,
    out_sr_ptr: *mut i32,
) -> i32 {
    if dst_pcm_ptr.is_null() && max_samples > 0 {
        return -1;
    }
    let src = input(src_ptr, src_len);
    let dst: &mut [f32] = if max_samples == 0 || dst_pcm_ptr.is_null() {
        &mut []
    } else {
        slice::from_raw_parts_mut(dst_pcm_ptr, max_samples)
    };
    let keycode = (key_lo as u64) | ((key_hi as u64) << 32);
    let mut sample_rate: u32 = 0;
    let written = clhca::decode_hca_mono_slice(src, keycode, dst, &mut sample_rate);
    if !out_sr_ptr.is_null() {
        *out_sr_ptr = sample_rate as i32;
    }
    written
}

/// Compute 60Hz AIUEO lip-sync weights (5 bytes per frame).
#[no_mangle]
pub unsafe extern "C" fn wasm_compute_aiueo(
    pcm_ptr: *const f32,
    num_samples: usize,
    sr: u32,
    fps: u32,
    out_frames_ptr: *mut u8,
    max_frames: usize,
) -> i32 {
    if num_samples > 0 && pcm_ptr.is_null() {
        return -1;
    }
    let pcm = if pcm_ptr.is_null() {
        &[][..]
    } else {
        slice::from_raw_parts(pcm_ptr, num_samples)
    };
    let out: &mut [u8] = if max_frames == 0 || out_frames_ptr.is_null() {
        &mut []
    } else {
        slice::from_raw_parts_mut(out_frames_ptr, max_frames * 5)
    };
    clhca::compute_aiueo_slice(pcm, sr, fps, out)
}
