// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// The specimen tray: the interactive crop view.
//
// The frame never moves. Dragging, pinching and turning move the *image*
// underneath it, which keeps the output aspect exact by construction.

import { levelFor } from '../source.js';
import { applyGeoTransform } from '../pipeline.js';
import {
  linear, invertLinear, apply, clampCentre, zoomAround, clamp,
} from '../transform.js';

const PADDING = 30;
const SCALE_LIMITS = { min: 0.01, max: 40 };

export class Stage {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onChange:(geo:object)=>void, onCommit?:()=>void, getState:()=>object}} opts
   */
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts;
    this.pointers = new Map();
    this.gesture = null;
    this.theme = { ink: '#16130f', paper: '#e9e3d6', red: '#c2352a' };

    this.observer = new ResizeObserver(() => this.draw());
    this.observer.observe(canvas);

    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('dblclick', () => this.opts.onFit?.());
    canvas.addEventListener('keydown', (e) => this.onKey(e));
  }

  refreshTheme() {
    const styles = getComputedStyle(this.canvas);
    const read = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
    this.theme = {
      ink: read('--ink', '#16130f'),
      paper: read('--paper', '#e9e3d6'),
      red: read('--red', '#c2352a'),
      muted: read('--ink-soft', '#4a443a'),
    };
  }

  /** Geometry of the frame within the canvas, in CSS pixels. */
  layout() {
    const rect = this.canvas.getBoundingClientRect();
    const { width: outW, height: outH } = this.opts.getState().output;
    const avail = { w: Math.max(40, rect.width - PADDING * 2), h: Math.max(40, rect.height - PADDING * 2) };
    const d = Math.min(avail.w / outW, avail.h / outH);
    return {
      rect,
      d,
      outW,
      outH,
      fw: outW * d,
      fh: outH * d,
      cx: rect.width / 2,
      cy: rect.height / 2,
    };
  }

  draw() {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const l = this.layout();
    const pxW = Math.max(1, Math.round(l.rect.width * dpr));
    const pxH = Math.max(1, Math.round(l.rect.height * dpr));
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, l.rect.width, l.rect.height);

    const state = this.opts.getState();
    const { source, geo, output } = state;
    const x0 = l.cx - l.fw / 2;
    const y0 = l.cy - l.fh / 2;

    if (source) {
      const level = levelFor(source, geo.scale * l.d);
      // Ghost: the parts of the image that will be cropped away.
      ctx.save();
      ctx.globalAlpha = 0.2;
      ctx.imageSmoothingQuality = 'high';
      applyGeoTransform(ctx, geo, level, l.cx, l.cy, l.d);
      ctx.drawImage(level.image, 0, 0);
      ctx.restore();
    }

    // Matte inside the frame, then the kept region at full strength.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, l.fw, l.fh);
    ctx.clip();
    ctx.fillStyle = output.matte ? '#ffffff' : '#000000';
    ctx.fillRect(x0, y0, l.fw, l.fh);
    if (source) {
      const level = levelFor(source, geo.scale * l.d);
      ctx.imageSmoothingQuality = 'high';
      applyGeoTransform(ctx, geo, level, l.cx, l.cy, l.d);
      ctx.drawImage(level.image, 0, 0);
    }
    ctx.restore();

    this.drawFrame(ctx, l, x0, y0, state);
  }

  drawFrame(ctx, l, x0, y0, state) {
    const { ink, red, muted } = this.theme;

    if (state.output.grid) {
      ctx.save();
      ctx.strokeStyle = ink;
      ctx.globalAlpha = 0.28;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      for (let i = 1; i < 3; i++) {
        const gx = Math.round(x0 + (l.fw * i) / 3) + 0.5;
        const gy = Math.round(y0 + (l.fh * i) / 3) + 0.5;
        ctx.moveTo(gx, y0);
        ctx.lineTo(gx, y0 + l.fh);
        ctx.moveTo(x0, gy);
        ctx.lineTo(x0 + l.fw, gy);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Frame edge.
    ctx.save();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2;
    ctx.strokeRect(Math.round(x0) + 1, Math.round(y0) + 1, Math.round(l.fw) - 2, Math.round(l.fh) - 2);

    // Registration crosses at the corners, printer's-mark style.
    ctx.strokeStyle = red;
    ctx.lineWidth = 1;
    const arm = 9;
    const gap = 7;
    for (const [px, py] of [[x0, y0], [x0 + l.fw, y0], [x0, y0 + l.fh], [x0 + l.fw, y0 + l.fh]]) {
      const sx = px < l.cx ? -1 : 1;
      const sy = py < l.cy ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(px + sx * gap, py);
      ctx.lineTo(px + sx * (gap + arm), py);
      ctx.moveTo(px, py + sy * gap);
      ctx.lineTo(px, py + sy * (gap + arm));
      ctx.stroke();
    }

    // Caption.
    ctx.fillStyle = muted;
    ctx.font = '600 10px ui-monospace, "Cascadia Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(
      `${l.outW} × ${l.outH}`,
      l.cx,
      Math.min(l.rect.height - 6, y0 + l.fh + 16),
    );
    ctx.restore();
  }

  // --- input ---------------------------------------------------------------

  /** Canvas CSS coords -> output-frame coords, measured from the centre. */
  toFrame(event, l = this.layout()) {
    return {
      x: (event.clientX - l.rect.left - l.cx) / l.d,
      y: (event.clientY - l.rect.top - l.cy) / l.d,
    };
  }

  onPointerDown(event) {
    if (!this.opts.getState().source) return;
    event.preventDefault();
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.focus({ preventScroll: true });
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.canvas.classList.add('is-dragging');
    this.startGesture();
  }

  onPointerMove(event) {
    if (!this.pointers.has(event.pointerId)) return;
    event.preventDefault();
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 1) this.dragPan();
    else this.dragPinch();
  }

  onPointerUp(event) {
    if (!this.pointers.delete(event.pointerId)) return;
    this.canvas.releasePointerCapture?.(event.pointerId);
    if (this.pointers.size === 0) {
      this.gesture = null;
      this.canvas.classList.remove('is-dragging');
      this.opts.onCommit?.();
    } else {
      this.startGesture();
    }
  }

  /** Re-baseline whenever the number of fingers changes. */
  startGesture() {
    const l = this.layout();
    const points = [...this.pointers.values()];
    const geo = { ...this.opts.getState().geo };
    if (points.length === 1) {
      this.gesture = { kind: 'pan', geo, l, origin: points[0] };
      return;
    }
    const [a, b] = points;
    this.gesture = {
      kind: 'pinch',
      geo,
      l,
      dist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  }

  dragPan() {
    const g = this.gesture;
    if (!g || g.kind !== 'pan') return;
    const now = [...this.pointers.values()][0];
    const dx = (now.x - g.origin.x) / g.l.d;
    const dy = (now.y - g.origin.y) / g.l.d;
    // Dragging right should move the image right, so the centre moves left.
    const inv = invertLinear(linear(g.geo));
    const delta = apply(inv, dx, dy);
    this.push({ ...g.geo, cx: g.geo.cx - delta.x, cy: g.geo.cy - delta.y });
  }

  dragPinch() {
    const g = this.gesture;
    if (!g || g.kind !== 'pinch') return;
    const [a, b] = [...this.pointers.values()];
    const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

    let next = { ...g.geo };
    const turn = ((angle - g.angle) * 180) / Math.PI;
    if (this.opts.allowGestureRotate?.() !== false) {
      next.fine = clamp(g.geo.fine + turn, -180, 180);
    }

    // Zoom about the pinch midpoint, then follow the midpoint's own drift.
    const focus = {
      x: (g.mid.x - g.l.rect.left - g.l.cx) / g.l.d,
      y: (g.mid.y - g.l.rect.top - g.l.cy) / g.l.d,
    };
    next = zoomAround(next, dist / g.dist, focus.x, focus.y, SCALE_LIMITS);

    const inv = invertLinear(linear(next));
    const drift = apply(inv, (mid.x - g.mid.x) / g.l.d, (mid.y - g.mid.y) / g.l.d);
    next.cx -= drift.x;
    next.cy -= drift.y;
    this.push(next);
  }

  onWheel(event) {
    const state = this.opts.getState();
    if (!state.source) return;
    event.preventDefault();
    const l = this.layout();
    const focus = this.toFrame(event, l);
    // Trackpads report small deltas continuously; normalise to a gentle curve.
    const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025));
    this.push(zoomAround(state.geo, factor, focus.x, focus.y, SCALE_LIMITS));
    this.opts.onCommit?.();
  }

  onKey(event) {
    const state = this.opts.getState();
    if (!state.source) return;
    const geo = state.geo;
    const step = event.shiftKey ? 10 : 1;
    const nudge = (dx, dy) => {
      const inv = invertLinear(linear(geo));
      const d = apply(inv, dx, dy);
      this.push({ ...geo, cx: geo.cx - d.x, cy: geo.cy - d.y });
    };

    switch (event.key) {
      case 'ArrowLeft': nudge(-step, 0); break;
      case 'ArrowRight': nudge(step, 0); break;
      case 'ArrowUp': nudge(0, -step); break;
      case 'ArrowDown': nudge(0, step); break;
      case '+': case '=':
        this.push(zoomAround(geo, 1.1, 0, 0, SCALE_LIMITS)); break;
      case '-': case '_':
        this.push(zoomAround(geo, 1 / 1.1, 0, 0, SCALE_LIMITS)); break;
      default:
        return;
    }
    event.preventDefault();
    this.opts.onCommit?.();
  }

  push(geo) {
    const state = this.opts.getState();
    const next = state.source
      ? clampCentre(geo, state.source.width, state.source.height, state.output.width, state.output.height)
      : geo;
    this.opts.onChange(next);
  }
}

export { SCALE_LIMITS };
