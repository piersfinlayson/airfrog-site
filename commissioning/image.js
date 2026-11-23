// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The Airfrog model of the firmware on a board, read over esptool-js. The
// bootloader's choice of app is ESP-IDF's: the partition table at 0x8000 lists
// the otadata and app partitions, and the otadata entries select the slot.

import { IMAGE_MODEL_OFFSET, MODELS } from '../js/schema.js';
import { COMMISSIONING_FIRMWARE, VALUES } from '../js/messages.js';

const PARTITION_TABLE = 0x8000;
const PARTITION_ENTRY = 32;
const PARTITION_MAGIC = 0x50aa;
const TYPE_APP = 0;
const TYPE_DATA = 1;
const SUBTYPE_OTA_DATA = 0;
const SUBTYPE_OTA_0 = 0x10;
const SUBTYPE_OTA_LAST = 0x1f;
const OTA_ENTRY = 32;
const OTA_SECTOR = 0x1000;
const OTA_STATE_OFFSET = 24;
const OTA_CRC_OFFSET = 28;
const OTA_STATE_PENDING_VERIFY = 1;
const OTA_STATE_INVALID = 3;
const OTA_STATE_ABORTED = 4;
const BLANK = 0xffffffff;
const IMAGE_MAGIC = 0xe9;

/** The firmware on the board isn't the chosen model's, or isn't there. */
export class InstalledError extends Error {
  /** unreadable is true when reading the flash failed. */
  constructor([message, next], unreadable = false) {
    super(message);
    this.next = next;
    this.unreadable = unreadable;
  }
}

const NOT_FOUND = [COMMISSIONING_FIRMWARE.FIRMWARE_NOT_FOUND, COMMISSIONING_FIRMWARE.SELECT_INSTALL];

/** esp_rom_crc32_le(UINT32_MAX, data, length), with which ESP-IDF checks an otadata entry. */
function crc32(data) {
  let crc = 0;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ BLANK) >>> 0;
}

/**
 * The app partitions' offsets, indexed by slot, and the otadata partition's
 * offset, from the partition table.
 */
function partitions(table) {
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const slots = [];
  let otadata = null;
  for (let at = 0; at + PARTITION_ENTRY <= table.length; at += PARTITION_ENTRY) {
    if (view.getUint16(at, true) !== PARTITION_MAGIC) break;
    const type = table[at + 2];
    const subtype = table[at + 3];
    const offset = view.getUint32(at + 4, true);
    if (type === TYPE_DATA && subtype === SUBTYPE_OTA_DATA) {
      otadata = offset;
    } else if (type === TYPE_APP && subtype >= SUBTYPE_OTA_0 && subtype <= SUBTYPE_OTA_LAST) {
      slots[subtype - SUBTYPE_OTA_0] = offset;
    }
  }
  return { slots, otadata };
}

/**
 * An otadata entry's sequence number, or null when the bootloader ignores the
 * entry. With app rollback enabled (sdkconfig.boot) the bootloader marks a
 * PENDING_VERIFY entry ABORTED before it chooses.
 */
function sequence(entry) {
  const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
  const seq = view.getUint32(0, true);
  const state = view.getUint32(OTA_STATE_OFFSET, true);
  if (seq === BLANK || state === OTA_STATE_PENDING_VERIFY || state === OTA_STATE_INVALID
      || state === OTA_STATE_ABORTED
      || view.getUint32(OTA_CRC_OFFSET, true) !== crc32(entry.subarray(0, 4))) {
    return null;
  }
  return seq;
}

/**
 * The model number in the Airfrog firmware the board starts: the app slot
 * the otadata selects.
 * @param {{readFlash: function(number, number): Promise<Uint8Array>}} loader esptool-js's loader
 * @returns {Promise<number>}
 * @throws {InstalledError} when the flash doesn't contain a firmware image
 */
export async function installedModel(loader) {
  try {
    const { slots, otadata } = partitions(await loader.readFlash(PARTITION_TABLE, 0x1000));
    if (otadata === null || !slots.length) throw new InstalledError(NOT_FOUND);
    const seqs = [];
    for (let i = 0; i < 2; i++) {
      seqs.push(sequence(await loader.readFlash(otadata + i * OTA_SECTOR, OTA_ENTRY)));
    }
    const valid = seqs.filter((s) => s !== null);
    if (!valid.length) throw new InstalledError(NOT_FOUND);
    const slot = (Math.max(...valid) - 1) % slots.length;
    if (slots[slot] === undefined) throw new InstalledError(NOT_FOUND);
    const image = await loader.readFlash(slots[slot], IMAGE_MODEL_OFFSET + 2);
    if (image[0] !== IMAGE_MAGIC) throw new InstalledError(NOT_FOUND);
    return new DataView(image.buffer, image.byteOffset, image.byteLength).getUint16(IMAGE_MODEL_OFFSET, true);
  } catch (err) {
    if (err instanceof InstalledError) throw err;
    throw new InstalledError(NOT_FOUND, true);
  }
}

/**
 * Checks the firmware on the board is model's.
 * @param loader esptool-js's loader
 * @param {{number: number, name: string}} model a boardModels() entry
 * @throws {InstalledError} when the flash doesn't contain a firmware image or the image is another model's
 */
export async function checkInstalled(loader, model) {
  const number = await installedModel(loader);
  if (number !== model.number) {
    throw new InstalledError([COMMISSIONING_FIRMWARE.WRONG_FIRMWARE(MODELS[number]?.name ?? VALUES.MODEL(number),
      model.name), undefined]);
  }
}
