// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// Batch conversion: many files, one set of settings.
//
// Runs on its own CpuRenderer so it never touches the interactive renderer's
// buffers, and yields between images so the list keeps repainting.

import { CpuRenderer } from '../pipeline.js';
import { loadFile, release } from '../source.js';
import { defaultGeo, frameGeo } from '../transform.js';
import { FORMATS, outputName, formatBytes } from '../export.js';
import { makeZip } from '../zip.js';

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

export function createBatch({ dialog, list, runButton, clearButton, progress, formatSelect, zipSwitch, fitRadios, sink, getSettings, log }) {
  const renderer = new CpuRenderer();
  let items = [];
  let running = false;

  function add(files) {
    const incoming = [...files].filter((f) => !f.type || f.type.startsWith('image/'));
    const skipped = files.length - incoming.length;
    items = items.concat(incoming.map((file) => ({ file, state: 'queued', note: '' })));
    if (skipped > 0) log(`Skipped ${skipped} non-image file${skipped === 1 ? '' : 's'}.`, 'error');
    render();
  }

  function clear() {
    if (running) return;
    items = [];
    render();
  }

  function render() {
    list.innerHTML = '';
    items.forEach((item, index) => {
      const li = document.createElement('li');
      li.className = 'batch-item';
      li.dataset.state = item.state;
      li.innerHTML = `
        <span class="batch-item__index">${String(index + 1).padStart(2, '0')}</span>
        <span class="batch-item__name"></span>
        <span class="batch-item__state"></span>`;
      li.querySelector('.batch-item__name').textContent = item.file.name;
      li.querySelector('.batch-item__state').textContent = item.note || item.state;

      if (!running) {
        const drop = document.createElement('button');
        drop.type = 'button';
        drop.className = 'batch-item__drop';
        drop.textContent = '✕';
        drop.setAttribute('aria-label', `Remove ${item.file.name}`);
        drop.addEventListener('click', () => {
          items.splice(index, 1);
          render();
        });
        li.append(drop);
      } else {
        li.append(document.createElement('span'));
      }
      list.append(li);
    });

    runButton.disabled = running || items.length === 0;
    clearButton.disabled = running || items.length === 0;
    runButton.textContent = items.length > 1 ? `Convert ${items.length}` : 'Convert all';
  }

  function fitMode() {
    return [...fitRadios].find((r) => r.checked)?.value || 'fill';
  }

  async function run() {
    if (running || items.length === 0) return;
    running = true;
    progress.hidden = false;
    progress.max = items.length;
    progress.value = 0;
    render();

    const settings = getSettings();
    const format = FORMATS[formatSelect.value] || FORMATS.jpg;
    const asZip = zipSwitch.checked;
    const mode = fitMode();
    const archive = [];
    let done = 0;
    let failed = 0;

    for (const item of items) {
      item.state = 'working';
      item.note = '';
      render();
      await nextFrame();

      let source = null;
      try {
        source = await loadFile(item.file);
        const geo = frameGeo(mode, defaultGeo(), source.width, source.height, settings.width, settings.height);
        const { bytes } = renderer.render(source, geo, settings);
        const blob = await format.encode(bytes, settings.width, settings.height, {
          quality: settings.quality,
          polarity: settings.polarity,
          symbol: `image_${item.file.name.replace(/\.[^.]+$/, '')}`,
        });
        const name = outputName(item.file.name, settings.width, settings.height, format.ext);

        if (asZip) {
          archive.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
          item.note = formatBytes(blob.size);
        } else {
          const written = await sink.write(name, blob);
          item.note = `${written.name} · ${formatBytes(blob.size)}`;
        }
        item.state = 'done';
        done++;
      } catch (err) {
        item.state = 'failed';
        item.note = err?.message || 'failed';
        failed++;
      } finally {
        if (source) release(source);
      }

      progress.value = done + failed;
      render();
      await nextFrame();
    }

    if (asZip && archive.length > 0) {
      try {
        const zip = makeZip(archive);
        const written = await sink.write(`inkmagine-${settings.width}x${settings.height}.zip`, zip);
        log(`Wrote ${written.name}: ${archive.length} image${archive.length === 1 ? '' : 's'}, ${formatBytes(zip.size)}.`);
      } catch (err) {
        log(`Could not write the archive: ${err?.message || err}`, 'error');
      }
    } else if (done > 0) {
      log(`Converted ${done} image${done === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}.`);
    }

    if (failed > 0 && done === 0) log(`All ${failed} conversions failed.`, 'error');

    running = false;
    progress.hidden = true;
    render();
  }

  runButton.addEventListener('click', run);
  clearButton.addEventListener('click', clear);
  dialog.addEventListener('close', () => { if (!running) clear(); });

  return { add, clear, open: () => dialog.showModal(), get running() { return running; } };
}
