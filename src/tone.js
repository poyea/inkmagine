// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// Greyscale conversion and tonal shaping, all in Float32 [0,1].

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/**
 * RGBA bytes -> Float32 luma. Writes into `out` when supplied so the caller
 * can keep one buffer alive across renders.
 */
export function toLuma(rgba, out) {
  const n = rgba.length >> 2;
  const gray = out && out.length === n ? out : new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    gray[i] = (LUMA_R * rgba[j] + LUMA_G * rgba[j + 1] + LUMA_B * rgba[j + 2]) / 255;
  }
  return gray;
}

/**
 * brightness -> contrast -> gamma -> invert, applied in place.
 * @param {Float32Array} gray
 * @param {{brightness:number, contrast:number, gamma:number, invert:boolean}} tone
 */
export function applyTone(gray, tone) {
  const { brightness = 0, contrast = 1, gamma = 1, invert = false } = tone;
  const flat = brightness === 0 && contrast === 1;
  const straight = gamma === 1;
  if (flat && straight && !invert) return gray;

  // pow() per pixel is the expensive part; a 1024-entry ramp is visually
  // identical at 8-bit output and roughly an order of magnitude cheaper.
  const N = 1024;
  const ramp = new Float32Array(N);
  const invGamma = 1 / gamma;
  for (let i = 0; i < N; i++) {
    let v = i / (N - 1);
    v = (v + brightness - 0.5) * contrast + 0.5;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    if (!straight) v = Math.pow(v, invGamma);
    ramp[i] = invert ? 1 - v : v;
  }

  for (let i = 0; i < gray.length; i++) {
    const v = gray[i];
    const idx = v <= 0 ? 0 : v >= 1 ? N - 1 : (v * (N - 1) + 0.5) | 0;
    gray[i] = ramp[idx];
  }
  return gray;
}

/**
 * Unsharp mask: gray += amount * (gray - blur(gray)).
 * `passes` widens the radius by repeating a 1-2-1 separable blur.
 */
export function sharpen(gray, w, h, amount, passes = 1) {
  if (amount <= 0) return gray;
  const blur = gray.slice();
  const tmp = new Float32Array(gray.length);
  for (let p = 0; p < passes; p++) {
    blurPass(blur, tmp, w, h);
  }
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i] + amount * (gray[i] - blur[i]);
    gray[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return gray;
}

function blurPass(buf, tmp, w, h) {
  // horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const l = buf[row + (x > 0 ? x - 1 : 0)];
      const c = buf[row + x];
      const r = buf[row + (x < w - 1 ? x + 1 : w - 1)];
      tmp[row + x] = (l + 2 * c + r) * 0.25;
    }
  }
  // vertical
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const up = (y > 0 ? y - 1 : 0) * w;
    const dn = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      buf[row + x] = (tmp[up + x] + 2 * tmp[row + x] + tmp[dn + x]) * 0.25;
    }
  }
}

/**
 * Histogram stretch. Returns brightness/contrast that map the given
 * percentile clip points onto full range, assuming gamma = 1.
 */
export function autoLevels(gray, clip = 0.005) {
  const bins = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i];
    bins[v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0]++;
  }
  const cut = Math.max(1, Math.floor(gray.length * clip));

  let lo = 0;
  let hi = 255;
  for (let acc = 0, i = 0; i < 256; i++) {
    acc += bins[i];
    if (acc >= cut) { lo = i; break; }
  }
  for (let acc = 0, i = 255; i >= 0; i--) {
    acc += bins[i];
    if (acc >= cut) { hi = i; break; }
  }

  const loV = lo / 255;
  const hiV = hi / 255;
  if (hiV - loV < 0.02) return { brightness: 0, contrast: 1 };

  const contrast = clamp(1 / (hiV - loV), 0.5, 3);
  const brightness = clamp(0.5 - 0.5 / contrast - loV, -0.5, 0.5);
  return { brightness: round3(brightness), contrast: round3(contrast) };
}

/** Fraction of pixels at or below mid-grey: a proxy for e-ink ink load. */
export function coverage(bytes) {
  let dark = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] < 128) dark++;
  return dark / bytes.length;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round3 = (v) => Math.round(v * 1000) / 1000;
