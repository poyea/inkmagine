// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// Dump every WGSL string from src/gpu/shaders.js to its own .wgsl file so a
// validator can compile them. The shaders live in JS template strings to keep
// the site build-free, which means nothing else ever type-checks them.
//
//   node scripts/extract-wgsl.mjs [outDir]              just extract
//   node scripts/extract-wgsl.mjs [outDir] --validate   extract, then run naga
//
// --validate needs naga on the PATH (`cargo install naga-cli`). It is spawned
// per file rather than through a shell glob so the same command works in
// PowerShell, cmd and sh.

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const validate = args.includes('--validate');
const outDir = resolve(args.find((a) => !a.startsWith('--')) || '.wgsl-out');
const shaders = resolve(dirname(import.meta.dirname), 'src/gpu/shaders.js');

await mkdir(outDir, { recursive: true });
const module = await import(pathToFileURL(shaders).href);

const written = [];
for (const [name, source] of Object.entries(module)) {
  if (typeof source !== 'string' || !name.endsWith('_WGSL')) continue;
  const file = join(outDir, `${name.replace(/_WGSL$/, '').toLowerCase()}.wgsl`);
  await writeFile(file, source, 'utf8');
  console.log(`${file}  (${source.split('\n').length} lines)`);
  written.push(file);
}

if (written.length === 0) {
  console.error('No *_WGSL exports found in src/gpu/shaders.js');
  process.exit(1);
}

if (!validate) process.exit(0);

// 31 is naga's bitmask for the full validation set.
let failed = 0;
for (const file of written) {
  const run = spawnSync('naga', ['--validate', '31', file], { stdio: 'inherit', shell: false });
  if (run.error?.code === 'ENOENT') {
    console.error('\nnaga is not on the PATH. Install it with: cargo install naga-cli');
    process.exit(127);
  }
  if (run.status !== 0) failed++;
}

console.log(failed === 0
  ? `\nnaga: ${written.length} shaders valid`
  : `\nnaga: ${failed} of ${written.length} shaders failed`);
process.exit(failed === 0 ? 0 : 1);
