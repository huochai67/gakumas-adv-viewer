"""Decode Unity AnimationClip compressed data (streamed/dense/constant).

Layout (verified against gakumas clips, mirrors AssetRipper AnimationClipConverter):
- every generic binding consumes `dimension` consecutive curve slots
  (typeID 4 Transform: attr 1=translation 3, 2=rotation 4, 3=scale 3, 4=euler 3;
   everything else 1)
- slots are ordered: streamed.curveCount, then dense.m_CurveCount, then
  len(constant.data)
- streamed frames: float time, int32 keyCount, keyCount * StreamedCurveKey
  {int index, float c0, float c1, float c2, float value}; value inside the
  frame is value + c0*u^3 + c1*u^2 + c2*u with u = t - frameTime
- dense: frame-major, m_CurveCount floats per frame, t = frame/rate + beginTime
- constant: single value valid over [0, stopTime]
"""
from __future__ import annotations

import math
import struct
import zlib
from typing import Dict, List, Tuple
TRANSFORM_DIM = {1: 3, 2: 4, 3: 3, 4: 3}  # translation / rotation / scale / euler


def crc32(s: str) -> int:
    return zlib.crc32(s.encode("utf-8")) & 0xFFFFFFFF


def binding_dimension(b) -> int:
    if b.typeID == 4:  # Transform
        return TRANSFORM_DIM.get(b.attribute, 1)
    return 1


def build_curve_map(bindings) -> Tuple[List[Tuple[int, int]], int]:
    """Return (slot -> (binding index, component)), total slot count."""
    out = []
    for bi, b in enumerate(bindings):
        dim = binding_dimension(b)
        for d in range(dim):
            out.append((bi, d))
    return out, len(out)


def _f(u: int) -> float:
    return struct.unpack("<f", struct.pack("<I", u & 0xFFFFFFFF))[0]


class StreamedFrames:
    """Sampler for a Unity StreamedClip."""

    def __init__(self, data, declared_count: int = 0):
        self.frames = []  # list[(time, {index: (c0, c1, c2, value)})]
        self._declared_count = int(declared_count or 0)
        i = 0
        n = len(data)
        while i + 1 < n:
            t = _f(data[i])
            count = struct.unpack("<i", struct.pack("<I", data[i + 1] & 0xFFFFFFFF))[0]
            i += 2
            if count <= 0:
                continue
            keys = {}
            for _ in range(count):
                if i + 5 > n:
                    i = n
                    break
                idx = struct.unpack("<i", struct.pack("<I", data[i] & 0xFFFFFFFF))[0]
                keys[idx] = (_f(data[i + 1]), _f(data[i + 2]), _f(data[i + 3]), _f(data[i + 4]))
                i += 5
            self.frames.append((t, keys))

    def curve_count(self):
        if self._declared_count > 0:
            return self._declared_count
        mx = -1
        for _, keys in self.frames:
            if keys:
                mx = max(mx, max(keys))
        return mx + 1 if mx >= 0 else 0

    def _eval_key(self, prev, u: float) -> float:
        c0, c1, c2, val = prev
        if not (math.isfinite(c0) and math.isfinite(c1) and math.isfinite(c2)):
            return val
        return val + u * (c2 + u * (c1 + u * c0))

    def sample(self, index: int, t: float) -> float:
        prev = None
        prev_time = 0.0
        for ft, keys in self.frames:
            k = keys.get(index)
            if k is None:
                continue
            if t < ft:
                if prev is None:
                    return k[3]
                return self._eval_key(prev, t - prev_time)
            prev = k
            prev_time = ft
        if prev is None:
            return 0.0
        return prev[3]

class ClipSampler:
    """Random access sampler for one AnimationClip's curve slots."""

    def __init__(self, clip_obj, bindings, stop_time: float):
        data = clip_obj.m_MuscleClip.m_Clip.data
        self.stop_time = stop_time
        self.curve_map, self.slot_count = build_curve_map(bindings)
        sc = data.m_StreamedClip
        self.streamed = StreamedFrames(sc.data, getattr(sc, "curveCount", 0)) if sc.data else None
        self.streamed_count = int(getattr(sc, "curveCount", 0)) if sc.data else 0
        dense = data.m_DenseClip
        self.dense_count = dense.m_CurveCount
        if self.dense_count:
            self.dense_samples = list(dense.m_SampleArray)
            self.dense_frames = dense.m_FrameCount
            self.dense_rate = dense.m_SampleRate or 30.0
            self.dense_begin = dense.m_BeginTime
        else:
            self.dense_samples = []
            self.dense_frames = 0
            self.dense_rate = 30.0
            self.dense_begin = 0.0
        self.const_offset = self.streamed_count + self.dense_count
        self.const_data = list(data.m_ConstantClip.data) if data.m_ConstantClip else []

    def value(self, slot: int, t: float) -> float:
        if slot < self.streamed_count:
            return self.streamed.sample(slot, t)
        if slot < self.const_offset:
            fi = slot - self.streamed_count
            if self.dense_frames == 0:
                return 0.0
            # nearest sample (Unity interpolates linearly between dense samples)
            f = (t - self.dense_begin) * self.dense_rate
            i0 = int(f)
            i0 = max(0, min(self.dense_frames - 1, i0))
            i1 = max(0, min(self.dense_frames - 1, i0 + 1))
            frac = min(1.0, max(0.0, f - i0))
            n = self.dense_count
            a = self.dense_samples[i0 * n + fi]
            b = self.dense_samples[i1 * n + fi]
            return a + (b - a) * frac
        ci = slot - self.const_offset
        if ci < len(self.const_data):
            return self.const_data[ci]
        return 0.0

    def sample_all(self, times: List[float]) -> List[List[float]]:
        """Return list of per-time float lists (slot values), frame-major."""
        out = []
        for t in times:
            out.append([self.value(slot, t) for slot in range(self.slot_count)])
        return out


def decode_clip(clip_obj, bindings, stop_time: float) -> Dict[int, List[Tuple[float, float]]]:
    """Decode every curve slot into (time, value) pairs (debug helper)."""
    s = ClipSampler(clip_obj, bindings, stop_time)
    curves: Dict[int, List[Tuple[float, float]]] = {}
    end = stop_time or 0.0
    for slot in range(s.slot_count):
        if slot < s.const_offset:
            curves[slot] = [(t, s.value(slot, t)) for t in _dense_times(s)]
        else:
            curves[slot] = [(0.0, s.const_data[slot - s.const_offset]),
                            (end, s.const_data[slot - s.const_offset])]
    return curves


def _dense_times(s: ClipSampler):
    if s.dense_frames:
        return [fi / s.dense_rate + s.dense_begin for fi in range(s.dense_frames)]
    return [0.0]
