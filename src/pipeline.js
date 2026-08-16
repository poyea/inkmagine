// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// The CPU rendering path: compose -> luma -> tone -> sharpen -> screen.
//
// This is the reference implementation. The WebGPU backend mirrors it for the
// parallel screens; anything error-diffused always comes through here.

import { levelFor } from './source.js';
import { angleOf } from './transform.js';
import { toLuma, applyTone, sharpen, autoLevels, coverage } from './tone.js';
import { screen } from './dither.js';

/**
 * Put a source image on a 2D context under `geo`, with the frame centred at
 * (centreX, centreY) and an extra on-screen `displayScale`.
 */
export function applyGeoTransform(ctx, geo, level, centreX, centreY, displayScale = 1) {
  ctx.translate(centreX, centreY);
  ctx.scale(displayScale, displayScale);
  ctx.rotate(angleOf(geo));
  ctx.scale(geo.flipH ? -1 : 1, geo.flipV ? -1 : 1);
  ctx.scale(geo.scale / level.rx, geo.scale / level.ry);
  ctx.translate(-geo.cx * level.rx, -geo.cy * level.ry);
}

export class CpuRenderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    this.w = 0;
    this.h = 0;
    this.gray = null;
    this.bytes = null;
  }

  resize(w, h) {
    if (this.w === w && this.h === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.w = w;
    this.h = h;
    this.gray = new Float32Array(w * h);
    this.bytes = new Uint8ClampedArray(w * h);
  }

  /** Draw the cropped region at output resolution and return it as RGBA. */
  compose(source, geo, w, h, matte) {
    this.resize(w, h);
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = matte ? '#ffffff' : '#000000';
    ctx.fillRect(0, 0, w, h);
    if (source) {
      const level = levelFor(source, geo.scale);
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      applyGeoTransform(ctx, geo, level, w / 2, h / 2);
      ctx.drawImage(level.image, 0, 0);
      ctx.restore();
    }
    return ctx.getImageData(0, 0, w, h);
  }

  /** Composed luma with no tonal shaping applied: what AUTO TONE measures. */
  luma(source, geo, w, h, matte) {
    const rgba = this.compose(source, geo, w, h, matte);
    return toLuma(rgba.data, this.gray);
  }

  /**
   * @param {object} source
   * @param {object} geo
   * @param {{width:number, height:number, matte:number, tone:object, screen:object}} settings
   * @returns {{bytes: Uint8ClampedArray, width:number, height:number, backend:string}}
   */
  render(source, geo, settings) {
    const { width, height, matte, tone, screen: screenOpts } = settings;
    const gray = this.luma(source, geo, width, height, matte);
    // Tone describes what to do *to an image*. With none loaded there is
    // nothing to shape, and inverting a bare white matte yields a solid black
    // plate, which reads as a failure rather than as an empty plate.
    if (source) {
      applyTone(gray, tone);
      sharpen(gray, width, height, tone.sharpen, tone.radius);
    }
    const bytes = screen(gray, width, height, screenOpts, this.bytes);
    return { bytes, width, height, backend: 'cpu' };
  }

  measure(source, geo, settings) {
    const gray = this.luma(source, geo, settings.width, settings.height, settings.matte);
    return autoLevels(gray);
  }
}

/** Greyscale bytes -> an RGBA ImageData ready for putImageData. */
export function toImageData(bytes, width, height, target) {
  const image = target && target.width === width && target.height === height
    ? target
    : new ImageData(width, height);
  const rgba = image.data;
  for (let i = 0, j = 0; i < bytes.length; i++, j += 4) {
    const v = bytes[i];
    rgba[j] = v;
    rgba[j + 1] = v;
    rgba[j + 2] = v;
    rgba[j + 3] = 255;
  }
  return image;
}

export { coverage };
