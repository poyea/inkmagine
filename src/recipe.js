// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// A recipe is everything about how an image is *processed* (plate size, tone
// curve, screen) and nothing about how it is *framed*. Crop and rotation are
// measured in source pixels, so they are meaningless without the image that
// produced them, and a recipe has to outlive a reload that drops the image.
//
// Two serialisations, one schema:
//
//   toSearch()   w=800&alg=atkinson       the sharable half, for a URL hash
//   toStorage()  {"v":1,"w":800,…}        the whole thing, for localStorage
//
// Both emit only what differs from the defaults, so links stay short and a
// stored session never pins values the app later changes its mind about.
//
// Nothing here touches the DOM or localStorage: the caller owns the I/O, which
// keeps the parsing honest and testable under plain node.

import { MAX_DIMENSION } from './presets.js';
import { ALGORITHMS } from './dither.js';

export const RECIPE_VERSION = 1;

/** The factory settings. Every parse starts from a copy of this. */
export const DEFAULTS = Object.freeze({
  output: Object.freeze({
    width: 480,
    height: 800,
    matte: 1,
    quality: 0.92,
    polarity: 'white1',
    grid: true,
    live: true,
  }),
  tone: Object.freeze({
    brightness: 0, contrast: 1, gamma: 1, sharpen: 0.35, radius: 1, invert: false,
  }),
  screen: Object.freeze({
    algo: 'floyd', levels: 2, strength: 1, bias: 0, serpentine: true,
  }),
});

// `digits` mirrors the step of the matching control, so a value that came off
// a slider and the same value that came out of a link are the same number.
// `local` marks a workspace preference: kept across reloads, but not imposed
// on whoever opens your link.
export const FIELDS = Object.freeze([
  { key: 'w', path: 'output.width', kind: 'int', min: 8, max: MAX_DIMENSION },
  { key: 'h', path: 'output.height', kind: 'int', min: 8, max: MAX_DIMENSION },
  { key: 'mt', path: 'output.matte', kind: 'int', values: [0, 1] },
  { key: 'q', path: 'output.quality', kind: 'float', min: 0.3, max: 1, digits: 2 },
  { key: 'pol', path: 'output.polarity', kind: 'enum', values: ['white1', 'black1'] },
  { key: 'grid', path: 'output.grid', kind: 'bool', local: true },
  { key: 'live', path: 'output.live', kind: 'bool', local: true },

  { key: 'br', path: 'tone.brightness', kind: 'float', min: -0.5, max: 0.5, digits: 3 },
  { key: 'ct', path: 'tone.contrast', kind: 'float', min: 0, max: 3, digits: 2 },
  { key: 'gm', path: 'tone.gamma', kind: 'float', min: 0.2, max: 3, digits: 2 },
  { key: 'sh', path: 'tone.sharpen', kind: 'float', min: 0, max: 2, digits: 2 },
  { key: 'rd', path: 'tone.radius', kind: 'int', min: 1, max: 3 },
  { key: 'inv', path: 'tone.invert', kind: 'bool' },

  { key: 'alg', path: 'screen.algo', kind: 'enum', values: ALGORITHMS.map((a) => a.id) },
  { key: 'lev', path: 'screen.levels', kind: 'int', values: [2, 4, 8, 16] },
  { key: 'st', path: 'screen.strength', kind: 'float', min: 0, max: 1.5, digits: 2 },
  { key: 'bs', path: 'screen.bias', kind: 'float', min: -0.4, max: 0.4, digits: 3 },
  { key: 'sp', path: 'screen.serpentine', kind: 'bool' },
]);

const KEYS = new Set(FIELDS.map((f) => f.key));

// ------------------------------------------------------------------ helpers

function getPath(object, path) {
  let node = object;
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

function setPath(object, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  let node = object;
  for (const part of parts) node = node[part];
  node[last] = value;
}

// `-0 + 0` is `+0`, which keeps deep-equality and String() well behaved.
const round = (n, digits) => Number(n.toFixed(digits)) + 0;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Turn one loosely-typed value into a valid one, or `undefined` if it cannot
 * be rescued. Out-of-range numbers are clamped, because a slider that ran past
 * its limit still says something about intent; values outside a fixed set are
 * rejected outright, because snapping `lev=5` to 4 would be an invention.
 */
function coerce(field, raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;

  if (field.kind === 'bool') {
    if (typeof raw === 'boolean') return raw;
    const text = String(raw).toLowerCase();
    if (text === '1' || text === 'true') return true;
    if (text === '0' || text === 'false') return false;
    return undefined;
  }

  if (field.kind === 'enum') {
    const text = String(raw);
    return field.values.includes(text) ? text : undefined;
  }

  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;

  if (field.kind === 'int') {
    const rounded = Math.round(n);
    if (field.values) return field.values.includes(rounded) ? rounded : undefined;
    return clamp(rounded, field.min, field.max);
  }

  return round(clamp(n, field.min, field.max), field.digits);
}

function encode(field, value) {
  if (field.kind === 'bool') return value ? '1' : '0';
  return String(value);
}

/** A fresh, mutable copy of the factory settings. */
export function defaultRecipe() {
  return {
    output: { ...DEFAULTS.output },
    tone: { ...DEFAULTS.tone },
    screen: { ...DEFAULTS.screen },
  };
}

// ------------------------------------------------------------ nested <-> flat

/**
 * Validate a nested recipe-shaped object. Anything missing, malformed or
 * unrecognised falls back to the default for that one field, so a partial or
 * half-corrupt input still yields a usable recipe rather than an exception.
 */
export function normalise(raw) {
  const recipe = defaultRecipe();
  if (!raw || typeof raw !== 'object') return recipe;
  for (const field of FIELDS) {
    const value = coerce(field, getPath(raw, field.path));
    if (value !== undefined) setPath(recipe, field.path, value);
  }
  return recipe;
}

/**
 * @param {object} recipe
 * @param {{ includeLocal?: boolean, onlyChanged?: boolean }} options
 * @returns {Record<string, string>} short key -> string value
 */
export function toFlat(recipe, { includeLocal = true, onlyChanged = true } = {}) {
  const clean = normalise(recipe);
  const flat = {};
  for (const field of FIELDS) {
    if (field.local && !includeLocal) continue;
    const value = getPath(clean, field.path);
    if (onlyChanged && value === getPath(DEFAULTS, field.path)) continue;
    flat[field.key] = encode(field, value);
  }
  return flat;
}

/** Inverse of {@link toFlat}. Unknown keys are ignored, not an error. */
export function fromFlat(flat) {
  const recipe = defaultRecipe();
  if (!flat || typeof flat !== 'object') return recipe;
  const read = flat instanceof URLSearchParams
    ? (key) => flat.get(key)
    : (key) => flat[key];
  for (const field of FIELDS) {
    const value = coerce(field, read(field.key));
    if (value !== undefined) setPath(recipe, field.path, value);
  }
  return recipe;
}

// ------------------------------------------------------------------- sharing

/** `w=800&alg=atkinson`, with no leading `#` and no workspace-only fields. */
export function toSearch(recipe) {
  return new URLSearchParams(toFlat(recipe, { includeLocal: false })).toString();
}

/** Parse a search string or a `#…` hash. Local fields keep their defaults. */
export function fromSearch(text) {
  return fromFlat(new URLSearchParams(String(text || '').replace(/^[#?]/, '')));
}

/** True if `text` carries at least one field we recognise. */
export function hasRecipe(text) {
  const params = new URLSearchParams(String(text || '').replace(/^[#?]/, ''));
  for (const key of params.keys()) if (KEYS.has(key)) return true;
  return false;
}

/**
 * @param {object} recipe
 * @param {string} base absolute page URL, hash and query stripped
 */
export function shareUrl(recipe, base) {
  const url = new URL(base);
  url.search = '';
  const search = toSearch(recipe);
  url.hash = search ? `#${search}` : '';
  return url.toString();
}

// ------------------------------------------------------------------- storage

/** JSON for localStorage: everything that differs from the defaults. */
export function toStorage(recipe) {
  return JSON.stringify({ v: RECIPE_VERSION, ...toFlat(recipe, { includeLocal: true }) });
}

/**
 * Inverse of {@link toStorage}. Returns null for absent, unparseable or
 * future-versioned data: a newer Inkmagine may have redefined a key, and
 * guessing is worse than starting clean.
 */
export function fromStorage(text) {
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const version = Number(parsed.v);
  if (!Number.isFinite(version) || version > RECIPE_VERSION) return null;
  return fromFlat(parsed);
}

/** True if the recipe is untouched factory settings. */
export function isDefault(recipe) {
  return Object.keys(toFlat(recipe, { includeLocal: true })).length === 0;
}
