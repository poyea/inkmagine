// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// Geometry between source-image pixels and output-frame pixels.
//
// The crop frame never moves: it is always the output rectangle, centred. The
// *image* moves under it. `geo` describes that movement:
//
//   scale     output pixels per source pixel
//   cx, cy    the source pixel parked at the centre of the frame
//   quarter   0..3, whole 90-degree turns
//   fine      -45..45, free rotation on top of the quarter turns
//   flipH/V   mirror before rotation

export function defaultGeo() {
  return { scale: 1, cx: 0, cy: 0, quarter: 0, fine: 0, flipH: false, flipV: false };
}

/** Total rotation in radians. */
export function angleOf(geo) {
  return ((geo.quarter * 90 + geo.fine) * Math.PI) / 180;
}

/**
 * The 2x2 linear part mapping a source-space delta to an output-space delta:
 * rotate . mirror . scale, as [[a, b], [c, d]].
 */
export function linear(geo) {
  const t = angleOf(geo);
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const fx = geo.flipH ? -geo.scale : geo.scale;
  const fy = geo.flipV ? -geo.scale : geo.scale;
  return { a: cos * fx, b: -sin * fy, c: sin * fx, d: cos * fy };
}

export function invertLinear(m) {
  const det = m.a * m.d - m.b * m.c;
  if (!det) return { a: 0, b: 0, c: 0, d: 0 };
  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det };
}

export function apply(m, x, y) {
  return { x: m.a * x + m.b * y, y: m.c * x + m.d * y };
}

/** Source pixel currently under a point given in output coords from the frame centre. */
export function sourceAt(geo, ox, oy) {
  const inv = invertLinear(linear(geo));
  const p = apply(inv, ox, oy);
  return { x: geo.cx + p.x, y: geo.cy + p.y };
}

/** Axis-aligned bounds of the rotated, scaled source, in output pixels. */
export function rotatedBounds(geo, srcW, srcH) {
  const t = angleOf(geo);
  const cos = Math.abs(Math.cos(t));
  const sin = Math.abs(Math.sin(t));
  return {
    w: (srcW * cos + srcH * sin) * geo.scale,
    h: (srcW * sin + srcH * cos) * geo.scale,
  };
}

/**
 * Scale that makes the rotated source exactly contain ('fill') or fit inside
 * ('fit') the output frame.
 */
export function scaleFor(mode, geo, srcW, srcH, outW, outH) {
  const unit = rotatedBounds({ ...geo, scale: 1 }, srcW, srcH);
  if (!unit.w || !unit.h) return 1;
  const sx = outW / unit.w;
  const sy = outH / unit.h;
  return mode === 'fill' ? Math.max(sx, sy) : Math.min(sx, sy);
}

export function frameGeo(mode, geo, srcW, srcH, outW, outH) {
  return { ...geo, scale: scaleFor(mode, geo, srcW, srcH, outW, outH), cx: srcW / 2, cy: srcH / 2 };
}

/**
 * Keep the image from being dragged entirely off the frame: the centre stays
 * within one frame-width of the image's bounding box.
 */
export function clampCentre(geo, srcW, srcH, outW, outH) {
  const inv = invertLinear(linear(geo));
  const half = apply(inv, outW / 2, outH / 2);
  const marginX = Math.abs(half.x) + srcW * 0.5;
  const marginY = Math.abs(half.y) + srcH * 0.5;
  return {
    ...geo,
    cx: clamp(geo.cx, srcW / 2 - marginX, srcW / 2 + marginX),
    cy: clamp(geo.cy, srcH / 2 - marginY, srcH / 2 + marginY),
  };
}

/** Zoom while pinning the source pixel currently under `(ox, oy)`. */
export function zoomAround(geo, factor, ox, oy, limits) {
  const pinned = sourceAt(geo, ox, oy);
  const scale = clamp(geo.scale * factor, limits.min, limits.max);
  const next = { ...geo, scale };
  const inv = invertLinear(linear(next));
  const back = apply(inv, ox, oy);
  next.cx = pinned.x - back.x;
  next.cy = pinned.y - back.y;
  return next;
}

/** Rotate about the frame centre, keeping the centred source pixel centred. */
export function rotateTo(geo, quarter, fine) {
  return { ...geo, quarter: ((quarter % 4) + 4) % 4, fine };
}

/**
 * Source-space rectangle currently visible through the frame. Only meaningful
 * as a readout: with rotation the true crop is a rotated quad.
 */
export function cropRect(geo, outW, outH) {
  const corners = [
    sourceAt(geo, -outW / 2, -outH / 2),
    sourceAt(geo, outW / 2, -outH / 2),
    sourceAt(geo, outW / 2, outH / 2),
    sourceAt(geo, -outW / 2, outH / 2),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return {
    x: Math.round(x0),
    y: Math.round(y0),
    w: Math.round(Math.max(...xs) - x0),
    h: Math.round(Math.max(...ys) - y0),
  };
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
