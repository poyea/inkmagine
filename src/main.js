// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// Inkmagine wiring. Owns the app state and drives everything else.

import { defineElements } from './ui/elements.js';
import { installGrain } from './ui/grain.js';
import { Stage, SCALE_LIMITS } from './ui/stage.js';
import { Plate } from './ui/plate.js';
import { createBatch } from './ui/batch.js';
import { CpuRenderer, coverage } from './pipeline.js';
import { GpuRenderer } from './gpu/renderer.js';
import { gpuState } from './gpu/device.js';
import { ALGORITHMS, isParallel, algorithm } from './dither.js';
import { PRESETS, findPreset, clampDimension } from './presets.js';
import { loadFile, testWedge, release } from './source.js';
import { defaultGeo, frameGeo, cropRect, angleOf, clamp } from './transform.js';
import { FORMATS, outputName, formatBytes } from './export.js';
import { OutputSink, directoryPickerSupported } from './fsout.js';
import {
  defaultRecipe, normalise, toFlat, toStorage, fromStorage, fromSearch,
  hasRecipe, shareUrl, isDefault,
} from './recipe.js';

const $ = (id) => document.getElementById(id);
const THEME_KEY = 'inkmagine:theme';
const RECIPE_KEY = 'inkmagine:recipe';
const QUICK_ALGOS = [
  'threshold', 'floyd', 'atkinson', 'jjn', 'stucki',
  'bayer4', 'bayer8', 'bluenoise', 'halftone8',
];

// `output`, `tone` and `screen` are the recipe: one definition of the factory
// settings, in recipe.js, rather than a copy here that can drift away from it.
const state = {
  source: null,
  geo: defaultGeo(),
  ...defaultRecipe(),
};

const cpu = new CpuRenderer();
const sink = new OutputSink();
let gpu = null;
let stage = null;
let plate = null;
let batch = null;

let pendingFrame = null;
let statsTimer = null;
let persistTimer = null;
let cpuBytes = null;
let lastBackend = 'cpu';
let syncing = false;
// Nothing is written back to storage until boot has finished reading it.
let ready = false;

// --------------------------------------------------------------- utilities

function settings() {
  return {
    width: state.output.width,
    height: state.output.height,
    matte: state.output.matte,
    quality: state.output.quality,
    polarity: state.output.polarity,
    tone: { ...state.tone },
    screen: { ...state.screen },
  };
}

function say(message, tone = '') {
  const ticker = $('ticker');
  ticker.textContent = message;
  if (tone) ticker.dataset.tone = tone;
  else delete ticker.dataset.tone;
}

function setBadge(backend) {
  const badge = $('backend-badge');
  badge.dataset.backend = backend;
  $('backend-text').textContent = backend === 'gpu' ? 'GPU · WGSL' : 'CPU · JS';
  badge.title = backendTitle(backend);
}

/**
 * The detail lives in the tooltip so the badge itself stays two words wide at
 * every window size. Anything the browser declined to tell us is simply left
 * out, rather than shown as an empty field.
 */
function backendTitle(backend) {
  const { info, reason } = gpuState();
  const lines = [];

  if (backend === 'gpu') {
    lines.push('Composited, toned and screened by WebGPU compute shaders');
    const chip = [info?.vendor, info?.architecture].filter(Boolean).join(' ');
    if (chip) lines.push(info.fallback ? `${chip} (software fallback)` : chip);
    else if (info?.fallback) lines.push('Software fallback adapter');
    if (info?.maxTexture) lines.push(`Max texture ${info.maxTexture} px`);
  } else {
    lines.push('Rendered on the CPU. Error diffusion is sequential, so it runs here');
    if (reason && reason !== 'ok' && reason !== 'not probed') {
      lines.push(`WebGPU unavailable: ${reason}`);
    }
  }

  const threads = navigator.hardwareConcurrency;
  if (threads) lines.push(`${threads} CPU thread${threads === 1 ? '' : 's'}`);
  lines.push('Tap or click for detail');
  return lines.join('\n');
}

/**
 * The same facts as the tooltip, in a sheet, because a tooltip needs hover and
 * a phone has none. Rows the browser cannot answer are still listed, marked as
 * not reported: on iOS almost the whole adapter block comes back empty, and a
 * panel that silently shrank to two rows would read as a bug.
 */
function rendererRows() {
  const { info, reason, format } = gpuState();
  const chip = [info?.vendor, info?.architecture].filter(Boolean).join(' ');
  const rows = [
    ['Backend', lastBackend === 'gpu' ? 'WebGPU compute' : 'CPU, JavaScript'],
    ['Adapter', chip || 'not reported'],
  ];

  if (info?.fallback) rows.push(['Driver', 'software fallback, expect it to be slow']);
  if (info?.maxTexture) rows.push(['Max texture', `${info.maxTexture} px`]);
  if (format) rows.push(['Canvas format', format]);

  const threads = navigator.hardwareConcurrency;
  if (threads) rows.push(['CPU threads', String(threads)]);
  if (navigator.deviceMemory) rows.push(['Device memory', `${navigator.deviceMemory} GB`]);
  rows.push(['Secure context', window.isSecureContext ? 'yes' : 'no, WebGPU is unavailable']);
  if (reason && reason !== 'ok' && reason !== 'not probed') rows.push(['WebGPU', reason]);
  return rows;
}

function openRenderer() {
  const list = $('renderer-stats');
  list.replaceChildren(...rendererRows().map(([label, value]) => {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    row.append(dt, dd);
    return row;
  }));
  $('renderer-note').textContent = lastBackend === 'gpu'
    ? 'Error diffusion is sequential, so choosing one of those screens moves the plate to the CPU.'
    : 'The CPU path is the reference implementation. Output is identical either way; only speed differs.';
  const sheet = $('renderer-sheet');
  if (!sheet.open) sheet.showModal();
}

// ----------------------------------------------------------------- recipes

function currentRecipe() {
  return normalise({
    output: { ...state.output },
    tone: { ...state.tone },
    screen: { ...state.screen },
  });
}

/** Push a recipe into every control, then read it back out into the state. */
function applyRecipe(recipe, { refit = true } = {}) {
  const next = normalise(recipe);

  $('brightness').value = next.tone.brightness;
  $('contrast').value = next.tone.contrast;
  $('gamma').value = next.tone.gamma;
  $('sharpen').value = next.tone.sharpen;
  $('radius').value = next.tone.radius;
  $('invert').checked = next.tone.invert;

  $('algo').value = next.screen.algo;
  $('levels').value = String(next.screen.levels);
  $('strength').value = next.screen.strength;
  $('bias').value = next.screen.bias;
  $('serpentine').checked = next.screen.serpentine;

  $('quality').value = next.output.quality;
  $('grid').checked = next.output.grid;
  $('live').checked = next.output.live;
  for (const radio of document.querySelectorAll('input[name="matte"]')) {
    radio.checked = Number(radio.value) === next.output.matte;
  }
  for (const radio of document.querySelectorAll('input[name="polarity"]')) {
    radio.checked = radio.value === next.output.polarity;
  }

  state.output.matte = next.output.matte;
  state.output.quality = next.output.quality;
  state.output.polarity = next.output.polarity;
  state.output.grid = next.output.grid;
  state.output.live = next.output.live;

  readTone();
  readScreen();
  setOutputSize(next.output.width, next.output.height, { refit });
}

function persistNow() {
  clearTimeout(persistTimer);
  if (!ready) return;
  try {
    const recipe = currentRecipe();
    // Untouched settings leave no trace, so a reset really does clear up.
    if (isDefault(recipe)) localStorage.removeItem(RECIPE_KEY);
    else localStorage.setItem(RECIPE_KEY, toStorage(recipe));
  } catch {
    // Private browsing and full quotas both throw here. Losing the session is
    // a smaller problem than refusing to convert an image, so carry on.
  }
}

function persist() {
  if (!ready) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 400);
}

/** A link beats the stored session, which beats the factory settings. */
function startupRecipe() {
  if (hasRecipe(location.hash)) {
    return { recipe: fromSearch(location.hash), from: 'link' };
  }
  try {
    const stored = fromStorage(localStorage.getItem(RECIPE_KEY));
    if (stored) return { recipe: stored, from: 'session' };
  } catch { /* see persistNow */ }
  return { recipe: defaultRecipe(), from: 'default' };
}

function refreshRecipeSheet() {
  const recipe = currentRecipe();
  $('recipe-link').value = shareUrl(recipe, location.href);
  const changed = Object.keys(toFlat(recipe, { includeLocal: false })).length;
  $('recipe-note').textContent = changed === 0
    ? 'Factory settings.'
    : `${changed} setting${changed === 1 ? ' differs' : 's differ'} from the factory settings.`;
}

// ----------------------------------------------------------------- render

function requestRender() {
  if (!state.output.live) {
    markStale(true);
    return;
  }
  if (pendingFrame) return;
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = null;
    drawPlate();
  });
}

function drawPlate() {
  const config = settings();
  plate.setSize(config.width, config.height);

  if (gpu && isParallel(state.screen.algo)) {
    gpu.render(state.source, state.geo, config);
    plate.showBackend('gpu');
    lastBackend = 'gpu';
  } else {
    const result = cpu.render(state.source, state.geo, config);
    plate.paint(result.bytes, config.width, config.height);
    plate.showBackend('cpu');
    cpuBytes = result.bytes;
    lastBackend = 'cpu';
  }

  markStale(false);
  setBadge(lastBackend);
  scheduleStats();
}

function markStale(value) {
  $('plate-root').classList.toggle('is-stale', !!value && !!state.source);
}

/** Render synchronously if the plate is behind, then hand back the pixels. */
async function currentBytes() {
  // A queued frame means the plate is a render behind: draw it now rather
  // than handing back the previous settings' pixels.
  const queued = pendingFrame !== null;
  if (queued) {
    cancelAnimationFrame(pendingFrame);
    pendingFrame = null;
  }
  if (queued || !state.output.live || $('plate-root').classList.contains('is-stale')) drawPlate();
  if (lastBackend === 'gpu' && gpu) return gpu.readback();
  return cpuBytes;
}

function scheduleStats() {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(updateStats, 220);
}

async function updateStats() {
  const { width, height } = state.output;
  $('packed-readout').textContent = formatBytes(Math.ceil(width / 8) * height);
  if (!state.source) {
    $('coverage-readout').textContent = '—';
    $('size-readout').textContent = '—';
    return;
  }
  try {
    const bytes = lastBackend === 'gpu' && gpu ? await gpu.readback() : cpuBytes;
    if (!bytes || !bytes.length) return;
    $('coverage-readout').textContent = `${(coverage(bytes) * 100).toFixed(1)}%`;
    const blob = await FORMATS.jpg.encode(bytes, width, height, { quality: state.output.quality });
    $('size-readout').textContent = formatBytes(blob.size);
  } catch {
    $('size-readout').textContent = '—';
  }
}

function updateGeoReadouts() {
  if (!state.source) {
    $('crop-readout').textContent = '—';
    $('scale-readout').textContent = '—';
    $('angle-readout').textContent = '0°';
    return;
  }
  const rect = cropRect(state.geo, state.output.width, state.output.height);
  $('crop-readout').textContent = `${rect.w} × ${rect.h}`;
  $('scale-readout').textContent = `${(state.geo.scale * 100).toFixed(state.geo.scale < 1 ? 1 : 0)}%`;
  const degrees = ((angleOf(state.geo) * 180) / Math.PI) % 360;
  const normalised = degrees > 180 ? degrees - 360 : degrees <= -180 ? degrees + 360 : degrees;
  $('angle-readout').textContent = `${normalised.toFixed(1)}°`;
}

// -------------------------------------------------------------- geometry

function applyGeo(next) {
  state.geo = next;
  syncGeoControls();
  stage.draw();
  updateGeoReadouts();
  requestRender();
}

function syncGeoControls() {
  syncing = true;
  $('rotate').value = state.geo.fine;
  $('zoom').value = Math.log2(Math.max(SCALE_LIMITS.min, state.geo.scale));
  $('flip-h').checked = state.geo.flipH;
  $('flip-v').checked = state.geo.flipV;
  syncing = false;
}

function frame(mode) {
  if (!state.source) return;
  applyGeo(frameGeo(mode, state.geo, state.source.width, state.source.height,
    state.output.width, state.output.height));
}

function setOutputSize(width, height, { refit = true } = {}) {
  state.output.width = clampDimension(width);
  state.output.height = clampDimension(height);
  $('out-w').value = state.output.width;
  $('out-h').value = state.output.height;
  const match = findPreset(state.output.width, state.output.height);
  $('preset').value = match ? match.id : 'custom';
  plate.setSize(state.output.width, state.output.height);
  if (refit && state.source) frame('fill');
  else {
    stage.draw();
    updateGeoReadouts();
    requestRender();
  }
  persist();
}

// ---------------------------------------------------------------- source

async function adoptSource(next, message) {
  if (state.source) release(state.source);
  state.source = next;
  $('src-name').textContent = next.name;
  $('src-dims').textContent = next.decodedWidth === next.width
    ? `${next.width} × ${next.height}`
    : `${next.decodedWidth} × ${next.decodedHeight} → ${next.width} × ${next.height}`;
  applyGeo(frameGeo('fill', { ...defaultGeo() }, next.width, next.height,
    state.output.width, state.output.height));
  say(message);
}

async function openFiles(files) {
  const images = [...files].filter((f) => !f.type || f.type.startsWith('image/'));
  if (images.length === 0) {
    say('That file is not an image.', 'error');
    return;
  }
  if (images.length > 1) {
    batch.add(images);
    batch.open();
    say(`Queued ${images.length} images for batch conversion.`);
    return;
  }
  try {
    say('Decoding…', 'busy');
    const source = await loadFile(images[0]);
    await adoptSource(source, `Loaded ${source.name}.`);
  } catch (err) {
    say(err?.message || 'Could not read that image.', 'error');
  }
}

// ---------------------------------------------------------------- actions

async function develop() {
  const lever = $('develop');
  lever.busy = true;
  try {
    const bytes = await currentBytes();
    if (!bytes || !bytes.length) return;
    await plate.develop(bytes, state.output.width, state.output.height);
    say('Plate developed.');
  } finally {
    lever.busy = false;
  }
}

async function exportAs(kind) {
  const format = FORMATS[kind];
  if (!format) return;
  if (!state.source) {
    say('Load an image first.', 'error');
    return;
  }
  const { width, height } = state.output;
  try {
    say(`Encoding ${format.label}…`, 'busy');
    const bytes = await currentBytes();
    const blob = await format.encode(bytes, width, height, {
      quality: state.output.quality,
      polarity: state.output.polarity,
      symbol: `image_${state.source.name.replace(/\.[^.]+$/, '')}`,
    });
    const name = outputName(state.source.name, width, height, format.ext);
    const written = await sink.write(name, blob);
    const where = written.target === 'folder' ? sink.label : 'your downloads';
    say(`Wrote ${written.name} · ${formatBytes(blob.size)} → ${where}`);
  } catch (err) {
    if (err?.name === 'AbortError') say('Export cancelled.');
    else say(err?.message || 'Export failed.', 'error');
  }
}

function autoTone() {
  if (!state.source) {
    say('Load an image first.', 'error');
    return;
  }
  const measured = cpu.measure(state.source, state.geo, settings());
  $('brightness').value = measured.brightness;
  $('contrast').value = measured.contrast;
  $('gamma').value = 1;
  readTone();
  say(`Auto tone: brightness ${measured.brightness.toFixed(2)}, contrast ${measured.contrast.toFixed(2)}.`);
}

// ------------------------------------------------------------ control sync

function readTone() {
  state.tone = {
    brightness: $('brightness').value,
    contrast: $('contrast').value,
    gamma: $('gamma').value,
    sharpen: $('sharpen').value,
    radius: Math.round($('radius').value),
    invert: $('invert').checked,
  };
  requestRender();
  persist();
}

function readScreen() {
  state.screen = {
    algo: $('algo').value,
    levels: Number($('levels').value),
    strength: $('strength').value,
    bias: $('bias').value,
    serpentine: $('serpentine').checked,
  };
  const spec = algorithm(state.screen.algo);
  // Serpentine and strength only mean something for error diffusion.
  $('serpentine').hidden = spec.kind !== 'diffusion';
  $('strength').hidden = spec.kind === 'none' || spec.kind === 'threshold';
  requestRender();
  persist();
}

function buildSelects() {
  const algoSelect = $('algo');
  let group = null;
  for (const spec of ALGORITHMS) {
    if (!group || group.label !== spec.group) {
      group = document.createElement('optgroup');
      group.label = spec.group;
      algoSelect.append(group);
    }
    const option = document.createElement('option');
    option.value = spec.id;
    option.textContent = spec.label;
    if (spec.id === state.screen.algo) option.selected = true;
    group.append(option);
  }

  const presetSelect = $('preset');
  for (const preset of PRESETS) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = `${preset.label} (${preset.note})`;
    presetSelect.append(option);
  }
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = 'Custom';
  presetSelect.append(custom);
  presetSelect.value = PRESETS[0].id;
}

// ------------------------------------------------------------------- wiring

function wireSource() {
  const input = $('file-input');
  const zone = $('dropzone');
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    if (input.files?.length) openFiles(input.files);
    input.value = '';
  });

  $('load-wedge').addEventListener('click', () => {
    adoptSource(testWedge(), 'Loaded the test wedge.');
  });

  // Window-wide drop, with a veil so the target is obvious.
  const veil = $('drop-veil');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    depth++;
    veil.classList.add('is-active');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) veil.classList.remove('is-active');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    veil.classList.remove('is-active');
    if (e.dataTransfer?.files?.length) openFiles(e.dataTransfer.files);
  });

  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      openFiles(files);
    }
  });
}

function wireGeometry() {
  $('rotate').addEventListener('input', () => {
    if (syncing) return;
    applyGeo({ ...state.geo, fine: $('rotate').value });
  });
  $('zoom').addEventListener('input', () => {
    if (syncing) return;
    const scale = clamp(2 ** $('zoom').value, SCALE_LIMITS.min, SCALE_LIMITS.max);
    applyGeo({ ...state.geo, scale });
  });
  $('rot-ccw').addEventListener('click', () => applyGeo({ ...state.geo, quarter: (state.geo.quarter + 3) % 4 }));
  $('rot-cw').addEventListener('click', () => applyGeo({ ...state.geo, quarter: (state.geo.quarter + 1) % 4 }));
  $('flip-h').addEventListener('change', () => applyGeo({ ...state.geo, flipH: $('flip-h').checked }));
  $('flip-v').addEventListener('change', () => applyGeo({ ...state.geo, flipV: $('flip-v').checked }));
  $('fit').addEventListener('click', () => frame('fit'));
  $('fill').addEventListener('click', () => frame('fill'));
  $('geo-reset').addEventListener('click', () => {
    if (!state.source) return;
    applyGeo(frameGeo('fill', { ...defaultGeo() }, state.source.width, state.source.height,
      state.output.width, state.output.height));
  });
}

function wireOutput() {
  $('preset').addEventListener('change', () => {
    const preset = PRESETS.find((p) => p.id === $('preset').value);
    if (preset) setOutputSize(preset.w, preset.h);
  });
  const commitSize = () => setOutputSize($('out-w').value, $('out-h').value);
  $('out-w').addEventListener('change', commitSize);
  $('out-h').addEventListener('change', commitSize);
  $('swap-size').addEventListener('click', () => {
    setOutputSize(state.output.height, state.output.width);
  });

  for (const radio of document.querySelectorAll('input[name="matte"]')) {
    radio.addEventListener('change', () => {
      state.output.matte = Number(radio.value);
      stage.draw();
      requestRender();
      persist();
    });
  }
  for (const radio of document.querySelectorAll('input[name="polarity"]')) {
    radio.addEventListener('change', () => {
      state.output.polarity = radio.value;
      persist();
    });
  }

  $('quality').addEventListener('input', () => {
    state.output.quality = $('quality').value;
    scheduleStats();
    persist();
  });
  $('live').addEventListener('change', () => {
    state.output.live = $('live').checked;
    if (state.output.live) requestRender();
    else markStale(true);
    persist();
  });
  $('grid').addEventListener('change', () => {
    state.output.grid = $('grid').checked;
    stage.draw();
    persist();
  });

  const folderButton = $('folder');
  if (!directoryPickerSupported()) {
    folderButton.disabled = true;
    $('folder-note').textContent = 'This browser has no folder picker. Exports download normally.';
  } else {
    folderButton.addEventListener('click', async () => {
      if (sink.connected) {
        sink.disconnect();
        return;
      }
      try {
        await sink.choose();
      } catch (err) {
        if (err?.name !== 'AbortError') say(err?.message || 'Could not open that folder.', 'error');
      }
    });
    sink.onChange(() => {
      folderButton.textContent = sink.connected ? 'Disconnect folder' : 'Output folder…';
      $('folder-note').textContent = sink.connected
        ? `Exports go straight into ${sink.label}/.`
        : 'Exports download normally.';
    });
  }
}

function wireTone() {
  for (const id of ['brightness', 'contrast', 'gamma', 'sharpen', 'radius']) {
    $(id).addEventListener('input', readTone);
  }
  $('invert').addEventListener('change', readTone);
  $('auto-tone').addEventListener('click', autoTone);
  $('tone-reset').addEventListener('click', () => {
    for (const id of ['brightness', 'contrast', 'gamma', 'sharpen', 'radius']) $(id).reset();
    $('invert').reset();
    readTone();
    say('Tone reset.');
  });
}

function wireScreen() {
  $('algo').addEventListener('change', readScreen);
  $('levels').addEventListener('change', readScreen);
  for (const id of ['strength', 'bias']) $(id).addEventListener('input', readScreen);
  $('serpentine').addEventListener('change', readScreen);
}

function wireConsole() {
  $('develop').addEventListener('pull', develop);
  $('export-jpg').addEventListener('click', () => exportAs('jpg'));
  $('export-png').addEventListener('click', () => exportAs('png'));
  $('export-bin').addEventListener('click', () => exportAs('bin'));
  $('export-h').addEventListener('click', () => exportAs('h'));

  const zoomChips = document.querySelectorAll('.zoom-group [data-zoom]');
  for (const button of zoomChips) {
    button.addEventListener('click', () => {
      const value = button.dataset.zoom;
      plate.setZoom(value === 'fit' ? 'fit' : Number(value));
      for (const other of zoomChips) {
        other.setAttribute('aria-pressed', String(other === button));
      }
    });
  }
}

function openRecipe() {
  refreshRecipeSheet();
  const sheet = $('recipe-sheet');
  if (!sheet.open) sheet.showModal();
}

function wireRecipe() {
  const sheet = $('recipe-sheet');
  const resetButton = $('recipe-reset');
  let armed = null;

  const disarm = () => {
    clearTimeout(armed);
    armed = null;
    resetButton.textContent = 'Reset everything';
    resetButton.classList.remove('is-armed');
  };

  $('recipe-open').addEventListener('click', openRecipe);
  sheet.addEventListener('close', disarm);

  $('recipe-copy').addEventListener('click', async () => {
    const field = $('recipe-link');
    field.select();
    try {
      // Absent outside a secure context, which is exactly where the LAN
      // fallbacks live, so leave the text selected for a manual copy.
      await navigator.clipboard.writeText(field.value);
      $('recipe-note').textContent = 'Link copied to the clipboard.';
    } catch {
      $('recipe-note').textContent = 'Press Ctrl/Cmd+C to copy the selected link.';
    }
  });

  resetButton.addEventListener('click', () => {
    if (!armed) {
      resetButton.textContent = 'Tap again to confirm';
      resetButton.classList.add('is-armed');
      armed = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    applyRecipe(defaultRecipe());
    persistNow();
    refreshRecipeSheet();
    say('Reset to factory settings.');
  });
}

function wireChrome() {
  const help = $('help-sheet');
  $('help-open').addEventListener('click', () => help.showModal());
  $('backend-badge').addEventListener('click', openRenderer);

  const toggle = $('theme-toggle');
  const applyTheme = (theme) => {
    document.documentElement.dataset.theme = theme;
    toggle.setAttribute('aria-pressed', String(theme === 'dark'));
    toggle.textContent = theme === 'dark' ? 'Daylight' : 'Darkroom';
    stage.refreshTheme();
    stage.draw();
  };
  const stored = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  applyTheme(stored || (prefersDark ? 'dark' : 'light'));
  toggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });

  window.addEventListener('inkmagine:gpu-lost', () => {
    gpu = null;
    setBadge('cpu');
    say('GPU device lost. Continuing on the CPU.', 'error');
    requestRender();
  });
}

function wireBatch() {
  const dialog = $('batch-sheet');
  const input = $('batch-input');
  batch = createBatch({
    dialog,
    list: $('batch-list'),
    runButton: $('batch-run'),
    clearButton: $('batch-clear'),
    progress: $('batch-progress'),
    formatSelect: $('batch-format'),
    zipSwitch: $('batch-zip'),
    fitRadios: document.querySelectorAll('input[name="batch-fit"]'),
    sink,
    getSettings: settings,
    log: say,
  });

  $('batch-open').addEventListener('click', () => batch.open());
  const zone = $('batch-drop');
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    if (input.files?.length) batch.add(input.files);
    input.value = '';
  });
  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.add('is-over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    zone.addEventListener(type, (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('is-over');
      if (type === 'drop' && e.dataTransfer?.files?.length) batch.add(e.dataTransfer.files);
    });
  }
}

function wireKeys() {
  window.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing = target instanceof HTMLElement
      && (target.matches('input, select, textarea') || target.isContentEditable);
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.querySelector('dialog[open]') && event.key !== '?') return;

    const geo = state.geo;
    switch (event.key) {
      case 'f': frame('fit'); break;
      case 'F': frame('fill'); break;
      case 'r': case 'R': $('geo-reset').click(); break;
      case 'a': case 'A': autoTone(); break;
      case 'i': case 'I':
        $('invert').checked = !$('invert').checked;
        readTone();
        break;
      case 'd': case 'D': develop(); break;
      case 'e': case 'E': exportAs('jpg'); break;
      case 's': case 'S': openRecipe(); break;
      case '[':
        applyGeo(event.shiftKey
          ? { ...geo, quarter: (geo.quarter + 3) % 4 }
          : { ...geo, fine: clamp(geo.fine - 1, -180, 180) });
        break;
      case ']':
        applyGeo(event.shiftKey
          ? { ...geo, quarter: (geo.quarter + 1) % 4 }
          : { ...geo, fine: clamp(geo.fine + 1, -180, 180) });
        break;
      case '?':
        $('help-sheet').open ? $('help-sheet').close() : $('help-sheet').showModal();
        break;
      default: {
        const index = Number(event.key) - 1;
        if (Number.isInteger(index) && index >= 0 && index < QUICK_ALGOS.length) {
          $('algo').value = QUICK_ALGOS[index];
          readScreen();
          say(`Screen: ${algorithm(QUICK_ALGOS[index]).label}.`);
          break;
        }
        return;
      }
    }
    event.preventDefault();
  });
}

// -------------------------------------------------------------------- boot

async function boot() {
  defineElements();
  buildSelects();

  plate = new Plate({
    root: $('plate-root'),
    canvas2d: $('plate-2d'),
    canvasGpu: $('plate-gpu'),
  });
  plate.setSize(state.output.width, state.output.height);

  stage = new Stage($('stage'), {
    getState: () => state,
    onChange: applyGeo,
    onFit: () => frame('fit'),
    onCommit: () => scheduleStats(),
  });
  stage.refreshTheme();

  wireSource();
  wireGeometry();
  wireOutput();
  wireTone();
  wireScreen();
  wireConsole();
  wireBatch();
  wireRecipe();
  wireChrome();
  wireKeys();

  // Restoring drives every control, which reads back into the state, so this
  // stands in for the initial readTone()/readScreen() pass as well.
  const startup = startupRecipe();
  applyRecipe(startup.recipe, { refit: false });
  if (startup.from === 'link') {
    // A link is an import, not a mode: drop it from the address bar so a
    // later refresh continues from wherever the settings have got to.
    history.replaceState(null, '', location.pathname + location.search);
  }

  stage.draw();
  updateGeoReadouts();
  updateStats();

  await installGrain();
  stage.refreshTheme();
  stage.draw();

  gpu = await GpuRenderer.create($('plate-gpu'));
  setBadge(gpu ? 'gpu' : 'cpu');

  ready = true;
  if (startup.from === 'link') persistNow();

  requestRender();
  const restored = startup.from === 'link'
    ? 'Recipe loaded from the link. '
    : startup.from === 'session' ? 'Settings restored. ' : '';
  say(`${restored}Ready.${gpu ? ' WebGPU online.' : ''} Drop an image, or press the test wedge.`);
}

boot().catch((err) => {
  console.error(err);
  say(err?.message || 'Inkmagine failed to start.', 'error');
});
