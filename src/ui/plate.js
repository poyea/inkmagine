// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// The plate: the finished image at 1:1, inside an e-paper module bezel.
//
// Two stacked canvases share the bezel. The WebGPU backend owns one and
// presents to it directly; the 2D one carries CPU renders, still frames and
// the develop animation. Only one is visible at a time.

import { toImageData } from '../pipeline.js';

const FLASH = [
  { until: 110, fill: '#000' },
  { until: 190, fill: '#fff' },
  { until: 255, fill: '#000' },
  { until: 330, fill: '#fff' },
];
const WIPE_START = 330;
const WIPE_END = 820;
const WIPE_BAND = 26;

export class Plate {
  constructor({ root, canvas2d, canvasGpu }) {
    this.root = root;
    this.canvas2d = canvas2d;
    this.canvasGpu = canvasGpu;
    this.ctx = canvas2d.getContext('2d', { alpha: false });
    this.ctx.imageSmoothingEnabled = false;
    this.width = 0;
    this.height = 0;
    this.zoom = 'fit';
    this.image = null;
    this.animation = null;
    this.backend = 'cpu';

    this.observer = new ResizeObserver(() => this.applyZoom());
    if (root.parentElement) this.observer.observe(root.parentElement);
  }

  setSize(width, height) {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.canvas2d.width = width;
    this.canvas2d.height = height;
    this.ctx.imageSmoothingEnabled = false;
    this.image = null;
    this.applyZoom();
  }

  setZoom(zoom) {
    this.zoom = zoom;
    this.applyZoom();
  }

  /** Actual on-screen scale, resolving 'fit' against the available box. */
  effectiveZoom() {
    if (this.zoom !== 'fit') return this.zoom;
    const box = this.root.parentElement?.getBoundingClientRect();
    if (!box || !this.width) return 1;
    // Leave room for the bezel and the label strip beneath it.
    const avail = { w: box.width - 34, h: box.height - 54 };
    return Math.max(0.05, Math.min(avail.w / this.width, avail.h / this.height, 4));
  }

  applyZoom() {
    if (!this.width) return;
    const z = this.effectiveZoom();
    const w = `${Math.round(this.width * z)}px`;
    const h = `${Math.round(this.height * z)}px`;
    for (const canvas of [this.canvas2d, this.canvasGpu]) {
      canvas.style.width = w;
      canvas.style.height = h;
    }
    this.root.style.setProperty('--plate-zoom', String(z));
    // Deliberately not `data-zoom`: that attribute selects the zoom chips.
    this.root.dataset.plateZoom = this.zoom === 'fit' ? 'fit' : `${Math.round(z * 100)}%`;
  }

  showBackend(backend) {
    this.backend = backend;
    const gpu = backend === 'gpu';
    this.canvasGpu.hidden = !gpu;
    this.canvas2d.hidden = gpu;
  }

  /** Draw rendered greyscale bytes onto the 2D canvas. */
  paint(bytes, width, height) {
    this.setSize(width, height);
    this.image = toImageData(bytes, width, height, this.image);
    this.ctx.putImageData(this.image, 0, 0);
  }

  /**
   * The e-paper refresh: a few full-panel inversions, then a wipe that lays
   * the new image down a band at a time. Purely cosmetic, and skipped when
   * the visitor has asked for reduced motion.
   */
  develop(bytes, width, height) {
    this.cancel();
    this.setSize(width, height);
    this.image = toImageData(bytes, width, height, this.image);

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // Always animate on the 2D surface, then hand back to whoever was showing.
    const previous = this.backend;
    this.showBackend('cpu');
    this.root.classList.add('is-developing');

    if (reduced) {
      this.ctx.putImageData(this.image, 0, 0);
      this.finish(previous);
      return Promise.resolve();
    }

    const buffer = document.createElement('canvas');
    buffer.width = width;
    buffer.height = height;
    buffer.getContext('2d').putImageData(this.image, 0, 0);

    return new Promise((resolve) => {
      const start = performance.now();
      const step = (now) => {
        const t = now - start;
        const ctx = this.ctx;

        const flash = FLASH.find((f) => t < f.until);
        if (flash) {
          ctx.fillStyle = flash.fill;
          ctx.fillRect(0, 0, width, height);
        } else if (t < WIPE_END) {
          const p = (t - WIPE_START) / (WIPE_END - WIPE_START);
          const edge = Math.round(p * (height + WIPE_BAND));
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, width, height);
          const revealed = Math.max(0, edge - WIPE_BAND);
          if (revealed > 0) ctx.drawImage(buffer, 0, 0, width, revealed, 0, 0, width, revealed);
          if (edge > 0 && revealed < height) {
            ctx.fillStyle = '#000';
            ctx.fillRect(0, revealed, width, Math.min(WIPE_BAND, height - revealed));
          }
        } else {
          ctx.putImageData(this.image, 0, 0);
          this.animation = null;
          this.finish(previous);
          resolve();
          return;
        }
        this.animation = requestAnimationFrame(step);
      };
      this.animation = requestAnimationFrame(step);
    });
  }

  finish(previous) {
    this.root.classList.remove('is-developing');
    this.showBackend(previous);
  }

  cancel() {
    if (this.animation) {
      cancelAnimationFrame(this.animation);
      this.animation = null;
      this.root.classList.remove('is-developing');
    }
  }
}
