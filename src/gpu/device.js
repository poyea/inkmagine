// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// WebGPU adapter/device acquisition, probed once and cached.

let pending = null;
let state = { supported: false, device: null, format: null, reason: 'not probed' };

/** Blank fields are normal: Chrome and Safari both mask most adapter info. */
function describe(adapter) {
  const raw = adapter.info || {};
  return {
    vendor: raw.vendor || '',
    architecture: raw.architecture || '',
    // A software rasteriser reports as a GPU but is often slower than the CPU.
    fallback: adapter.isFallbackAdapter === true,
    maxTexture: adapter.limits?.maxTextureDimension2D || 0,
  };
}

export function gpuState() {
  return state;
}

export function gpuAvailable() {
  return !!state.device;
}

/** Resolves to a device, or null if WebGPU is unusable here. */
export function initGpu() {
  if (pending) return pending;
  pending = (async () => {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      // A LAN IP over plain HTTP hides navigator.gpu entirely, which reads as
      // "this browser has no WebGPU" when the real problem is the origin. Say
      // which one it is, because the fix is completely different.
      const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
      state = {
        supported: false,
        device: null,
        format: null,
        reason: insecure ? 'not a secure context, needs HTTPS or localhost' : 'no navigator.gpu',
      };
      return null;
    }
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) {
        state = { supported: false, device: null, format: null, reason: 'no adapter' };
        return null;
      }
      const device = await adapter.requestDevice();
      const format = navigator.gpu.getPreferredCanvasFormat();

      device.lost.then((info) => {
        // A lost device cannot be revived; drop to the CPU path and say so.
        state = { supported: false, device: null, format: null, reason: `device lost: ${info.reason || 'unknown'}` };
        window.dispatchEvent(new CustomEvent('inkmagine:gpu-lost', { detail: info }));
      });

      // Surface validation errors instead of silently drawing nothing.
      device.addEventListener?.('uncapturederror', (event) => {
        console.error('[inkmagine] WebGPU error:', event.error?.message || event.error);
      });

      state = { supported: true, device, format, reason: 'ok', adapter, info: describe(adapter) };
      return device;
    } catch (err) {
      state = { supported: false, device: null, format: null, reason: err?.message || String(err) };
      return null;
    }
  })();
  return pending;
}
