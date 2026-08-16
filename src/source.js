// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// Decoding source images and building a mip pyramid for clean downscaling.
//
// Browsers downscale a large bitmap in one bilinear step, which aliases badly
// when you are going from 24 megapixels to 480x800. Halving repeatedly and
// drawing from the level nearest the target scale fixes that for free.

const MAX_SOURCE_EDGE = 6000; // guards memory on phone-camera-sized input
const MIN_LEVEL_EDGE = 32;

export const ACCEPTED = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif,image/svg+xml';

/**
 * @typedef {object} Source
 * @property {string} name
 * @property {number} width  full-resolution width
 * @property {number} height
 * @property {number} decodedWidth  width before any oversize clamp
 * @property {number} decodedHeight
 * @property {Array<{image: CanvasImageSource, w: number, h: number, rx: number, ry: number}>} levels
 * @property {ImageBitmap|HTMLCanvasElement} base
 */

export async function loadFile(file) {
  if (!file) throw new Error('no file');
  if (file.type && !file.type.startsWith('image/')) {
    throw new Error(`${file.name || 'file'} is not an image`);
  }
  const bitmap = await decode(file);
  return fromBitmap(bitmap, file.name || 'untitled');
}

async function decode(blob) {
  // `imageOrientation: 'from-image'` applies the EXIF rotation that phone
  // cameras rely on. Firefox and Safari honour it; the <img> fallback below
  // gets the same behaviour for free because the tag applies EXIF itself.
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('could not decode image'));
      img.src = url;
    });
    if (img.decode) await img.decode().catch(() => {});
    return img;
  } finally {
    // Revoke on the next tick so an in-flight decode is not cut off.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** @returns {Source} */
export function fromBitmap(bitmap, name) {
  const decodedWidth = bitmap.naturalWidth || bitmap.width;
  const decodedHeight = bitmap.naturalHeight || bitmap.height;
  if (!decodedWidth || !decodedHeight) throw new Error('image has no dimensions');

  let base = bitmap;
  let width = decodedWidth;
  let height = decodedHeight;

  const longest = Math.max(width, height);
  if (longest > MAX_SOURCE_EDGE) {
    const k = MAX_SOURCE_EDGE / longest;
    width = Math.max(1, Math.round(width * k));
    height = Math.max(1, Math.round(height * k));
    base = drawTo(bitmap, width, height);
  } else if (bitmap instanceof HTMLImageElement) {
    // Normalise the <img> fallback to a canvas so every consumer, including
    // the WebGPU texture upload, gets a type it can handle.
    base = drawTo(bitmap, width, height);
  }

  return { name, width, height, decodedWidth, decodedHeight, base, levels: buildLevels(base, width, height) };
}

function buildLevels(base, width, height) {
  const levels = [{ image: base, w: width, h: height, rx: 1, ry: 1 }];
  let prev = levels[0];
  while (prev.w > MIN_LEVEL_EDGE && prev.h > MIN_LEVEL_EDGE) {
    const w = Math.max(1, Math.floor(prev.w / 2));
    const h = Math.max(1, Math.floor(prev.h / 2));
    const canvas = drawTo(prev.image, w, h);
    prev = { image: canvas, w, h, rx: w / width, ry: h / height };
    levels.push(prev);
  }
  return levels;
}

function drawTo(image, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, w, h);
  return canvas;
}

/**
 * Pick the pyramid level closest to (but not below) the requested scale, so
 * the final draw is always a downscale of at most 2x.
 */
export function levelFor(source, scale) {
  if (!(scale > 0) || scale >= 1) return source.levels[0];
  const wanted = Math.floor(Math.log2(1 / scale));
  return source.levels[Math.min(wanted, source.levels.length - 1)];
}

export function release(source) {
  if (source?.base && typeof ImageBitmap !== 'undefined' && source.base instanceof ImageBitmap) {
    source.base.close();
  }
}

/**
 * A synthetic calibration target: step wedge, ramp, concentric rings and a
 * line burst. Handy for judging a screen before committing a real photo, and
 * it means the tool is usable with nothing loaded.
 */
export function testWedge(w = 1200, h = 2000) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);

  // Continuous ramp.
  const ramp = ctx.createLinearGradient(0, 0, w, 0);
  ramp.addColorStop(0, '#000');
  ramp.addColorStop(1, '#fff');
  ctx.fillStyle = ramp;
  ctx.fillRect(0, 0, w, h * 0.14);

  // 21-step wedge.
  const steps = 21;
  const stepW = w / steps;
  for (let i = 0; i < steps; i++) {
    const v = Math.round((i / (steps - 1)) * 255);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(i * stepW, h * 0.14, stepW + 1, h * 0.1);
  }

  // Concentric rings: shows moire and dot-gain in halftone screens.
  const cx = w * 0.5;
  const cy = h * 0.44;
  const maxR = Math.min(w, h * 0.36) * 0.46;
  ctx.strokeStyle = '#000';
  for (let r = maxR; r > 2; r -= 14) {
    ctx.lineWidth = Math.max(1, r / 40);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Radial line burst: resolution and aliasing.
  const by = h * 0.68;
  const burstR = Math.min(w * 0.42, h * 0.15);
  ctx.fillStyle = '#000';
  for (let i = 0; i < 64; i++) {
    const a0 = (i / 64) * Math.PI * 2;
    const a1 = a0 + Math.PI / 64;
    ctx.beginPath();
    ctx.moveTo(w * 0.5, by);
    ctx.arc(w * 0.5, by, burstR, a0, a1);
    ctx.closePath();
    ctx.fill();
  }

  // Fine checkerboards at 1, 2 and 4 pixels.
  const cbTop = h * 0.84;
  const cbH = h * 0.08;
  [1, 2, 4].forEach((size, i) => {
    const x0 = (i * w) / 3;
    for (let y = 0; y < cbH; y += size) {
      for (let x = 0; x < w / 3; x += size) {
        ctx.fillStyle = ((x / size + y / size) | 0) % 2 ? '#fff' : '#000';
        ctx.fillRect(x0 + x, cbTop + y, size, size);
      }
    }
  });

  ctx.fillStyle = '#000';
  ctx.font = `600 ${Math.round(h * 0.045)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('INKMAGINE', w * 0.04, h * 0.98);
  ctx.font = `${Math.round(h * 0.022)}px ui-monospace, Consolas, monospace`;
  ctx.fillText('TEST WEDGE', w * 0.62, h * 0.98);

  return fromBitmap(canvas, 'test-wedge');
}
