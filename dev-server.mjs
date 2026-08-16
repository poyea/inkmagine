// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// Zero-dependency static server for local development.
//
//   npm start            -> http://localhost:8080
//   npm start -- 3000    -> a different port
//
// localhost counts as a secure context, so WebGPU and the paint worklet both
// work here exactly as they will on GitHub Pages.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname);
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wgsl': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = decodeURIComponent(url.pathname);
  let filePath = join(ROOT, normalize(requested).replace(/^([/\\])+/, ''));

  // Never serve outside the project directory.
  if (!filePath.startsWith(ROOT + sep) && filePath !== ROOT) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath).catch(() => null);
    if (!info || info.isDirectory()) filePath = join(filePath, 'index.html');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`inkmagine  ->  http://localhost:${PORT}`);
});
