// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The model of the firmware a board starts, read from a fake flash as the
// ESP-IDF bootloader chooses it: the partition table, otadata's two entries
// and the selected app slot.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InstalledError, checkInstalled, installedModel } from '../../commissioning/image.js';
import {
  OTADATA, OTA_0, OTA_1, app, loaderWith as flashOf, otadata, regions,
} from './flash.mjs';

/** A flash with the partition table and each of at: [offset, bytes]. */
const loaderWith = (...at) => flashOf(...regions(...at));

test("accepts the CRC of airfrog-v2's release otadata.bin", async () => {
  // Sequence 1 selects ota_0. The CRC is the one in the release's otadata.bin.
  assert.equal(await installedModel(loaderWith([OTA_0, app(1)], [OTADATA, otadata(1, { crc: 0x4743989a })])), 1);
});

test('reads the model of the slot otadata selects', async () => {
  const both = [[OTA_0, app(1)], [OTA_1, app(2)]];
  assert.equal(await installedModel(loaderWith(...both, [OTADATA, otadata(1)])), 1);
  assert.equal(await installedModel(loaderWith(...both, [OTADATA, otadata(2)])), 2);
  assert.equal(await installedModel(loaderWith(...both, [OTADATA, otadata(1)], [OTADATA + 0x1000, otadata(2)])), 2);
  assert.equal(await installedModel(loaderWith(...both, [OTADATA, otadata(3)], [OTADATA + 0x1000, otadata(2)])), 1);
});

test('ignores an otadata entry with a wrong CRC or a pending verify, invalid or aborted state', async () => {
  const both = [[OTA_0, app(1)], [OTA_1, app(2)]];
  const first = [OTADATA, otadata(1)];
  for (const newer of [otadata(2, { crc: 1 }), otadata(2, { state: 1 }), otadata(2, { state: 3 }), otadata(2, { state: 4 })]) {
    assert.equal(await installedModel(loaderWith(...both, first, [OTADATA + 0x1000, newer])), 1);
  }
  assert.equal(await installedModel(loaderWith(...both, [OTADATA, otadata(2, { state: 0 })])), 2);
});

test('fails for a flash that holds no firmware', async () => {
  const slots = [[OTA_0, app(1)], [OTA_1, app(1)]];
  const cases = {
    'blank otadata': loaderWith(...slots),
    'otadata with a wrong CRC': loaderWith(...slots, [OTADATA, otadata(1, { crc: 5 })]),
    'otadata with both entries invalid': loaderWith(...slots, [OTADATA, otadata(1, { state: 3 })],
      [OTADATA + 0x1000, otadata(2, { state: 4 })]),
    'a blank slot': loaderWith([OTA_1, app(1)], [OTADATA, otadata(1)]),
    'a slot that isn\'t an image': loaderWith([OTA_0, app(1, 0)], [OTADATA, otadata(1)]),
    'a blank partition table': flashOf([OTA_0, app(1)], [OTADATA, otadata(1)]),
    'a read that fails': { async readFlash() { throw new Error('Failed to read memory: 1'); } },
  };
  for (const [name, loader] of Object.entries(cases)) {
    await assert.rejects(installedModel(loader), (e) => e instanceof InstalledError
      && e.message === 'Airfrog firmware not found.' && e.next === 'Select Install firmware.', name);
  }
});

test("displays the model on the board and the chosen one when they differ", async () => {
  const loader = loaderWith([OTA_0, app(1)], [OTADATA, otadata(1)]);
  await checkInstalled(loader, { number: 1, name: 'Mini' });
  await assert.rejects(checkInstalled(loader, { number: 2, name: 'Pro' }),
    { message: 'Airfrog firmware is for Mini, not Pro.' });
  const unknown = loaderWith([OTA_0, app(7)], [OTADATA, otadata(1)]);
  await assert.rejects(checkInstalled(unknown, { number: 2, name: 'Pro' }),
    { message: 'Airfrog firmware is for Model 7, not Pro.' });
});
