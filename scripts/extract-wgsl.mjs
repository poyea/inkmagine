// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// Dump every WGSL string from src/gpu/shaders.js to its own .wgsl file so a
// validator can compile them. The shaders live in JS template strings to keep
// the site build-free, which means nothing else ever type-checks them.
//
//   cargo install naga-cli
//   node scripts/extract-wgsl.mjs .wgsl-out
//   naga --validate 31 .wgsl-out/compose.wgsl

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const outDir = resolve(process.argv[2] || '.wgsl-out');
const shaders = resolve(dirname(import.meta.dirname), 'src/gpu/shaders.js');

await mkdir(outDir, { recursive: true });
const module = await import(pathToFileURL(shaders).href);

let count = 0;
for (const [name, source] of Object.entries(module)) {
  if (typeof source !== 'string' || !name.endsWith('_WGSL')) continue;
  const file = join(outDir, `${name.replace(/_WGSL$/, '').toLowerCase()}.wgsl`);
  await writeFile(file, source, 'utf8');
  console.log(`${file}  (${source.split('\n').length} lines)`);
  count++;
}

if (count === 0) {
  console.error('No *_WGSL exports found in src/gpu/shaders.js');
  process.exitCode = 1;
}
