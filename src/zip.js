// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// Minimal ZIP writer, store-only (no compression).
//
// Batch output is almost entirely JPEG and PNG, both already compressed, so
// deflate would cost CPU and save nothing. Store keeps this dependency-free
// and about a hundred lines.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosStamp(date) {
  const time = ((date.getHours() & 0x1f) << 11)
    | ((date.getMinutes() & 0x3f) << 5)
    | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9)
    | (((date.getMonth() + 1) & 0x0f) << 5)
    | (date.getDate() & 0x1f);
  return { time, day };
}

/**
 * @param {Array<{name: string, data: Uint8Array, date?: Date}>} entries
 * @returns {Blob} an uncompressed .zip
 */
export function makeZip(entries) {
  const encoder = new TextEncoder();
  const prepared = entries.map((entry) => {
    const name = encoder.encode(entry.name);
    return { ...entry, nameBytes: name, crc: crc32(entry.data), stamp: dosStamp(entry.date || new Date()) };
  });

  const localSize = prepared.reduce((n, e) => n + 30 + e.nameBytes.length + e.data.length, 0);
  const centralSize = prepared.reduce((n, e) => n + 46 + e.nameBytes.length, 0);
  const buffer = new ArrayBuffer(localSize + centralSize + 22);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let offset = 0;
  for (const entry of prepared) {
    entry.offset = offset;
    view.setUint32(offset, 0x04034b50, true);      // local file header
    view.setUint16(offset + 4, 20, true);          // version needed
    view.setUint16(offset + 6, 0, true);           // flags
    view.setUint16(offset + 8, 0, true);           // method: store
    view.setUint16(offset + 10, entry.stamp.time, true);
    view.setUint16(offset + 12, entry.stamp.day, true);
    view.setUint32(offset + 14, entry.crc, true);
    view.setUint32(offset + 18, entry.data.length, true);
    view.setUint32(offset + 22, entry.data.length, true);
    view.setUint16(offset + 26, entry.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true);          // extra field length
    offset += 30;
    bytes.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;
    bytes.set(entry.data, offset);
    offset += entry.data.length;
  }

  const centralStart = offset;
  for (const entry of prepared) {
    view.setUint32(offset, 0x02014b50, true);      // central directory header
    view.setUint16(offset + 4, 20, true);          // version made by
    view.setUint16(offset + 6, 20, true);          // version needed
    view.setUint16(offset + 8, 0, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, entry.stamp.time, true);
    view.setUint16(offset + 14, entry.stamp.day, true);
    view.setUint32(offset + 16, entry.crc, true);
    view.setUint32(offset + 20, entry.data.length, true);
    view.setUint32(offset + 24, entry.data.length, true);
    view.setUint16(offset + 28, entry.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true);          // extra
    view.setUint16(offset + 32, 0, true);          // comment
    view.setUint16(offset + 34, 0, true);          // disk number
    view.setUint16(offset + 36, 0, true);          // internal attrs
    view.setUint32(offset + 38, 0, true);          // external attrs
    view.setUint32(offset + 42, entry.offset, true);
    offset += 46;
    bytes.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;
  }

  view.setUint32(offset, 0x06054b50, true);        // end of central directory
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, offset - centralStart, true); // central dir size
  view.setUint32(offset + 16, centralStart, true);
  view.setUint16(offset + 20, 0, true);            // comment length

  return new Blob([buffer], { type: 'application/zip' });
}
