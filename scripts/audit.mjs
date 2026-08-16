// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// Static wiring audit.
//
// The imaging core has unit tests; the wiring between index.html, the
// stylesheets and the modules has nothing but this. It catches the mistakes
// that a syntax check and a headless test suite both sail straight past: an id
// renamed in one place, a class toggled that no rule matches, a control whose
// markup default has drifted away from the recipe schema.
//
//   node scripts/audit.mjs        (or: npm run audit)
//
// Exits non-zero on the first category with findings. It is deliberately
// regex-based: the markup here is hand-written and regular, and a parser would
// be a dependency.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DEFAULTS, FIELDS } from '../src/recipe.js';

const root = join(import.meta.dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const problems = [];
const fail = (category, detail) => problems.push({ category, detail });

function walk(dir, out = []) {
  for (const entry of readdirSync(join(root, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
    else if (/\.m?js$/.test(rel)) out.push(rel);
  }
  return out;
}

const html = read('index.html');
const cssFiles = ['styles/core.css', 'styles/controls.css'];
const css = cssFiles.map(read).join('\n');
const scriptFiles = [...walk('src'), 'worklets/grain.js'];
const scripts = new Map(scriptFiles.map((f) => [f, read(f)]));
const js = [...scripts.values()].join('\n');

const all = (text, re) => [...text.matchAll(re)].map((m) => m[1]);
const unique = (list) => [...new Set(list)];

// ------------------------------------------------------------------- ids

const declaredIds = all(html, /\bid="([^"]+)"/g);
const duplicates = declaredIds.filter((id, i) => declaredIds.indexOf(id) !== i);
for (const id of unique(duplicates)) fail('duplicate id in index.html', id);

// Ids the modules reach for: $('x') and the odd getElementById.
const wantedIds = unique([
  ...all(js, /\$\('([^']+)'\)/g),
  ...all(js, /getElementById\('([^']+)'\)/g),
]);
const declared = new Set(declaredIds);
for (const id of wantedIds) {
  if (!declared.has(id)) fail('id used by a module but absent from index.html', id);
}

// Ids referenced from markup or CSS rather than from JS.
const markupRefs = unique([
  ...all(html, /\bfor="([^"]+)"/g),
  ...all(html, /\baria-labelledby="([^"]+)"/g),
  ...all(html, /\baria-describedby="([^"]+)"/g),
  ...all(html, /\baria-controls="([^"]+)"/g),
  ...all(html, /\bhref="#([^"]+)"/g),
]);
for (const id of markupRefs) {
  if (!declared.has(id)) fail('markup points at an id that does not exist', id);
}

const cssIds = unique(all(css, /#([A-Za-z][\w-]*)/g));
const used = new Set([...wantedIds, ...markupRefs, ...cssIds]);
for (const id of unique(declaredIds)) {
  // Custom elements build their own inner ids from the host id.
  if (used.has(id) || used.has(`${id}-input`)) continue;
  fail('id declared in index.html that nothing references', id);
}

// --------------------------------------------------------------- selectors

for (const name of unique(all(js, /input\[name="([^"]+)"\]/g))) {
  if (!html.includes(`name="${name}"`)) {
    fail('querySelectorAll targets a radio group that is not in the markup', name);
  }
}

for (const tag of unique(all(html, /<(ink-[a-z-]+)/g))) {
  if (!js.includes(`customElements.define('${tag}'`)) {
    fail('custom element used in markup but never defined', tag);
  }
}

// ----------------------------------------------------------------- classes

const toggled = unique([
  ...all(js, /classList\.(?:add|remove|toggle)\('([^']+)'/g),
  ...all(js, /classList\.contains\('([^']+)'\)/g),
]);
for (const name of toggled) {
  if (!css.includes(`.${name}`)) fail('class toggled from JS with no rule in the CSS', name);
}

// ------------------------------------------------------------- paint worklets

const painted = unique(all(css, /\bpaint\(([a-z-]+)\)/g));
const registered = unique(all(js, /registerPaint\('([^']+)'/g));
for (const name of painted) {
  if (!registered.includes(name)) fail('CSS paints with an unregistered worklet', name);
}
for (const name of registered) {
  if (!painted.includes(name)) fail('paint worklet registered but never painted', name);
}

// ----------------------------------------------------------------- structure

for (const tag of ['div', 'section', 'aside', 'main', 'header', 'footer', 'dialog', 'dl', 'ol', 'fieldset', 'label', 'button', 'select', 'form']) {
  const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
  const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  if (open !== close) fail('unbalanced tag in index.html', `${tag}: ${open} open, ${close} close`);
}

for (const file of cssFiles) {
  const text = read(file);
  const open = (text.match(/{/g) || []).length;
  const close = (text.match(/}/g) || []).length;
  if (open !== close) fail('unbalanced braces', `${file}: ${open} open, ${close} close`);
}

// --------------------------------------------------- markup vs recipe defaults

// index.html declares each control's starting value, and recipe.js declares
// the factory settings. They have to agree, or the app boots showing one thing
// and rendering another.
const CONTROLS = [
  { path: 'output.width', kind: 'value', id: 'out-w' },
  { path: 'output.height', kind: 'value', id: 'out-h' },
  { path: 'output.quality', kind: 'value', id: 'quality' },
  { path: 'output.matte', kind: 'radio', name: 'matte' },
  { path: 'output.polarity', kind: 'radio', name: 'polarity' },
  { path: 'output.grid', kind: 'checked', id: 'grid' },
  { path: 'output.live', kind: 'checked', id: 'live' },
  { path: 'tone.brightness', kind: 'value', id: 'brightness' },
  { path: 'tone.contrast', kind: 'value', id: 'contrast' },
  { path: 'tone.gamma', kind: 'value', id: 'gamma' },
  { path: 'tone.sharpen', kind: 'value', id: 'sharpen' },
  { path: 'tone.radius', kind: 'value', id: 'radius' },
  { path: 'tone.invert', kind: 'checked', id: 'invert' },
  { path: 'screen.levels', kind: 'option', id: 'levels' },
  { path: 'screen.strength', kind: 'value', id: 'strength' },
  { path: 'screen.bias', kind: 'value', id: 'bias' },
  { path: 'screen.serpentine', kind: 'checked', id: 'serpentine' },
];

// The algorithm list is built by buildSelects() at runtime, so its default
// lives in JS rather than in the markup. Everything else must be listed above,
// or adding a recipe field and forgetting the control would pass unnoticed.
const NO_MARKUP_DEFAULT = new Set(['screen.algo']);

const covered = new Set([...CONTROLS.map((c) => c.path), ...NO_MARKUP_DEFAULT]);
for (const field of FIELDS) {
  if (!covered.has(field.path)) {
    fail('recipe field checked against nothing in the markup', field.path);
  }
}
const known = new Set(FIELDS.map((f) => f.path));
for (const control of CONTROLS) {
  if (!known.has(control.path)) fail('audit checks a path recipe.js does not define', control.path);
}

const at = (object, path) => path.split('.').reduce((node, part) => node?.[part], object);

function tagWithId(id) {
  return html.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`))?.[0] || null;
}

function markupDefault(control) {
  if (control.kind === 'radio') {
    const inputs = html.match(new RegExp(`<input[^>]*name="${control.name}"[^>]*>`, 'g')) || [];
    const checked = inputs.find((tag) => / checked\b/.test(tag));
    return checked ? checked.match(/value="([^"]*)"/)?.[1] : undefined;
  }
  if (control.kind === 'option') {
    const block = html.match(new RegExp(`<select[^>]*\\bid="${control.id}"[\\s\\S]*?</select>`))?.[0];
    const selected = block?.match(/<option[^>]*\bselected\b[^>]*>/)?.[0];
    return selected?.match(/value="([^"]*)"/)?.[1];
  }
  const tag = tagWithId(control.id);
  if (!tag) return undefined;
  if (control.kind === 'checked') return / checked\b/.test(tag) ? 'true' : 'false';
  return tag.match(/\bvalue="([^"]*)"/)?.[1];
}

for (const control of CONTROLS) {
  const expected = String(at(DEFAULTS, control.path));
  const found = markupDefault(control);
  if (found === undefined) {
    fail('no default found in the markup for a recipe field', control.path);
  } else if (found !== expected) {
    fail('markup default disagrees with recipe.js', `${control.path}: markup ${found}, recipe ${expected}`);
  }
}

// ------------------------------------------------------------------- report

const checked = [
  `${unique(declaredIds).length} ids`,
  `${wantedIds.length} module lookups`,
  `${toggled.length} toggled classes`,
  `${CONTROLS.length} control defaults`,
  `${scriptFiles.length} modules`,
];

if (problems.length === 0) {
  console.log(`audit: clean (${checked.join(', ')})`);
  process.exit(0);
}

const byCategory = new Map();
for (const { category, detail } of problems) {
  if (!byCategory.has(category)) byCategory.set(category, []);
  byCategory.get(category).push(detail);
}
for (const [category, details] of byCategory) {
  console.error(`\n${category}:`);
  for (const detail of details) console.error(`  ${detail}`);
}
console.error(`\naudit: ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
console.error(`checked ${relative(root, root) || '.'}: ${checked.join(', ')}`);
process.exit(1);
