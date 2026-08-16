// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// Where exported files go: a chosen directory via the File System Access API,
// or an ordinary download when that is unavailable (Firefox, Safari, iOS).

export function directoryPickerSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

export class OutputSink {
  constructor() {
    this.handle = null;
    this.listeners = new Set();
  }

  get connected() {
    return !!this.handle;
  }

  get label() {
    return this.handle ? this.handle.name : 'Downloads';
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify() {
    for (const fn of this.listeners) fn(this);
  }

  async choose() {
    if (!directoryPickerSupported()) throw new Error('directory picker unsupported');
    const handle = await window.showDirectoryPicker({ id: 'inkmagine-out', mode: 'readwrite' });
    const permission = await handle.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') throw new Error('write permission denied');
    this.handle = handle;
    this.notify();
    return handle;
  }

  disconnect() {
    this.handle = null;
    this.notify();
  }

  /**
   * @returns {Promise<{name: string, target: 'folder'|'download'}>}
   */
  async write(name, blob) {
    if (!this.handle) {
      download(name, blob);
      return { name, target: 'download' };
    }
    // Re-checking is cheap and the grant can lapse between sessions.
    const permission = await this.handle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
      const asked = await this.handle.requestPermission({ mode: 'readwrite' });
      if (asked !== 'granted') {
        this.disconnect();
        download(name, blob);
        return { name, target: 'download' };
      }
    }
    const unique = await this.uniqueName(name);
    const file = await this.handle.getFileHandle(unique, { create: true });
    const stream = await file.createWritable();
    await stream.write(blob);
    await stream.close();
    return { name: unique, target: 'folder' };
  }

  /** `plate.jpg` -> `plate-2.jpg` when the name is taken. */
  async uniqueName(name) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 1; n < 1000; n++) {
      const candidate = n === 1 ? name : `${stem}-${n}${ext}`;
      try {
        await this.handle.getFileHandle(candidate);
      } catch (err) {
        if (err?.name === 'NotFoundError') return candidate;
        throw err;
      }
    }
    return `${stem}-${Date.now()}${ext}`;
  }
}

export function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
