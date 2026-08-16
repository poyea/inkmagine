// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// Halftone screens: error-diffusion kernels and ordered threshold matrices.
//
// Everything quantises to `levels` evenly spaced greys (2 = pure black/white).
// Input is Float32 [0,1]; output is Uint8ClampedArray 0..255.

import { blueNoise } from './bluenoise.js';

// --- Error-diffusion kernels: [dx, dy, weight], normalised by `divisor`.

const KERNELS = {
  floyd: {
    divisor: 16,
    taps: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]],
  },
  jjn: {
    divisor: 48,
    taps: [
      [1, 0, 7], [2, 0, 5],
      [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3],
      [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1],
    ],
  },
  stucki: {
    divisor: 42,
    taps: [
      [1, 0, 8], [2, 0, 4],
      [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2],
      [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1],
    ],
  },
  atkinson: {
    // Diffuses only 6/8 of the error on purpose: blows out highlights and
    // shadows, which is exactly why it reads well on e-paper.
    divisor: 8,
    taps: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]],
  },
  burkes: {
    divisor: 32,
    taps: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2]],
  },
  sierra3: {
    divisor: 32,
    taps: [
      [1, 0, 5], [2, 0, 3],
      [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2],
      [-1, 2, 2], [0, 2, 3], [1, 2, 2],
    ],
  },
  sierra2: {
    divisor: 16,
    taps: [[1, 0, 4], [2, 0, 3], [-2, 1, 1], [-1, 1, 2], [0, 1, 3], [1, 1, 2], [2, 1, 1]],
  },
  sierralite: {
    divisor: 4,
    taps: [[1, 0, 2], [-1, 1, 1], [0, 1, 1]],
  },
};

// --- Ordered threshold matrices, values normalised to (0,1).

function bayer(n) {
  let m = [[0]];
  let size = 1;
  while (size < n) {
    const next = [];
    for (let y = 0; y < size * 2; y++) next.push(new Array(size * 2).fill(0));
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = m[y][x] * 4;
        next[y][x] = v;
        next[y][x + size] = v + 2;
        next[y + size][x] = v + 3;
        next[y + size][x + size] = v + 1;
      }
    }
    m = next;
    size *= 2;
  }
  return normalise(m.flat(), n);
}

// Classic 45-degree clustered dot screens: dots grow outward from a centre,
// which is what makes output look like print rather than noise.
const CLUSTER_4 = [
  12, 5, 6, 13,
  4, 0, 1, 7,
  11, 3, 2, 8,
  15, 10, 9, 14,
];

const CLUSTER_8 = [
  24, 10, 12, 26, 35, 47, 49, 37,
  8, 0, 2, 14, 45, 59, 61, 51,
  22, 6, 4, 16, 43, 57, 63, 53,
  30, 20, 18, 28, 33, 41, 55, 39,
  34, 46, 48, 36, 25, 11, 13, 27,
  44, 58, 60, 50, 9, 1, 3, 15,
  42, 56, 62, 52, 23, 7, 5, 17,
  32, 40, 54, 38, 31, 21, 19, 29,
];

/** Diagonal line screen: a triangle wave across x+y, riso-plate flavoured. */
function lineScreen(n) {
  const out = new Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const t = ((x + y) % n) / n;
      out[y * n + x] = Math.round((t < 0.5 ? t * 2 : (1 - t) * 2) * (n * n - 1));
    }
  }
  return normalise(out, n);
}

function normalise(values, size) {
  const total = size * size;
  const data = new Float32Array(total);
  for (let i = 0; i < total; i++) data[i] = (values[i] + 0.5) / total;
  return { size, data };
}

const matrixCache = new Map();

/** @returns {{size:number, data:Float32Array}} */
export function thresholdMatrix(id) {
  if (id === 'bluenoise') return blueNoise();
  if (matrixCache.has(id)) return matrixCache.get(id);
  let m;
  switch (id) {
    case 'bayer2': m = bayer(2); break;
    case 'bayer4': m = bayer(4); break;
    case 'bayer8': m = bayer(8); break;
    case 'halftone4': m = normalise(CLUSTER_4, 4); break;
    case 'halftone8': m = normalise(CLUSTER_8, 8); break;
    case 'line8': m = lineScreen(8); break;
    default: m = normalise(CLUSTER_4, 4);
  }
  matrixCache.set(id, m);
  return m;
}

// --- Algorithm registry, grouped for the UI.

export const ALGORITHMS = [
  { id: 'none', label: 'None (continuous grey)', group: 'Direct', kind: 'none' },
  { id: 'threshold', label: 'Hard threshold', group: 'Direct', kind: 'threshold' },

  { id: 'floyd', label: 'Floyd–Steinberg', group: 'Error diffusion', kind: 'diffusion' },
  { id: 'atkinson', label: 'Atkinson', group: 'Error diffusion', kind: 'diffusion' },
  { id: 'jjn', label: 'Jarvis–Judice–Ninke', group: 'Error diffusion', kind: 'diffusion' },
  { id: 'stucki', label: 'Stucki', group: 'Error diffusion', kind: 'diffusion' },
  { id: 'burkes', label: 'Burkes', group: 'Error diffusion', kind: 'diffusion' },
  { id: 'sierra3', label: 'Sierra 3', group: 'Error diffusion', kind: 'diffusion' },
  { id: 'sierra2', label: 'Sierra 2', group: 'Error diffusion', kind: 'diffusion' },
  { id: 'sierralite', label: 'Sierra Lite', group: 'Error diffusion', kind: 'diffusion' },

  { id: 'bayer2', label: 'Bayer 2×2', group: 'Ordered', kind: 'ordered' },
  { id: 'bayer4', label: 'Bayer 4×4', group: 'Ordered', kind: 'ordered' },
  { id: 'bayer8', label: 'Bayer 8×8', group: 'Ordered', kind: 'ordered' },
  { id: 'bluenoise', label: 'Blue noise 64×64', group: 'Ordered', kind: 'ordered' },

  { id: 'halftone4', label: 'Halftone 4×4 (45°)', group: 'Print screens', kind: 'ordered' },
  { id: 'halftone8', label: 'Halftone 8×8 (45°)', group: 'Print screens', kind: 'ordered' },
  { id: 'line8', label: 'Line screen 8', group: 'Print screens', kind: 'ordered' },
];

const BY_ID = new Map(ALGORITHMS.map((a) => [a.id, a]));

export function algorithm(id) {
  return BY_ID.get(id) || BY_ID.get('floyd');
}

/** Parallel screens can run on the GPU; error diffusion cannot. */
export function isParallel(id) {
  const kind = algorithm(id).kind;
  return kind === 'ordered' || kind === 'threshold' || kind === 'none';
}

/**
 * Quantise `gray` in place into `out`.
 *
 * @param {Float32Array} gray  luma, [0,1]
 * @param {number} w
 * @param {number} h
 * @param {{algo:string, levels:number, strength:number, bias:number, serpentine:boolean}} opts
 * @param {Uint8ClampedArray} [out]
 */
export function screen(gray, w, h, opts, out) {
  const dst = out && out.length === w * h ? out : new Uint8ClampedArray(w * h);
  const { algo = 'floyd', levels = 2, strength = 1, bias = 0, serpentine = true } = opts;
  const spec = algorithm(algo);

  if (spec.kind === 'none') {
    for (let i = 0; i < gray.length; i++) dst[i] = clamp01(gray[i] + bias) * 255;
    return dst;
  }

  const steps = Math.max(2, levels) - 1;

  if (spec.kind === 'threshold') {
    for (let i = 0; i < gray.length; i++) {
      dst[i] = quantise(gray[i] + bias, steps) * 255;
    }
    return dst;
  }

  if (spec.kind === 'ordered') {
    const { size, data } = thresholdMatrix(algo);
    const step = 1 / steps;
    for (let y = 0; y < h; y++) {
      const mrow = (y % size) * size;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const t = data[mrow + (x % size)];
        const v = gray[row + x] + bias + strength * (t - 0.5) * step;
        dst[row + x] = quantise(v, steps) * 255;
      }
    }
    return dst;
  }

  return diffuse(gray, w, h, dst, KERNELS[algo] || KERNELS.floyd, steps, strength, bias, serpentine);
}

function diffuse(gray, w, h, dst, kernel, steps, strength, bias, serpentine) {
  const { taps, divisor } = kernel;
  // Flatten taps and pre-divide: this loop runs w*h*taps times.
  const n = taps.length;
  const tdx = new Int32Array(n);
  const tdy = new Int32Array(n);
  const tw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    tdx[i] = taps[i][0];
    tdy[i] = taps[i][1];
    tw[i] = (taps[i][2] / divisor) * strength;
  }

  // Only the rows a kernel can still reach need error accumulators. Kernels
  // here span at most 2 rows ahead, so a 3-row ring buffer is enough.
  const spanY = 3;
  const err = new Float32Array(w * spanY);

  for (let y = 0; y < h; y++) {
    const rowBase = y * w;
    const cur = (y % spanY) * w;
    const leftToRight = !serpentine || (y & 1) === 0;
    const start = leftToRight ? 0 : w - 1;
    const stop = leftToRight ? w : -1;
    const dir = leftToRight ? 1 : -1;

    for (let x = start; x !== stop; x += dir) {
      const value = gray[rowBase + x] + bias + err[cur + x];
      const q = quantise(value, steps);
      dst[rowBase + x] = q * 255;
      const residual = value - q;
      if (residual === 0) continue;

      for (let i = 0; i < n; i++) {
        const nx = x + tdx[i] * dir;
        if (nx < 0 || nx >= w) continue;
        const ny = y + tdy[i];
        if (ny >= h) continue;
        err[((ny % spanY) * w) + nx] += residual * tw[i];
      }
    }

    // Recycle this row's slot for the row `spanY` further down.
    err.fill(0, cur, cur + w);
  }

  return dst;
}

/** Snap to the nearest of `steps + 1` evenly spaced levels, result in [0,1]. */
function quantise(v, steps) {
  const c = v < 0 ? 0 : v > 1 ? 1 : v;
  return Math.round(c * steps) / steps;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
