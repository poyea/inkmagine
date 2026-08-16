// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// Tests for the parts of inkmagine that do not need a DOM: geometry, tone,
// screening, blue noise, 1-bpp packing and the ZIP writer.
//
//   npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultGeo, linear, invertLinear, apply, sourceAt, rotatedBounds,
  scaleFor, frameGeo, zoomAround, cropRect, clamp,
} from '../src/transform.js';
import { toLuma, applyTone, sharpen, autoLevels, coverage } from '../src/tone.js';
import { screen, ALGORITHMS, algorithm, isParallel, thresholdMatrix } from '../src/dither.js';
import { blueNoise } from '../src/bluenoise.js';
import { packMono, outputName, formatBytes, encodeHeader } from '../src/export.js';
import { makeZip } from '../src/zip.js';
import { PRESETS, findPreset, clampDimension } from '../src/presets.js';

const flat = (n, value) => Float32Array.from({ length: n }, () => value);
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

// ------------------------------------------------------------------ geometry

test('linear and invertLinear round-trip an arbitrary delta', () => {
  const geo = { ...defaultGeo(), scale: 2.5, quarter: 1, fine: 17, flipH: true };
  const m = linear(geo);
  const inv = invertLinear(m);
  const forward = apply(m, 13, -7);
  const back = apply(inv, forward.x, forward.y);
  assert.ok(Math.abs(back.x - 13) < 1e-9, `x round-trip ${back.x}`);
  assert.ok(Math.abs(back.y - -7) < 1e-9, `y round-trip ${back.y}`);
});

test('sourceAt inverts the frame mapping', () => {
  const geo = { ...defaultGeo(), scale: 0.5, cx: 300, cy: 400, fine: 30 };
  // The frame centre must resolve to the parked source pixel.
  const centre = sourceAt(geo, 0, 0);
  assert.ok(Math.abs(centre.x - 300) < 1e-9);
  assert.ok(Math.abs(centre.y - 400) < 1e-9);

  // And an offset point must map back through the forward transform.
  const p = sourceAt(geo, 120, -80);
  const forward = apply(linear(geo), p.x - geo.cx, p.y - geo.cy);
  assert.ok(Math.abs(forward.x - 120) < 1e-8);
  assert.ok(Math.abs(forward.y - -80) < 1e-8);
});

test('rotatedBounds swaps axes at a quarter turn', () => {
  const geo = { ...defaultGeo(), quarter: 1 };
  const bounds = rotatedBounds(geo, 400, 100);
  assert.ok(Math.abs(bounds.w - 100) < 1e-9, `w ${bounds.w}`);
  assert.ok(Math.abs(bounds.h - 400) < 1e-9, `h ${bounds.h}`);
});

test('fit contains and fill covers the 480x800 frame', () => {
  const geo = defaultGeo();
  const fit = scaleFor('fit', geo, 1000, 1000, 480, 800);
  const fill = scaleFor('fill', geo, 1000, 1000, 480, 800);
  assert.equal(fit, 0.48);
  assert.equal(fill, 0.8);

  // Fill must leave no matte visible; fit must leave the whole image visible.
  const filled = rotatedBounds({ ...geo, scale: fill }, 1000, 1000);
  assert.ok(filled.w >= 480 - 1e-9 && filled.h >= 800 - 1e-9);
  const fitted = rotatedBounds({ ...geo, scale: fit }, 1000, 1000);
  assert.ok(fitted.w <= 480 + 1e-9 && fitted.h <= 800 + 1e-9);
});

test('frameGeo centres the source in the frame', () => {
  const geo = frameGeo('fill', defaultGeo(), 1600, 1200, 480, 800);
  assert.equal(geo.cx, 800);
  assert.equal(geo.cy, 600);
});

test('zoomAround keeps the pinned source pixel under the cursor', () => {
  const geo = { ...defaultGeo(), scale: 1, cx: 500, cy: 500, fine: 12 };
  const before = sourceAt(geo, 90, -40);
  const zoomed = zoomAround(geo, 2.3, 90, -40, { min: 0.01, max: 40 });
  const after = sourceAt(zoomed, 90, -40);
  assert.ok(Math.abs(after.x - before.x) < 1e-6, `x drifted ${after.x - before.x}`);
  assert.ok(Math.abs(after.y - before.y) < 1e-6, `y drifted ${after.y - before.y}`);
  assert.ok(Math.abs(zoomed.scale - 2.3) < 1e-12);
});

test('cropRect reports the source region behind the frame', () => {
  const geo = { ...defaultGeo(), scale: 2, cx: 100, cy: 200 };
  const rect = cropRect(geo, 480, 800);
  // At 2x, a 480x800 frame sees 240x400 source pixels centred on (100, 200).
  assert.equal(rect.w, 240);
  assert.equal(rect.h, 400);
  assert.equal(rect.x, -20);
  assert.equal(rect.y, 0);
});

test('clamp bounds both ends', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
});

// ---------------------------------------------------------------------- tone

test('toLuma weights the channels by Rec. 709', () => {
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
  const gray = toLuma(rgba);
  assert.ok(Math.abs(gray[0] - 0.2126) < 1e-4);
  assert.ok(Math.abs(gray[1] - 0.7152) < 1e-4);
  assert.ok(Math.abs(gray[2] - 0.0722) < 1e-4);
});

test('applyTone is a no-op at defaults', () => {
  const gray = Float32Array.from([0, 0.25, 0.5, 0.75, 1]);
  const copy = gray.slice();
  applyTone(gray, { brightness: 0, contrast: 1, gamma: 1, invert: false });
  assert.deepEqual([...gray], [...copy]);
});

test('applyTone inverts, brightens and stretches contrast', () => {
  const inverted = Float32Array.from([0.25]);
  applyTone(inverted, { brightness: 0, contrast: 1, gamma: 1, invert: true });
  assert.ok(Math.abs(inverted[0] - 0.75) < 2e-3, `got ${inverted[0]}`);

  const brighter = Float32Array.from([0.5]);
  applyTone(brighter, { brightness: 0.2, contrast: 1, gamma: 1, invert: false });
  assert.ok(Math.abs(brighter[0] - 0.7) < 2e-3, `got ${brighter[0]}`);

  const punchy = Float32Array.from([0.25]);
  applyTone(punchy, { brightness: 0, contrast: 2, gamma: 1, invert: false });
  assert.ok(Math.abs(punchy[0] - 0) < 2e-3, `got ${punchy[0]}`);
});

test('applyTone clamps rather than wrapping', () => {
  const gray = Float32Array.from([0, 1]);
  applyTone(gray, { brightness: 0.9, contrast: 3, gamma: 1, invert: false });
  assert.ok(gray[0] >= 0 && gray[0] <= 1);
  assert.ok(gray[1] >= 0 && gray[1] <= 1);
});

test('sharpen raises local contrast at an edge and leaves flats alone', () => {
  const w = 8;
  const h = 8;
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) gray[y * w + x] = x < 4 ? 0.3 : 0.7;
  const before = { dark: gray[8 * 3 + 3], light: gray[8 * 3 + 4] };
  sharpen(gray, w, h, 1, 1);
  assert.ok(gray[8 * 3 + 3] < before.dark, 'dark side of the edge should darken');
  assert.ok(gray[8 * 3 + 4] > before.light, 'light side of the edge should lighten');

  const evenField = flat(64, 0.42);
  sharpen(evenField, 8, 8, 1, 1);
  for (const v of evenField) assert.ok(Math.abs(v - 0.42) < 1e-6, 'flat field must not move');
});

test('autoLevels stretches a compressed range back to full', () => {
  // A ramp confined to [0.25, 0.75] should come back with contrast near 2.
  const gray = Float32Array.from({ length: 1000 }, (_, i) => 0.25 + (i / 999) * 0.5);
  const { brightness, contrast } = autoLevels(gray, 0.005);
  assert.ok(Math.abs(contrast - 2) < 0.1, `contrast ${contrast}`);

  const applied = gray.slice();
  applyTone(applied, { brightness, contrast, gamma: 1, invert: false });
  assert.ok(applied[0] < 0.05, `low end ${applied[0]}`);
  assert.ok(applied[applied.length - 1] > 0.95, `high end ${applied.at(-1)}`);
});

test('coverage counts pixels at or below mid grey', () => {
  assert.equal(coverage(new Uint8ClampedArray([0, 0, 255, 255])), 0.5);
  assert.equal(coverage(new Uint8ClampedArray([0, 0, 0, 0])), 1);
  assert.equal(coverage(new Uint8ClampedArray([128, 255])), 0);
});

// -------------------------------------------------------------------- screen

test('every algorithm produces a full plate of legal values', () => {
  const w = 32;
  const h = 24;
  const gray = Float32Array.from({ length: w * h }, (_, i) => (i % w) / (w - 1));
  for (const spec of ALGORITHMS) {
    const out = screen(gray.slice(), w, h, {
      algo: spec.id, levels: 2, strength: 1, bias: 0, serpentine: true,
    });
    assert.equal(out.length, w * h, `${spec.id} length`);
    if (spec.kind === 'none') continue;
    for (const v of out) {
      assert.ok(v === 0 || v === 255, `${spec.id} produced ${v} at 2 levels`);
    }
  }
});

test('levels quantise to evenly spaced greys', () => {
  const gray = Float32Array.from({ length: 256 }, (_, i) => i / 255);
  const out = screen(gray, 16, 16, { algo: 'threshold', levels: 4, strength: 1, bias: 0 });
  const seen = new Set(out);
  for (const v of seen) assert.ok([0, 85, 170, 255].includes(v), `unexpected level ${v}`);
  assert.equal(seen.size, 4);
});

test('hard threshold splits a ramp at the midpoint', () => {
  const gray = Float32Array.from({ length: 1000 }, (_, i) => i / 999);
  const out = screen(gray, 1000, 1, { algo: 'threshold', levels: 2, strength: 1, bias: 0 });
  const white = [...out].filter((v) => v === 255).length;
  assert.ok(Math.abs(white - 500) <= 2, `${white} white of 1000`);
});

test('bias shifts the threshold', () => {
  const gray = flat(1000, 0.5);
  const darker = screen(gray.slice(), 1000, 1, { algo: 'threshold', levels: 2, strength: 1, bias: -0.1 });
  const lighter = screen(gray.slice(), 1000, 1, { algo: 'threshold', levels: 2, strength: 1, bias: 0.1 });
  assert.ok([...darker].every((v) => v === 0), 'negative bias should go black');
  assert.ok([...lighter].every((v) => v === 255), 'positive bias should go white');
});

test('error diffusion preserves mean brightness on a flat field', () => {
  const w = 96;
  const h = 96;
  for (const algo of ['floyd', 'jjn', 'stucki', 'burkes', 'sierra3', 'sierra2', 'sierralite']) {
    for (const level of [0.25, 0.5, 0.75]) {
      const out = screen(flat(w * h, level), w, h, {
        algo, levels: 2, strength: 1, bias: 0, serpentine: true,
      });
      const got = mean([...out]) / 255;
      assert.ok(Math.abs(got - level) < 0.03, `${algo} at ${level} produced mean ${got.toFixed(3)}`);
    }
  }
});

test('ordered screens hit exactly half coverage on mid grey', () => {
  const w = 64;
  const h = 64;
  for (const algo of ['bayer2', 'bayer4', 'bayer8', 'halftone4', 'halftone8', 'bluenoise']) {
    const out = screen(flat(w * h, 0.5), w, h, { algo, levels: 2, strength: 1, bias: 0 });
    const got = mean([...out]) / 255;
    assert.ok(Math.abs(got - 0.5) < 0.02, `${algo} produced mean ${got.toFixed(3)}`);
  }
});

test('serpentine and raster scans both terminate and agree on brightness', () => {
  const w = 40;
  const h = 40;
  const gray = Float32Array.from({ length: w * h }, (_, i) => ((i % w) / (w - 1)) * 0.8 + 0.1);
  const raster = screen(gray.slice(), w, h, { algo: 'floyd', levels: 2, strength: 1, bias: 0, serpentine: false });
  const snake = screen(gray.slice(), w, h, { algo: 'floyd', levels: 2, strength: 1, bias: 0, serpentine: true });
  assert.ok(Math.abs(mean([...raster]) - mean([...snake])) < 6, 'scan order should not shift exposure');
});

test('atkinson deliberately loses some error in the extremes', () => {
  // Atkinson diffuses only 6/8, so a light field blows out toward paper.
  const out = screen(flat(64 * 64, 0.9), 64, 64, { algo: 'atkinson', levels: 2, strength: 1, bias: 0 });
  assert.ok(mean([...out]) / 255 > 0.9);
});

test('threshold matrices are normalised and complete', () => {
  for (const id of ['bayer2', 'bayer4', 'bayer8', 'halftone4', 'halftone8', 'line8']) {
    const { size, data } = thresholdMatrix(id);
    assert.equal(data.length, size * size, `${id} size`);
    for (const v of data) assert.ok(v > 0 && v < 1, `${id} value ${v} out of range`);
    const avg = mean([...data]);
    assert.ok(Math.abs(avg - 0.5) < 0.02, `${id} mean ${avg}`);
  }
});

test('isParallel matches what the GPU path can actually do', () => {
  assert.equal(isParallel('bayer4'), true);
  assert.equal(isParallel('bluenoise'), true);
  assert.equal(isParallel('threshold'), true);
  assert.equal(isParallel('none'), true);
  assert.equal(isParallel('floyd'), false);
  assert.equal(isParallel('atkinson'), false);
});

test('an unknown algorithm falls back rather than throwing', () => {
  assert.equal(algorithm('nonsense').id, 'floyd');
  const out = screen(flat(64, 0.5), 8, 8, { algo: 'nonsense', levels: 2, strength: 1, bias: 0 });
  assert.equal(out.length, 64);
});

// ----------------------------------------------------------------- bluenoise

test('blue noise is a complete, evenly distributed 64x64 rank map', () => {
  const { size, data } = blueNoise();
  assert.equal(size, 64);
  assert.equal(data.length, 4096);

  // Every rank must appear exactly once: the values are (rank + 0.5) / 4096.
  const ranks = new Set([...data].map((v) => Math.round(v * 4096 - 0.5)));
  assert.equal(ranks.size, 4096, 'ranks must be a permutation');
  assert.ok(Math.abs(mean([...data]) - 0.5) < 1e-6);
});

test('blue noise is cached, not regenerated', () => {
  assert.equal(blueNoise(), blueNoise());
});

test('blue noise has no low-frequency clumping', () => {
  // Split the tile into 8x8 blocks; each should hold close to half the
  // below-median values. Ordinary white noise fails this only rarely, but a
  // clumped or banded map fails it hard.
  const { size, data } = blueNoise();
  const block = 8;
  const perBlock = block * block;
  let worst = 0;
  for (let by = 0; by < size; by += block) {
    for (let bx = 0; bx < size; bx += block) {
      let below = 0;
      for (let y = 0; y < block; y++) {
        for (let x = 0; x < block; x++) below += data[(by + y) * size + bx + x] < 0.5 ? 1 : 0;
      }
      worst = Math.max(worst, Math.abs(below / perBlock - 0.5));
    }
  }
  assert.ok(worst < 0.22, `worst block deviation ${worst.toFixed(3)}`);
});

// ------------------------------------------------------------------- packing

test('packMono produces the expected buffer size for a 480x800 plate', () => {
  const bytes = new Uint8ClampedArray(480 * 800).fill(255);
  assert.equal(packMono(bytes, 480, 800, 'white1').length, 48_000);
});

test('packMono is MSB-first and honours polarity', () => {
  // One row of eight: white, black, white, black, ...
  const row = new Uint8ClampedArray([255, 0, 255, 0, 255, 0, 255, 0]);
  assert.equal(packMono(row, 8, 1, 'white1')[0], 0b10101010);
  assert.equal(packMono(row, 8, 1, 'black1')[0], 0b01010101);
});

test('packMono pads each row to a whole byte', () => {
  const bytes = new Uint8ClampedArray(10 * 3).fill(255);
  const packed = packMono(bytes, 10, 3, 'white1');
  assert.equal(packed.length, 6, 'ceil(10/8) = 2 bytes per row, 3 rows');
  // The 6 padding bits at the end of each row must stay clear.
  assert.equal(packed[1], 0b11000000);
});

test('packMono treats mid grey as white, matching the coverage readout', () => {
  assert.equal(packMono(new Uint8ClampedArray([128]), 1, 1, 'white1')[0], 0b10000000);
  assert.equal(packMono(new Uint8ClampedArray([127]), 1, 1, 'white1')[0], 0);
});

test('encodeHeader emits a compilable-looking C array of the right length', async () => {
  const bytes = new Uint8ClampedArray(16 * 8).fill(255);
  const text = await encodeHeader(bytes, 16, 8, { polarity: 'white1', symbol: 'my image!' }).text();
  assert.match(text, /#ifndef MY_IMAGE__H/);
  assert.match(text, /const uint8_t my_image_\[16\]/);
  assert.match(text, /#define MY_IMAGE__WIDTH  16/);
  assert.equal((text.match(/0x[0-9A-F]{2}/g) || []).length, 16);
  assert.ok(!/,\s*}/.test(text), 'no trailing comma before the closing brace');
});

test('encodeHeader names where the buffer came from', async () => {
  // The header is pasted into firmware and outlives the tab that made it, so
  // the provenance line is the only way back to the tool.
  const text = await encodeHeader(new Uint8ClampedArray(8).fill(0), 8, 1).text();
  assert.match(text, /Generated by inkmagine: https:\/\/github\.com\/poyea\/inkmagine\./);
});

test('outputName strips the extension and stamps the size', () => {
  assert.equal(outputName('beach.jpeg', 480, 800, 'jpg'), 'beach-480x800.jpg');
  assert.equal(outputName('a/b:c.png', 480, 800, 'bin'), 'a-b-c-480x800.bin');
  assert.equal(outputName('', 480, 800, 'png'), 'image-480x800.png');
});

test('formatBytes switches units sensibly', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 kB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MB');
});

// ----------------------------------------------------------------------- zip

test('makeZip writes a structurally valid store-only archive', async () => {
  const encoder = new TextEncoder();
  const entries = [
    { name: 'one.txt', data: encoder.encode('hello') },
    { name: 'two.bin', data: new Uint8Array([0, 1, 2, 3, 255]) },
  ];
  const blob = makeZip(entries);
  const buffer = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(buffer.buffer);

  assert.equal(blob.type, 'application/zip');
  assert.equal(view.getUint32(0, true), 0x04034b50, 'local header signature');

  // End of central directory sits in the last 22 bytes (no archive comment).
  const eocd = buffer.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50, 'EOCD signature');
  assert.equal(view.getUint16(eocd + 8, true), 2, 'entry count on this disk');
  assert.equal(view.getUint16(eocd + 10, true), 2, 'total entry count');

  const centralStart = view.getUint32(eocd + 16, true);
  const centralSize = view.getUint32(eocd + 12, true);
  assert.equal(centralStart + centralSize, eocd, 'central directory must abut the EOCD');
  assert.equal(view.getUint32(centralStart, true), 0x02014b50, 'central header signature');

  // Store means the payload is byte-identical and CRC32 must match.
  assert.equal(view.getUint32(14, true) >>> 0, 0x3610a686, 'CRC32 of "hello"');
  assert.equal(view.getUint16(8, true), 0, 'compression method must be store');
  const nameLen = view.getUint16(26, true);
  const payload = buffer.slice(30 + nameLen, 30 + nameLen + 5);
  assert.equal(new TextDecoder().decode(payload), 'hello');
});

test('makeZip handles an empty entry list', async () => {
  const buffer = new Uint8Array(await makeZip([]).arrayBuffer());
  assert.equal(buffer.length, 22);
  assert.equal(new DataView(buffer.buffer).getUint32(0, true), 0x06054b50);
});

// ------------------------------------------------------------------- presets

test('480x800 is the default preset and every preset is findable', () => {
  assert.equal(PRESETS[0].w, 480);
  assert.equal(PRESETS[0].h, 800);
  for (const preset of PRESETS) {
    assert.equal(findPreset(preset.w, preset.h)?.id, preset.id);
  }
  assert.equal(findPreset(7, 7), null);
});

test('clampDimension keeps sizes usable', () => {
  assert.equal(clampDimension(480), 480);
  assert.equal(clampDimension(0), 8);
  assert.equal(clampDimension(99_999), 8192);
  assert.equal(clampDimension('640.6'), 641);
  assert.equal(clampDimension('nonsense'), 8);
});
