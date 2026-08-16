// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// Output size presets. 480x800 is the default and always sorts first.

export const PRESETS = [
  { id: '480x800', w: 480, h: 800, label: '480 × 800', note: '7.5″ e-paper, portrait' },
  { id: '800x480', w: 800, h: 480, label: '800 × 480', note: '7.5″ e-paper, landscape' },
  { id: '800x600', w: 800, h: 600, label: '800 × 600', note: '6″ / 7.8″ panels' },
  { id: '640x384', w: 640, h: 384, label: '640 × 384', note: '7.5″ v1' },
  { id: '400x300', w: 400, h: 300, label: '400 × 300', note: '4.2″' },
  { id: '296x128', w: 296, h: 128, label: '296 × 128', note: '2.9″' },
  { id: '250x122', w: 250, h: 122, label: '250 × 122', note: '2.13″' },
  { id: '1404x1872', w: 1404, h: 1872, label: '1404 × 1872', note: '10.3″, portrait' },
  { id: '1200x825', w: 1200, h: 825, label: '1200 × 825', note: '12.48″' },
  { id: '320x240', w: 320, h: 240, label: '320 × 240', note: 'QVGA TFT' },
  { id: '128x64', w: 128, h: 64, label: '128 × 64', note: 'SSD1306 OLED' },
];

export const DEFAULT_PRESET = PRESETS[0];

export const MAX_DIMENSION = 8192;

export function findPreset(w, h) {
  return PRESETS.find((p) => p.w === w && p.h === h) || null;
}

export function clampDimension(v) {
  const n = Math.round(Number(v) || 0);
  return Math.min(MAX_DIMENSION, Math.max(8, n));
}
