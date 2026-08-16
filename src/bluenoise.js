// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// Void-and-cluster blue-noise threshold matrix (Ulichney, 1993).
//
// A 64x64 tile whose ranks, when used as an ordered-dither threshold map,
// scatter dots with no visible structure at any grey level. Generation is a
// few hundred milliseconds, so it happens once, lazily, and is cached.

const SIZE = 64; // must be a power of two: wrap-around uses a bit mask
const SIGMA = 1.9;
const RADIUS = 6;

let cached = null;

/** @returns {{size: number, data: Float32Array}} thresholds in (0,1) */
export function blueNoise() {
  if (!cached) cached = generate(SIZE);
  return cached;
}

/** True once the tile is built, so the UI can warn before a blocking call. */
export function blueNoiseReady() {
  return cached !== null;
}

function generate(n) {
  const total = n * n;
  const mask = n - 1;

  // Flat gaussian kernel: parallel arrays beat tuples in this hot loop.
  const kx = [];
  const ky = [];
  const kw = [];
  for (let dy = -RADIUS; dy <= RADIUS; dy++) {
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      const w = Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA));
      if (w < 1e-4) continue;
      kx.push(dx);
      ky.push(dy);
      kw.push(w);
    }
  }
  const klen = kw.length;

  const energy = new Float64Array(total);
  const pattern = new Uint8Array(total);

  const bump = (p, sign) => {
    const px = p & mask;
    const py = p >> 6; // log2(SIZE)
    for (let i = 0; i < klen; i++) {
      const x = (px + kx[i]) & mask;
      const y = (py + ky[i]) & mask;
      energy[y * n + x] += sign * kw[i];
    }
  };

  const tightestCluster = () => {
    let best = -1;
    let bestE = -Infinity;
    for (let i = 0; i < total; i++) {
      if (pattern[i] === 1 && energy[i] > bestE) {
        bestE = energy[i];
        best = i;
      }
    }
    return best;
  };

  const largestVoid = () => {
    let best = -1;
    let bestE = Infinity;
    for (let i = 0; i < total; i++) {
      if (pattern[i] === 0 && energy[i] < bestE) {
        bestE = energy[i];
        best = i;
      }
    }
    return best;
  };

  // --- Phase 0: scatter a sparse seed, then relax it into a blue-noise set.
  const seeds = Math.round(total * 0.1);
  let placed = 0;
  while (placed < seeds) {
    const p = (Math.random() * total) | 0;
    if (pattern[p]) continue;
    pattern[p] = 1;
    bump(p, 1);
    placed++;
  }

  for (let guard = 0; guard < total * 4; guard++) {
    const cluster = tightestCluster();
    pattern[cluster] = 0;
    bump(cluster, -1);
    const empty = largestVoid();
    if (empty === cluster) {
      // Removing the densest point opened the biggest hole: already relaxed.
      pattern[cluster] = 1;
      bump(cluster, 1);
      break;
    }
    pattern[empty] = 1;
    bump(empty, 1);
  }

  const rank = new Int32Array(total);
  const seedPattern = pattern.slice();
  const seedEnergy = energy.slice();

  // --- Phase 1: strip the seed set back to nothing, ranking downward.
  for (let r = seeds - 1; r >= 0; r--) {
    const p = tightestCluster();
    pattern[p] = 0;
    bump(p, -1);
    rank[p] = r;
  }

  // --- Phase 2+3: refill from the seed set, ranking upward. Once the ones are
  // in the majority "tightest cluster of zeros" and "largest void" pick the
  // same pixel, so both phases collapse into this one loop.
  pattern.set(seedPattern);
  energy.set(seedEnergy);
  for (let r = seeds; r < total; r++) {
    const p = largestVoid();
    pattern[p] = 1;
    bump(p, 1);
    rank[p] = r;
  }

  const data = new Float32Array(total);
  for (let i = 0; i < total; i++) data[i] = (rank[i] + 0.5) / total;
  return { size: n, data };
}
