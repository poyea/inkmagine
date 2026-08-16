// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// The render-backend badge, and the sheet of detail behind it.
//
// The badge says which backend drew the plate. The sheet says what the browser
// will admit about the hardware underneath, which is a presentation problem
// rather than a rendering one, so it lives here instead of in main.js.
//
// Two rules run through all of it. Anything the browser declines to answer is
// dropped from the tooltip but kept in the sheet as "not reported", because a
// panel that silently shrank to two rows on iOS would read as a bug. And the
// badge is a button, not a span: a title tooltip needs hover, and a phone has
// none.

import { gpuState } from '../gpu/device.js';

const LABEL = { gpu: 'GPU · WGSL', cpu: 'CPU · JS' };

/** The adapter chip as one string, or '' when nothing was reported. */
function chipName(info) {
  return [info?.vendor, info?.architecture].filter(Boolean).join(' ');
}

/** A probe reason worth showing, as opposed to success or an unfinished probe. */
function realFailure(reason) {
  return reason && reason !== 'ok' && reason !== 'not probed' ? reason : '';
}

function tooltip(backend) {
  const { info, reason } = gpuState();
  const lines = [];

  if (backend === 'gpu') {
    lines.push('Composited, toned and screened by WebGPU compute shaders');
    const chip = chipName(info);
    if (chip) lines.push(info.fallback ? `${chip} (software fallback)` : chip);
    else if (info?.fallback) lines.push('Software fallback adapter');
    if (info?.maxTexture) lines.push(`Max texture ${info.maxTexture} px`);
  } else {
    lines.push('Rendered on the CPU. Error diffusion is sequential, so it runs here');
    const failure = realFailure(reason);
    if (failure) lines.push(`WebGPU unavailable: ${failure}`);
  }

  const threads = navigator.hardwareConcurrency;
  if (threads) lines.push(`${threads} CPU thread${threads === 1 ? '' : 's'}`);
  lines.push('Tap or click for detail');
  return lines.join('\n');
}

/** @returns {Array<[string, string]>} label/value pairs for the sheet. */
function rows(backend) {
  const { info, reason, format } = gpuState();
  const out = [
    ['Backend', backend === 'gpu' ? 'WebGPU compute' : 'CPU, JavaScript'],
    ['Adapter', chipName(info) || 'not reported'],
  ];

  if (info?.fallback) out.push(['Driver', 'software fallback, expect it to be slow']);
  if (info?.maxTexture) out.push(['Max texture', `${info.maxTexture} px`]);
  if (format) out.push(['Canvas format', format]);

  const threads = navigator.hardwareConcurrency;
  if (threads) out.push(['CPU threads', String(threads)]);
  if (navigator.deviceMemory) out.push(['Device memory', `${navigator.deviceMemory} GB`]);
  out.push(['Secure context', window.isSecureContext ? 'yes' : 'no, WebGPU is unavailable']);

  const failure = realFailure(reason);
  if (failure) out.push(['WebGPU', failure]);
  return out;
}

function rowElement([label, value]) {
  const row = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = label;
  dd.textContent = value;
  row.append(dt, dd);
  return row;
}

export function createBackendBadge({ badge, text, sheet, list, note }) {
  let current = 'cpu';

  const open = () => {
    list.replaceChildren(...rows(current).map(rowElement));
    note.textContent = current === 'gpu'
      ? 'Error diffusion is sequential, so choosing one of those screens moves the plate to the CPU.'
      : 'The CPU path is the reference implementation. Output is identical either way; only speed differs.';
    if (!sheet.open) sheet.showModal();
  };

  badge.addEventListener('click', open);

  return {
    /** @param {'gpu'|'cpu'} backend */
    set(backend) {
      current = backend;
      badge.dataset.backend = backend;
      text.textContent = LABEL[backend];
      badge.title = tooltip(backend);
    },
    open,
  };
}
