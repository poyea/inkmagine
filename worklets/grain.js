// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

/* CSS Houdini paint worklets.
 *
 * The machine's surface is drawn rather than shipped: no texture files, and it
 * stays crisp at any zoom or pixel ratio. Each worklet paints one tile that
 * CSS then repeats, so the cost is bounded by `background-size`, not by how
 * large the element is.
 *
 * Chromium-only today. `src/ui/grain.js` adds a `.no-houdini` class elsewhere
 * and the stylesheet falls back to plain gradients.
 */

/** Deterministic hash -> [0,1). Stable across repaints, unlike Math.random. */
function rand(x, y, salt) {
  let h = (x * 374761393 + y * 668265263 + salt * 2246822519) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

function readNumber(props, name, fallback) {
  const raw = props.get(name);
  if (raw === undefined || raw === null) return fallback;
  const value = parseFloat(typeof raw.value === 'number' ? raw.value : String(raw));
  return Number.isFinite(value) ? value : fallback;
}

function readColour(props, name, fallback) {
  const raw = props.get(name);
  const text = String(raw ?? '').trim();
  return text || fallback;
}

/** Paper fibre: short specks and flecks at low contrast. */
class InkGrain {
  static get inputProperties() {
    return ['--grain-ink', '--grain-density', '--grain-seed', '--grain-strength'];
  }

  paint(ctx, size, props) {
    const ink = readColour(props, '--grain-ink', '#17140f');
    const density = readNumber(props, '--grain-density', 0.5);
    const seed = readNumber(props, '--grain-seed', 1);
    const strength = readNumber(props, '--grain-strength', 0.06);

    const cell = 4;
    const cols = Math.ceil(size.width / cell);
    const rows = Math.ceil(size.height / cell);
    ctx.fillStyle = ink;

    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        if (rand(gx, gy, seed) > density) continue;
        const x = gx * cell + rand(gx, gy, seed + 11) * cell;
        const y = gy * cell + rand(gx, gy, seed + 23) * cell;
        const long = rand(gx, gy, seed + 37);
        ctx.globalAlpha = strength * (0.35 + rand(gx, gy, seed + 51) * 0.65);
        if (long > 0.86) {
          // Occasional fibre rather than a speck.
          ctx.fillRect(x, y, 1 + long * 3, 1);
        } else {
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
    ctx.globalAlpha = 1;
  }
}

/** A 45-degree clustered dot field, for decorative rules and headers. */
class InkHalftone {
  static get inputProperties() {
    return ['--halftone-ink', '--halftone-pitch', '--halftone-radius', '--halftone-strength'];
  }

  paint(ctx, size, props) {
    const ink = readColour(props, '--halftone-ink', '#17140f');
    const pitch = Math.max(3, readNumber(props, '--halftone-pitch', 6));
    const radius = readNumber(props, '--halftone-radius', 0.3);
    const strength = readNumber(props, '--halftone-strength', 0.5);

    ctx.fillStyle = ink;
    ctx.globalAlpha = strength;
    const step = pitch;
    const rows = Math.ceil(size.height / step) + 1;
    const cols = Math.ceil(size.width / step) + 1;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        // Offsetting alternate rows by half a pitch gives the 45-degree look.
        const x = col * step + (row % 2 ? step / 2 : 0);
        const y = row * step;
        ctx.beginPath();
        ctx.arc(x, y, step * radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
}

registerPaint('inkgrain', InkGrain);
registerPaint('inkhalftone', InkHalftone);
