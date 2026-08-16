// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// Registers the Houdini paint worklets, and marks the document when they are
// unavailable so the stylesheet can fall back.

const PROPERTIES = [
  { name: '--grain-ink', syntax: '<color>', initialValue: '#17140f', inherits: true },
  { name: '--grain-density', syntax: '<number>', initialValue: '0.5', inherits: true },
  { name: '--grain-seed', syntax: '<number>', initialValue: '7', inherits: true },
  { name: '--grain-strength', syntax: '<number>', initialValue: '0.06', inherits: true },
  { name: '--halftone-ink', syntax: '<color>', initialValue: '#17140f', inherits: true },
  { name: '--halftone-pitch', syntax: '<number>', initialValue: '6', inherits: true },
  { name: '--halftone-radius', syntax: '<number>', initialValue: '0.3', inherits: true },
  { name: '--halftone-strength', syntax: '<number>', initialValue: '0.5', inherits: true },
];

export async function installGrain() {
  const supported = typeof CSS !== 'undefined' && CSS.paintWorklet;
  if (!supported) {
    document.documentElement.classList.add('no-houdini');
    return false;
  }

  for (const descriptor of PROPERTIES) {
    try {
      CSS.registerProperty(descriptor);
    } catch {
      // Already registered, or the browser rejects the syntax: harmless.
    }
  }

  try {
    // Relative so the site works from a project subpath on GitHub Pages.
    await CSS.paintWorklet.addModule(new URL('../../worklets/grain.js', import.meta.url));
    return true;
  } catch (err) {
    console.warn('[inkmagine] paint worklet unavailable:', err);
    document.documentElement.classList.add('no-houdini');
    return false;
  }
}
