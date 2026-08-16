// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// Tests for recipe serialisation: the schema, the link format and the stored
// session. Everything a hostile URL or a stale localStorage entry can throw at
// the app arrives through these functions, so they get the paranoid treatment.
//
//   npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULTS, FIELDS, RECIPE_VERSION, defaultRecipe, normalise, toFlat, fromFlat,
  toSearch, fromSearch, hasRecipe, shareUrl, toStorage, fromStorage, isDefault,
} from '../src/recipe.js';
import { ALGORITHMS } from '../src/dither.js';
import { MAX_DIMENSION } from '../src/presets.js';

const at = (object, path) => path.split('.').reduce((node, part) => node?.[part], object);

/** A recipe with every single field moved off its default. */
function everythingChanged() {
  return {
    output: {
      width: 800, height: 480, matte: 0, quality: 0.7, polarity: 'black1',
      grid: false, live: false,
    },
    tone: {
      brightness: -0.125, contrast: 1.4, gamma: 0.8, sharpen: 0, radius: 3, invert: true,
    },
    screen: { algo: 'atkinson', levels: 4, strength: 0.6, bias: 0.05, serpentine: false },
  };
}

// -------------------------------------------------------------------- schema

test('every field has a unique key and a path that exists in DEFAULTS', () => {
  const keys = new Set();
  for (const field of FIELDS) {
    assert.ok(!keys.has(field.key), `duplicate key ${field.key}`);
    keys.add(field.key);
    assert.notEqual(at(DEFAULTS, field.path), undefined, `${field.path} missing from DEFAULTS`);
  }
});

test('every field default survives its own validation unchanged', () => {
  // Catches a default that sits outside the range the field advertises.
  assert.deepEqual(normalise(defaultRecipe()), defaultRecipe());
});

test('defaultRecipe is a fresh mutable copy each time', () => {
  const a = defaultRecipe();
  a.tone.gamma = 2;
  assert.equal(defaultRecipe().tone.gamma, DEFAULTS.tone.gamma);
  assert.equal(DEFAULTS.tone.gamma, 1);
});

test('every algorithm the UI offers is a legal recipe value', () => {
  for (const spec of ALGORITHMS) {
    assert.equal(fromSearch(`alg=${spec.id}`).screen.algo, spec.id, spec.id);
  }
});

// --------------------------------------------------------------- round-trips

test('defaults encode to nothing at all', () => {
  assert.deepEqual(toFlat(defaultRecipe()), {});
  assert.equal(toSearch(defaultRecipe()), '');
  assert.ok(isDefault(defaultRecipe()));
});

test('a fully-changed recipe survives the flat round-trip', () => {
  const recipe = everythingChanged();
  assert.deepEqual(fromFlat(toFlat(recipe)), recipe);
  assert.ok(!isDefault(recipe));
});

test('a fully-changed recipe survives the storage round-trip', () => {
  const recipe = everythingChanged();
  assert.deepEqual(fromStorage(toStorage(recipe)), recipe);
});

test('a link carries the recipe but not the workspace preferences', () => {
  const recipe = everythingChanged();
  const back = fromSearch(toSearch(recipe));

  assert.equal(back.output.grid, DEFAULTS.output.grid);
  assert.equal(back.output.live, DEFAULTS.output.live);

  // Everything else must come through untouched.
  const shared = { ...recipe, output: { ...recipe.output, grid: DEFAULTS.output.grid, live: DEFAULTS.output.live } };
  assert.deepEqual(back, shared);
});

test('a link only mentions the fields that actually changed', () => {
  const recipe = defaultRecipe();
  recipe.screen.algo = 'bluenoise';
  assert.equal(toSearch(recipe), 'alg=bluenoise');
});

test('link text is plain readable ASCII, not percent-encoded soup', () => {
  const search = toSearch(everythingChanged());
  assert.match(search, /^[A-Za-z0-9=&.\-]+$/, search);
  assert.ok(search.includes('alg=atkinson'), search);
});

// ------------------------------------------------------------- hostile input

test('out-of-range numbers clamp to the ends of their range', () => {
  assert.equal(fromSearch('w=1').output.width, 8);
  assert.equal(fromSearch(`w=${MAX_DIMENSION * 4}`).output.width, MAX_DIMENSION);
  assert.equal(fromSearch('br=9').tone.brightness, 0.5);
  assert.equal(fromSearch('br=-9').tone.brightness, -0.5);
  assert.equal(fromSearch('gm=0').tone.gamma, 0.2);
  assert.equal(fromSearch('q=99').output.quality, 1);
});

test('values outside a fixed set are rejected, not snapped', () => {
  // Snapping lev=5 to 4 would be inventing an instruction nobody gave.
  assert.equal(fromSearch('lev=5').screen.levels, DEFAULTS.screen.levels);
  assert.equal(fromSearch('mt=7').output.matte, DEFAULTS.output.matte);
  assert.equal(fromSearch('alg=definitely-not-real').screen.algo, DEFAULTS.screen.algo);
  assert.equal(fromSearch('pol=sideways').output.polarity, DEFAULTS.output.polarity);
});

test('junk numbers fall back rather than poisoning the state with NaN', () => {
  // 1e999 parses as Infinity, which clamp would happily carry into the render.
  for (const junk of ['', 'abc', 'NaN', 'Infinity', '-Infinity', '1e999', '0x1f']) {
    const value = fromSearch(`ct=${encodeURIComponent(junk)}`).tone.contrast;
    assert.ok(Number.isFinite(value), `ct=${junk} gave ${value}`);
    if (junk !== '0x1f') assert.equal(value, DEFAULTS.tone.contrast, `ct=${junk}`);
  }
});

test('unknown keys and malformed pairs are ignored', () => {
  const back = fromSearch('alg=stucki&hack=1&&=&w=&lev');
  assert.equal(back.screen.algo, 'stucki');
  assert.equal(back.output.width, DEFAULTS.output.width);
  assert.equal(back.screen.levels, DEFAULTS.screen.levels);
});

test('normalise repairs a half-corrupt object without throwing', () => {
  const back = normalise({
    output: { width: '640', height: null, quality: 'loads' },
    tone: 'not an object',
    screen: { levels: 8 },
    nonsense: { deeply: { nested: true } },
  });
  assert.equal(back.output.width, 640);
  assert.equal(back.output.height, DEFAULTS.output.height);
  assert.equal(back.output.quality, DEFAULTS.output.quality);
  assert.deepEqual(back.tone, { ...DEFAULTS.tone });
  assert.equal(back.screen.levels, 8);
});

test('normalise and fromFlat tolerate null, undefined and primitives', () => {
  for (const input of [null, undefined, 42, 'recipe', [], true]) {
    assert.deepEqual(normalise(input), defaultRecipe(), String(input));
    assert.deepEqual(fromFlat(input), defaultRecipe(), String(input));
  }
});

test('booleans accept both spellings and reject anything else', () => {
  assert.equal(fromSearch('inv=1').tone.invert, true);
  assert.equal(fromSearch('inv=true').tone.invert, true);
  assert.equal(fromSearch('sp=0').screen.serpentine, false);
  assert.equal(fromSearch('sp=false').screen.serpentine, false);
  assert.equal(fromSearch('sp=maybe').screen.serpentine, DEFAULTS.screen.serpentine);
});

// ------------------------------------------------------------------ rounding

test('floats round to the precision of their control', () => {
  assert.equal(fromSearch('br=0.1234567').tone.brightness, 0.123);
  assert.equal(fromSearch('q=0.923456').output.quality, 0.92);
  assert.equal(fromSearch('ct=1.4567').tone.contrast, 1.46);
  assert.equal(fromSearch('bs=-0.03349').screen.bias, -0.033);
});

test('rounding is stable, so a value never drifts on a second trip', () => {
  // Whatever toFixed does at a binary64 tie, it must do the same every time:
  // a link that changes each time you copy it would be a nasty surprise.
  for (const raw of ['0.005', '1.005', '0.125', '2.675', '-0.0005']) {
    const once = fromSearch(`ct=${raw}`);
    assert.deepEqual(fromSearch(toSearch(once)), once, `ct=${raw}`);
  }
});

test('a value that rounds to negative zero comes back as plain zero', () => {
  const value = fromSearch('br=-0.0001').tone.brightness;
  assert.equal(value, 0);
  assert.ok(!Object.is(value, -0), 'negative zero leaked through');
  // -0 would also survive `=== default` and vanish from the link, so prove it.
  assert.equal(toSearch(fromSearch('br=-0.0001')), '');
});

test('integers round rather than truncate', () => {
  assert.equal(fromSearch('w=640.6').output.width, 641);
  assert.equal(fromSearch('rd=2.4').tone.radius, 2);
});

// --------------------------------------------------------------- detection

test('hasRecipe distinguishes our hash from anyone else’s', () => {
  assert.ok(hasRecipe('#alg=atkinson'));
  assert.ok(hasRecipe('alg=atkinson'));
  assert.ok(hasRecipe('#w=800&utm_source=x'));
  assert.ok(!hasRecipe(''));
  assert.ok(!hasRecipe('#'));
  assert.ok(!hasRecipe('#section-two'));
  assert.ok(!hasRecipe('#utm_source=newsletter'));
  assert.ok(!hasRecipe(null));
});

// ----------------------------------------------------------------- share URL

test('shareUrl hangs the recipe off the page URL and drops any query', () => {
  const recipe = defaultRecipe();
  recipe.output.width = 800;
  recipe.output.height = 480;
  const url = shareUrl(recipe, 'https://poyea.github.io/inkmagine/?utm=1#stale');
  assert.equal(url, 'https://poyea.github.io/inkmagine/#w=800&h=480');
});

test('shareUrl of the defaults is a clean link with no hash', () => {
  const url = shareUrl(defaultRecipe(), 'https://poyea.github.io/inkmagine/#w=800');
  assert.equal(url, 'https://poyea.github.io/inkmagine/');
});

test('a share URL round-trips through its own hash', () => {
  const recipe = everythingChanged();
  const url = new URL(shareUrl(recipe, 'http://localhost:8080/'));
  const back = fromSearch(url.hash);
  assert.equal(back.screen.algo, recipe.screen.algo);
  assert.equal(back.tone.brightness, recipe.tone.brightness);
  assert.equal(back.output.polarity, recipe.output.polarity);
});

// ------------------------------------------------------------------- storage

test('stored JSON is versioned and holds only the changes', () => {
  const recipe = defaultRecipe();
  recipe.tone.invert = true;
  assert.deepEqual(JSON.parse(toStorage(recipe)), { v: RECIPE_VERSION, inv: '1' });
});

test('fromStorage refuses anything it cannot trust', () => {
  assert.equal(fromStorage(null), null);
  assert.equal(fromStorage(''), null);
  assert.equal(fromStorage('not json at all'), null);
  assert.equal(fromStorage('"a string"'), null);
  assert.equal(fromStorage('null'), null);
  assert.equal(fromStorage('{}'), null, 'unversioned data must be refused');
  assert.equal(fromStorage(`{"v":${RECIPE_VERSION + 1},"w":"800"}`), null, 'future version');
});

test('fromStorage accepts an empty but versioned session as the defaults', () => {
  assert.deepEqual(fromStorage(`{"v":${RECIPE_VERSION}}`), defaultRecipe());
});
