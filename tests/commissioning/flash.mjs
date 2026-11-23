// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// A fake Airfrog flash as ESP-IDF's bootloader reads it: the partition table,
// otadata's two entries and an app image in each slot, for the tests of the
// model a board starts.

import { crc32 } from 'node:zlib';
import { IMAGE_MODEL_OFFSET } from '../../js/schema.js';

export const OTADATA = 0xd000;
export const OTA_0 = 0x50000;
export const OTA_1 = 0x1d0000;
export const FACTORY = 0x10000;
export const PARTITION_TABLE = 0x8000;
const FLASH_SIZE = 4 * 1024 * 1024;

/** A partition table entry: type, subtype, offset, size and name. */
function entry(type, subtype, offset, size, name) {
  const e = new Uint8Array(32);
  const view = new DataView(e.buffer);
  view.setUint16(0, 0x50aa, true);
  e[2] = type;
  e[3] = subtype;
  view.setUint32(4, offset, true);
  view.setUint32(8, size, true);
  e.set(new TextEncoder().encode(name), 12);
  return e;
}

/** airfrog-v2's partition table (docs/ac3-design.md). */
export const TABLE = [
  entry(1, 2, 0x9000, 0x3000, 'nvs'), entry(1, 0, OTADATA, 0x2000, 'otadata'),
  entry(0, 0, FACTORY, 0x40000, 'factory'), entry(0, 0x10, OTA_0, 0x180000, 'ota_0'),
  entry(0, 0x11, OTA_1, 0x180000, 'ota_1'),
];

/** An otadata entry for sequence number seq, with state, a valid CRC unless crc is provided. */
export function otadata(seq, { state = 2, crc } = {}) {
  const e = new Uint8Array(32).fill(0xff);
  const view = new DataView(e.buffer);
  view.setUint32(0, seq, true);
  view.setUint32(24, state, true);
  // esp_rom_crc32_le(UINT32_MAX, &seq, 4)
  view.setUint32(28, crc ?? crc32(e.subarray(0, 4), 0xffffffff), true);
  return e;
}

/** The start of an app image of model. */
export function app(model, magic = 0xe9) {
  const image = new Uint8Array(IMAGE_MODEL_OFFSET + 16);
  image[0] = magic;
  new DataView(image.buffer).setUint16(IMAGE_MODEL_OFFSET, model, true);
  return image;
}

/**
 * The regions of a flash with the partition table, and each of at: [offset,
 * bytes]. The rest of the flash is blank.
 * @returns {Array<[number, Uint8Array]>}
 */
export function regions(...at) {
  return [[PARTITION_TABLE, Uint8Array.from(TABLE.flatMap((e) => [...e]))], ...at];
}

/** A flash of regions, 4 MB and blank outside them, with readFlash() as esptool-js's loader has. */
export function loaderWith(...at) {
  const flash = new Uint8Array(FLASH_SIZE).fill(0xff);
  for (const [offset, bytes] of at) flash.set(bytes, offset);
  return {
    async readFlash(address, size) {
      return flash.slice(address, address + size);
    },
  };
}
