// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// The render-backend badge, and the sheet of detail behind it.
//
// One rule throughout: anything the browser declines to answer is still listed
// in the sheet as "not reported", because a panel that silently shrank to two
// rows on iOS would read as a bug rather than a limitation.

import { gpuState } from '../gpu/device.js';

const LABEL = { gpu: 'GPU · WGSL', cpu: 'CPU · JS' };

/** The adapter chip as one string, or '' when nothing was reported. */
function chipName(info) {
  return [info?.vendor, info?.architecture].filter(Boolean).join(' ');
}

/** A probe reason worth showing, as opposed to success. */
function realFailure(reason) {
  return reason && reason !== 'ok' && reason !== 'not probed' ? reason : '';
}

/**
 * Why this backend is the one drawing. Being on the CPU with a working GPU
 * present means the screen is error-diffused, which is the case someone is
 * most likely to open the sheet to ask about.
 */
function why(backend) {
  if (backend === 'gpu') return 'Composed, toned and screened by WebGPU compute shaders.';
  const failure = realFailure(gpuState().reason);
  return failure
    ? `WebGPU is unavailable here (${failure}), so everything runs on the CPU.`
    : 'Error diffusion is sequential, so those screens run on the CPU. Pick an ordered screen for the GPU path.';
}

/** @returns {Array<[string, string]>} label/value pairs for the sheet. */
function rows(backend) {
  const { info, format } = gpuState();
  const out = [
    ['Backend', backend === 'gpu' ? 'WebGPU compute' : 'JavaScript on the CPU'],
    ['Adapter', chipName(info) || 'not reported'],
  ];

  if (info?.fallback) out.push(['Driver', 'software fallback']);
  if (info?.maxTexture) out.push(['Max texture', `${info.maxTexture} px`]);
  if (format) out.push(['Canvas format', format]);

  const threads = navigator.hardwareConcurrency;
  if (threads) out.push(['CPU threads', String(threads)]);
  if (navigator.deviceMemory) out.push(['Device memory', `${navigator.deviceMemory} GB`]);
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
  let current = null;

  const open = () => {
    list.replaceChildren(...rows(current).map(rowElement));
    note.textContent = why(current);
    if (!sheet.open) sheet.showModal();
  };

  badge.addEventListener('click', open);

  return {
    /** @param {'gpu'|'cpu'} backend */
    set(backend) {
      // drawPlate calls this every frame; the backend changes about three
      // times in a session.
      if (backend === current) return;
      current = backend;
      badge.dataset.backend = backend;
      text.textContent = LABEL[backend];
      badge.title = why(backend);
    },
  };
}
