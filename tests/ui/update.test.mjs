// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Airfrog's firmware update: the firmware manifest's latest release, OTA,
// the restart, reconnecting and OTA_CONFIRM.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { espImage, serve, statuses, until } from './helpers.mjs';
import { Session } from '../../js/setup/session.js';
import { Command } from '../../js/setup/protocol.js';
import {
    checkFirmwareFile, compareVersions, describeResult, downloadFirmware, firmwareRelease, imageVersion, isOlder,
    keepResult, runUpdate, takeResult,
} from '../../js/setup/update.js';
import { sha256 } from '../../js/sha256.js';
import { ReleaseError, checkFirmwareManifest, findRelease } from '../../js/setup/releases.js';
import { hex } from '../../js/setup/bytes.js';
import { AIRFROG_CMD, AP_BUTTON } from './fake-airfrog.mjs';
import { signedFile } from './minisign.mjs';
import { readSignedFile, signatureFor } from '../../js/signed.js';
import { BACKUP_KEY, TEST_KEY } from './minisign.mjs';
import { IMAGE_MODEL_OFFSET, MODELS, Model } from '../../js/schema.js';

const SHA = 'ab'.repeat(32);
/** A signature, which the fake Airfrog doesn't check. */
const SIGNED = new Uint8Array(74).fill(7);
/** The test model that isn't released (ci/schema.py --test). */
const UNRELEASED = Number(Object.keys(MODELS).find(n => MODELS[n].key === null));

/**
 * An Airfrog firmware release whose factory files are a bootloader at 0 and
 * image at 0x50000, at its own URL as release files are.
 */
const release = (version, image, extra = {}) => ({
    version, commit: '1a2b3c4d', ...extra, image, setup: { url: `${image.url}.js`, size: 1, sha256: SHA },
    flash_size: 4 << 20,
    files: [{ offset: 0, url: `${image.url}.boot`, size: 100, sha256: SHA },
        { offset: 0x50000, ...image, url: `${image.url}.factory` }],
});

/** A firmware manifest whose latest Mini release is version, with image. */
const manifest = (image, version = '0.2.1', extra = {}) => {
    const mini = { url: `https://site.test/airfrog-mini/v${version}/airfrog-mini.bin`, size: image.length,
        sha256: hex(sha256(image)) };
    return {
        type: 'firmware', version: 1, latest: { 'airfrog-mini': version },
        firmware: {
            'airfrog-mini': [release(version, mini, extra), release('0.0.1', { ...mini, url: `${mini.url}.old` })],
        },
    };
};

/** The manifest's Mini releases. */
const miniOf = (m) => m.firmware['airfrog-mini'];

/** download()'s options to receive bytes, or the HTTP status. */
const fetchOf = (bytes, status = 200) => ({ fetch: async () => new Response(bytes, { status }) });

async function connected(config) {
    const { fake, host } = serve(config);
    const session = new Session(host, { retryMs: 10 });
    const seen = statuses(session);
    session.start();
    await until(() => session.airfrog);
    return { fake, session, seen };
}

/** The AIRFROG_CMD commands the fake received, in order. */
const commands = (fake) => fake.received.filter(m => m.type === AIRFROG_CMD).map(m => m.payload[0] | (m.payload[1] << 8));

test("an ESP-IDF image's version", () => {
    assert.equal(imageVersion(espImage('0.2.1')), '0.2.1');
    const notApp = espImage('0.2.1');
    notApp[32] = 0;
    assert.equal(imageVersion(notApp), null);
    assert.equal(imageVersion(new Uint8Array(100)), null);
    assert.equal(imageVersion(espImage('0.2.1').subarray(0, 79)), null);
});

test("a chosen file is checked: an ESP-IDF app image of Airfrog's project for this Airfrog's model", () => {
    const invalid = { version: null, error: 'Invalid firmware file.' };
    assert.deepEqual(checkFirmwareFile(espImage('0.2.1'), Model.MINI), { version: '0.2.1', error: null });
    assert.deepEqual(checkFirmwareFile(espImage('0.2.1', 10000, { chip: 9, model: Model.PRO }), Model.PRO),
        { version: '0.2.1', error: null });
    assert.deepEqual(checkFirmwareFile(espImage('0.2.1', 10000, { chip: 9, model: UNRELEASED }), UNRELEASED),
        { version: '0.2.1', error: null }, 'firmware for a model not released');
    assert.deepEqual(checkFirmwareFile(espImage('0.2.1', 10000, { chip: 9, model: Model.PRO }), Model.MINI),
        { version: null, error: 'Invalid firmware file (incorrect Airfrog model).' }, 'firmware for another model');
    assert.deepEqual(checkFirmwareFile(espImage('0.2.1', 10000, { model: Model.MINI_V2 }), Model.MINI),
        { version: null, error: 'Invalid firmware file (incorrect Airfrog model).' },
        'another model on the same chip');
    assert.deepEqual(checkFirmwareFile(espImage('0.2.1', 10000, { project: 'other' }), Model.MINI), invalid, 'another project');
    assert.deepEqual(checkFirmwareFile(espImage('0.2.1', 10000, { project: 'airfrogx' }), Model.MINI), invalid);
    const notApp = espImage('0.2.1');
    notApp[32] = 0;
    assert.deepEqual(checkFirmwareFile(notApp, Model.MINI), invalid, 'not an ESP-IDF app image');
    assert.deepEqual(checkFirmwareFile(espImage('0.2.1').subarray(0, IMAGE_MODEL_OFFSET + 1), Model.MINI), invalid, 'too short');
});

test('a signed file: the image, zeros to 4 bytes, AFSG and the signature', () => {
    const image = espImage('0.2.1');
    const file = signedFile(image);
    const split = readSignedFile(file, 'firmware');
    assert.deepEqual(split.image, image);
    assert.equal(split.signature.length, 74);
    assert.deepEqual([...split.signature.subarray(0, 2)], [0x45, 0x64]);
    assert.deepEqual(readSignedFile(image, 'firmware'), { image, signature: null }, 'an unsigned file ends with the image');
    assert.equal(readSignedFile(Uint8Array.from([...file, 0]), 'firmware'), null, 'a byte after the signature');
    assert.equal(readSignedFile(Uint8Array.from([...image, 1]), 'firmware'), null, 'a byte after the image');
    const badMagic = file.slice();
    badMagic[image.length] = 0x42;
    assert.equal(readSignedFile(badMagic, 'firmware'), null, 'another magic');
    assert.equal(readSignedFile(image.subarray(0, 9000), 'firmware'), null, 'an image shorter than its segments');
    const hashed = espImage('0.2.1', 10032);
    hashed[23] = 1;
    new DataView(hashed.buffer).setUint32(28, 10000 - 48, true);
    assert.deepEqual(readSignedFile(hashed, 'firmware').image, hashed, 'an appended SHA-256 is part of the image');
    const odd = espImage('0.2.1', 10000);
    odd[1] = 2;
    new DataView(odd.buffer).setUint32(28, 100, true);
    new DataView(odd.buffer).setUint32(32 + 100 + 4, 10000 - 48 - 108, true);
    assert.equal(readSignedFile(odd, 'firmware').image.length, 10000, 'two segments');
    const padded = espImage('0.2.1', 10000).subarray(0, 9998);
    new DataView(padded.buffer).setUint32(28, 9998 - 48 - 8, true);
    const unaligned = readSignedFile(padded, 'firmware');
    assert.equal(unaligned, null, 'a checksum not ending a 16-byte block');
});

test("a signature is sent only when Airfrog has its key, by key ID", () => {
    const signature = readSignedFile(signedFile(espImage('0.2.1')), 'firmware').signature;
    const key = (k) => Uint8Array.from(k.match(/../g), b => parseInt(b, 16));
    assert.equal(signatureFor(signature, [key(BACKUP_KEY), key(TEST_KEY)]), signature);
    assert.equal(signatureFor(signature, [key(BACKUP_KEY)]), null, 'signed with a key Airfrog does not have');
    assert.equal(signatureFor(signature, []), null);
    assert.equal(signatureFor(null, [key(TEST_KEY)]), null, 'unsigned');
});

test('firmware older than the running firmware, as Airfrog decides it', () => {
    assert.equal(isOlder('0.2.0', '0.2.1'), true);
    assert.equal(isOlder('0.2.1', '0.2.1'), false, 'the same version');
    assert.equal(isOlder('0.10.0', '0.9.9'), false, 'by number');
    assert.equal(isOlder('v0.3.0', '0.2.1'), true, "a version that isn't MAJOR.MINOR.PATCH");
    assert.equal(isOlder(null, '0.2.1'), true);
    assert.equal(isOlder('0.0.1', 'dev'), false, "a running version that isn't is the oldest");
});

test("a model whose name has a space: its manifest key has a hyphen", () => {
    const m = manifest(espImage('0.2.1'), '0.2.1');
    m.firmware = { 'airfrog-mini-v2': miniOf(m) };
    m.latest = { 'airfrog-mini-v2': '0.2.1' };
    assert.equal(MODELS[Model.MINI_V2].key, 'mini-v2');
    assert.equal(MODELS[Model.MINI_V2].name, 'Mini v2');
    assert.equal(firmwareRelease(m, Model.MINI_V2, '0.2.0').offer.version, '0.2.1');
    assert.equal(firmwareRelease(m, Model.MINI, '0.2.0'), null);
});

test('versions in order', () => {
    assert.equal(compareVersions('0.2.1', '0.2.0'), 1);
    assert.equal(compareVersions('v0.2.0', '0.2.0'), 0);
    assert.equal(compareVersions('0.2.9', '0.10.0'), -1);
});

test("the firmware manifest's latest release for this model: the latest, or offered when newer", () => {
    const m = manifest(espImage('0.2.1'), '0.2.1', { commit: '5e6f7a8b', notes: 'https://site.test/notes' });
    const mini = miniOf(m)[0].image;
    assert.deepEqual(firmwareRelease(m, Model.MINI, '0.2.0'), { latest: false, offer: { version: '0.2.1', commit: '5e6f7a8b',
        notes: 'https://site.test/notes', ...mini } });
    assert.deepEqual(firmwareRelease(m, Model.MINI, '0.2.1'), { latest: true, offer: null });
    assert.deepEqual(firmwareRelease(m, Model.MINI, '0.3.0'), { latest: false, offer: null }, 'an older release isn\'t offered');
    assert.equal(firmwareRelease(manifest(espImage('x')), Model.MINI, '0.2.0').offer.notes, null);
    assert.equal(firmwareRelease(m, Model.PRO, '0.2.0'), null, 'a model without releases');
    assert.equal(firmwareRelease(m, UNRELEASED, '0.2.0'), null, 'a model not released');
    assert.equal(firmwareRelease(m, 7, '0.2.0'), null);
    assert.equal(firmwareRelease(null, Model.MINI, '0.2.0'), null);
    const promoted = { ...m, latest: { 'airfrog-mini': '0.0.1' } };
    assert.equal(firmwareRelease(promoted, Model.MINI, '0.0.0').offer.version, '0.0.1',
        'the latest release can be lower than another');
    assert.deepEqual(firmwareRelease(promoted, Model.MINI, '0.0.1'), { latest: true, offer: null });
    assert.deepEqual(firmwareRelease(promoted, Model.MINI, '0.2.0'), { latest: false, offer: null });
    assert.equal(firmwareRelease({ ...m, latest: {} }, Model.MINI, '0.0.0'), null,
        'firmware without a latest release isn\'t offered');
    const other = manifest(espImage('x'), '0.3.0');
    other.firmware = { 'airfrog-other': [{}] };
    other.latest = { 'airfrog-other': '9.9.9' };
    assert.equal(firmwareRelease(other, Model.MINI, '0.0.0'), null, 'a firmware not used is ignored');
});

test('an invalid firmware manifest fails', () => {
    const bad = [
        {},
        { ...manifest(espImage('x')), type: 'ui' },
        { ...manifest(espImage('x')), firmware: null },
        { type: 'firmware', version: 1, latest: {}, releases: [] },
        { ...manifest(espImage('x')), latest: undefined },
        { ...manifest(espImage('x')), latest: [] },
        { ...manifest(espImage('x')), latest: { 'airfrog-mini': '0.2.2' } },
        { ...manifest(espImage('x')), latest: { 'airfrog-mini': null } },
        { ...manifest(espImage('x')), latest: { 'airfrog-pro': '0.2.1' } },
    ];
    const edit = (fn) => { const m = manifest(espImage('x')); fn(m); bad.push(m); };
    edit((m) => { m.firmware['airfrog-mini'] = []; });
    edit((m) => { m.firmware['airfrog-mini'] = {}; });
    edit((m) => { miniOf(m)[1].version = miniOf(m)[0].version; });
    edit((m) => { miniOf(m)[1].version = '0.3.0'; });
    edit((m) => { miniOf(m)[0].version = '0.9.0'; miniOf(m)[1].version = '0.10.0'; });
    edit((m) => { miniOf(m)[0].version = 'v0.2.1'; });
    edit((m) => { miniOf(m)[0].commit = 'XYZ'; });
    edit((m) => { delete miniOf(m)[0].commit; });
    edit((m) => { miniOf(m)[0].notes = 'http://site.test/'; });
    edit((m) => { delete miniOf(m)[0].setup; });
    edit((m) => { delete miniOf(m)[0].flash_size; });
    edit((m) => { delete miniOf(m)[0].files; });
    edit((m) => { miniOf(m)[0].image.sha256 = SHA; });
    edit((m) => { miniOf(m)[0].files[1].offset = 50; });
    edit((m) => { miniOf(m)[0].files[1].offset = 0; });
    edit((m) => { miniOf(m)[0].files[1].offset = (4 << 20) - 4096; });
    bad.forEach((m, i) => assert.throws(() => checkFirmwareManifest(m), ReleaseError, `case ${i}`));
    assert.doesNotThrow(() => checkFirmwareManifest(manifest(espImage('x'))));
    const tenth = manifest(espImage('x'), '0.10.0');
    miniOf(tenth)[1].version = '0.9.0';
    assert.doesNotThrow(() => checkFirmwareManifest(tenth), 'version order is numeric');
    const unused = manifest(espImage('x'));
    unused.firmware['airfrog-other'] = 'x';
    unused.latest.other = '1.0.0';
    unused.firmware.other = null;
    assert.doesNotThrow(() => checkFirmwareManifest(unused), 'firmware not read is ignored');
    assert.doesNotThrow(() => checkFirmwareManifest({ type: 'firmware', version: 1, latest: {}, firmware: {} }));
});

test("an update's result is kept while the page reloads", () => {
    const store = new Map();
    const storage = { setItem: (k, v) => store.set(k, v), getItem: (k) => store.get(k) ?? null,
        removeItem: (k) => store.delete(k) };
    const result = { running: '0.2.1', commit: '5e6f7a8b', wanted: '0.2.1' };
    assert.ok(keepResult(result, storage));
    assert.deepEqual(takeResult(storage), result);
    assert.equal(takeResult(storage), null, 'it is displayed once');
    const broken = { setItem: () => { throw new Error('denied'); }, getItem: () => { throw new Error('denied'); } };
    assert.equal(keepResult(result, broken), false);
    assert.equal(takeResult(broken), null);
});

test("the release's firmware is checked against its size and SHA-256", async () => {
    const image = espImage('0.2.1');
    const offer = firmwareRelease(manifest(image, '0.2.1', { commit: '5e6f7a8b' }), Model.MINI, '0.2.0').offer;
    const file = signedFile(image);
    const signed = firmwareRelease(manifest(file, '0.2.1', { commit: '5e6f7a8b' }), Model.MINI, '0.2.0').offer;
    const got = await downloadFirmware(signed, fetchOf(file));
    assert.deepEqual([got.image, got.signature], [image, file.subarray(image.length + 4)],
        'a signed file is split into its image and signature');
    assert.deepEqual(await downloadFirmware(offer, fetchOf(image)), { image, signature: null });
    await assert.rejects(downloadFirmware(offer, fetchOf(image.subarray(0, image.length - 1))),
        /Firmware v0.2.1 \(5e6f7a8b\) download failed \(file corrupt\)\./);
    const other = image.slice();
    other[100] ^= 1;
    await assert.rejects(downloadFirmware(offer, fetchOf(other)), /Firmware v0.2.1 \(5e6f7a8b\) download failed \(file corrupt\)\./);
    await assert.rejects(downloadFirmware(offer, fetchOf(image, 404)), /HTTP 404/);
    await assert.rejects(downloadFirmware(offer, { fetch: async () => { throw new Error('offline'); } }), /offline/);
    await assert.rejects(downloadFirmware(offer, { timeoutMs: 10, fetch: (url, { signal }) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))) }),
    { message: 'Firmware v0.2.1 (5e6f7a8b) download failed (timed out).' });
});

test('a mismatched download never reaches OTA_BEGIN', async () => {
    const image = espImage('0.2.1');
    const { fake, session } = await connected();
    const offer = firmwareRelease(manifest(image), Model.MINI, '0.2.0').offer;
    await assert.rejects(downloadFirmware(offer, fetchOf(image.subarray(1))));
    assert.ok(!commands(fake).includes(Command.OTA_BEGIN));
    session.stop();
});

test('updates, reconnects after the restart and confirms', async () => {
    const image = espImage('0.2.1', 10000);
    const { fake, session, seen } = await connected({ maxTransfer: 4096, newVersion: [0, 2, 1] });
    const phases = [];
    const progress = [];
    const signature = signedFile(image).subarray(image.length + 4);
    const result = await runUpdate({ session, image, signature, version: '0.2.1', restartMs: 2000,
        onPhase: (p) => phases.push(p), onProgress: (f) => progress.push(f) });
    assert.deepEqual(fake.signatures.at(-1), signature, "OTA_BEGIN contains the image's signature");
    assert.deepEqual(result, { running: '0.2.1', commit: '5e6f7a8b', wanted: '0.2.1', wantedCommit: '', booted: true });
    assert.deepEqual(describeResult(result), { text: 'Updated to firmware v0.2.1 (5e6f7a8b).', ok: true });
    assert.deepEqual(fake.finished.data, image);
    assert.ok(fake.confirmed && !fake.waitingConfirm);
    const sent = commands(fake);
    assert.deepEqual(sent.slice(0, 5), [Command.OTA_BEGIN, Command.OTA_WRITE, Command.OTA_WRITE, Command.OTA_WRITE, Command.OTA_FINISH]);
    assert.deepEqual(sent.slice(-2), [Command.GET_FW_INFO, Command.OTA_CONFIRM]);
    const writes = fake.received.filter(m => m.type === AIRFROG_CMD && m.payload[0] === Command.OTA_WRITE)
        .map(m => [new DataView(m.payload.buffer, m.payload.byteOffset).getUint32(2, true), m.payload.length - 6]);
    assert.deepEqual(writes, [[0, 4096], [4096, 4096], [8192, 1808]]);
    assert.deepEqual(progress, [0, 4096 / 10000, 8192 / 10000, 1]);
    assert.deepEqual(phases, ['Updating to firmware v0.2.1…', 'Verifying the firmware…', ''],
        "the connection's status displays the restart");
    assert.ok(seen.some(s => s.message === 'Restarting into firmware v0.2.1…' && s.expected));
    assert.ok(fake.closes.includes(1001));
    session.stop();
});

test('firmware that returned to the previous version is reported', async () => {
    const image = espImage('0.2.1');
    const { session } = await connected({ newVersion: [0, 2, 1], rollback: true });
    const result = await runUpdate({ session, image, signature: SIGNED, version: 'v0.2.1', restartMs: 2000 });
    assert.deepEqual(result, { running: '0.2.0', commit: '1a2b3c4d', wanted: '0.2.1', wantedCommit: '', booted: false });
    assert.deepEqual(describeResult(result),
        { ok: false, text: 'Update to firmware v0.2.1 failed. Reverted to firmware v0.2.0 (1a2b3c4d).' });
    assert.equal(describeResult({ ...result, wantedCommit: '5e6f7a8b' }).text,
        'Update to firmware v0.2.1 (5e6f7a8b) failed. Reverted to firmware v0.2.0 (1a2b3c4d).');
    session.stop();
});

test("a model's release found by version, with or without v", () => {
    const m = manifest(espImage('x'), '0.2.1');
    assert.equal(findRelease(m, 'mini', 'v0.2.1'), miniOf(m)[0]);
    assert.equal(findRelease(m, 'mini', '0.0.1'), miniOf(m)[1]);
    assert.equal(findRelease(m, 'mini', '0.9.9'), null);
    assert.equal(findRelease(m, 'other', '0.2.1'), null);
});

test('OTA_BEGIN fails with UPDATE_IN_PROGRESS', async () => {
    const { fake, session } = await connected({ otaErrors: { [Command.OTA_BEGIN]: 9 } });
    await assert.rejects(runUpdate({ session, image: espImage('0.2.1'), signature: SIGNED, version: '0.2.1' }),
        (e) => e.code === 'CODE' && e.detail === 9);
    assert.deepEqual(commands(fake).filter(c => c >= Command.OTA_BEGIN), [Command.OTA_BEGIN]);
    session.stop();
});

test("a first write that isn't an ESP-IDF image fails with IMAGE_INVALID", async () => {
    const image = espImage('0.2.1');
    image[0] = 0;
    const { session } = await connected();
    await assert.rejects(runUpdate({ session, image, signature: SIGNED, version: '0.2.1' }), (e) => e.code === 'IMAGE_INVALID');
    session.stop();
});

test("another model's image sent straight to Airfrog, without the file check, fails with IMAGE_INVALID before anything is accepted", async () => {
    // In the largest writes, and in writes smaller than the image's first IMAGE_MODEL_OFFSET + 2 bytes.
    for (const maxTransfer of [4096, 100]) {
        const { fake, session } = await connected({ maxTransfer });
        const image = espImage('0.2.1', 10000, { chip: 9, model: Model.PRO });
        await assert.rejects(runUpdate({ session, image, signature: SIGNED, version: '0.2.1' }),
            { code: 'IMAGE_INVALID', message: 'Invalid firmware file.' }, String(maxTransfer));
        assert.ok(fake.ota === null && !fake.finished, 'nothing is accepted');
        const writes = commands(fake).filter(c => c === Command.OTA_WRITE).length;
        assert.equal(writes, Math.ceil((IMAGE_MODEL_OFFSET + 2) / maxTransfer), 'it fails at the write that completes the head');
        session.stop();
    }
});

test('an image of the device\'s model is accepted in small writes', async () => {
    const { fake, session } = await connected({ maxTransfer: 100 });
    await runUpdate({ session, image: espImage('0.2.1'), signature: SIGNED, version: '0.2.1' });
    assert.ok(fake.finished);
    session.stop();
});

test("an image shorter than its model number's offset fails at OTA_FINISH", async () => {
    const { session } = await connected();
    await assert.rejects(runUpdate({ session, image: espImage('0.2.1').slice(0, IMAGE_MODEL_OFFSET + 1), signature: SIGNED, version: '0.2.1' }),
        (e) => e.code === 'IMAGE_INVALID');
    session.stop();
});

test("OTA_FINISH's failed check doesn't wait for a restart", async () => {
    const { fake, session, seen } = await connected({ corruptOta: true });
    await assert.rejects(runUpdate({ session, image: espImage('0.2.1'), signature: SIGNED, version: '0.2.1', restartMs: 200 }),
        (e) => e.code === 'IMAGE_INVALID');
    assert.ok(!fake.closes.includes(1001));
    fake.closeAll(4006);
    await until(() => seen.at(-1).message === 'Network settings changed. Reconnecting…');
    session.stop();
});

test("Airfrog that doesn't reconnect after the restart", async () => {
    const { fake, session } = await connected({ restartMs: 1000 });
    await assert.rejects(runUpdate({ session, image: espImage('0.2.1'), signature: SIGNED, version: '0.2.1', restartMs: 50,
        previous: { version: '0.2.0', commit: '1a2b3c4d' } }),
    { message: 'No response from Airfrog after restart. Airfrog will revert to firmware v0.2.0 (1a2b3c4d) '
        + 'within 2 minutes.' });
    assert.ok(fake.restarting);
    session.stop();
});

test('unsigned firmware fails with NOT_PERMITTED except over the recovery button\'s access point', async () => {
    let { fake, session } = await connected();
    await assert.rejects(runUpdate({ session, image: espImage('0.2.1'), signature: null, version: '0.2.1' }),
        { code: 'NOT_PERMITTED' });
    assert.ok(fake.signatures.at(-1).every(b => b === 0), 'OTA_BEGIN contains 74 zero bytes');
    session.stop();
    ({ fake, session } = await connected({ interface: AP_BUTTON }));
    await runUpdate({ session, image: espImage('0.2.1'), signature: null, version: '0.2.1', restartMs: 2000 });
    assert.ok(fake.finished);
    session.stop();
});

test('older firmware fails with NOT_PERMITTED at the write of its head', async () => {
    const { fake, session } = await connected({ version: [0, 3, 0] });
    await assert.rejects(runUpdate({ session, image: espImage('0.2.1'), signature: SIGNED, version: '0.2.1' }),
        { code: 'NOT_PERMITTED' });
    assert.ok(!fake.finished);
    session.stop();
});

test("a failed OTA_FINISH: the session's next connection is checked", async () => {
    const { Airfrog } = await import('../../js/airfrog.js');
    for (const [what, config] of [['a close other than 1001', { finishClose: 4000 }],
        ['an ERROR', { otaErrors: { [Command.OTA_FINISH]: 16 } }]]) {
        const { host } = serve(config);
        const calls = [];
        const session = new Session(host, { retryMs: 10, connect: (h, p, options) => {
            calls.push(options);
            return Airfrog.connect(h, p);
        } });
        session.start();
        await until(() => session.airfrog);
        await assert.rejects(runUpdate({ session, image: espImage('0.2.1'), signature: SIGNED, version: '0.2.1',
            restartMs: 2000 }), what);
        await until(() => session.airfrog && calls.length > 1, 3000).catch(() => {});
        assert.ok(calls.slice(1).every(o => !o.confirming), `${what}: no connection opens unchecked (${JSON.stringify(calls)})`);
        session.stop();
    }
});

test('hostile segment lengths', () => {
    const hostile = (lengths, size = 110) => {
        const data = new Uint8Array(size);
        data[0] = 0xE9;
        data[1] = lengths.length;
        let at = 24;
        for (const n of lengths) {
            new DataView(data.buffer).setUint32(at + 4, n, true);
            at += 8;
        }
        return data;
    };
    // One segment of 0xFFFFFFF0 would end at 32 on 32-bit integers.
    const wrapped = hostile([0xFFFFFFF0]);
    wrapped.set(new TextEncoder().encode('AFSG'), 32);
    assert.equal(readSignedFile(wrapped, 'firmware'), null, 'a length that would wrap');
    assert.equal(readSignedFile(hostile([0x80000000]), 'firmware'), null, 'a length past 2^31');
    assert.equal(readSignedFile(hostile([0x7FFFFFF0, 0x7FFFFFF0]), 'firmware'), null, 'lengths that add past 2^32');
    assert.equal(readSignedFile(hostile([0xFFFFFFFF, 0]), 'firmware'), null, 'a length past the file');
});

test("the running image's SHA-256 decides: a new image that didn't boot isn't confirmed, even at the same version", async () => {
    const { fake, session } = await connected({ rollback: true });
    const result = await runUpdate({ session, image: espImage('0.2.0'), signature: SIGNED, version: '0.2.0',
        restartMs: 2000 });
    assert.equal(result.booted, false);
    assert.equal(describeResult(result).ok, false);
    assert.match(describeResult(result).text, /^Update to firmware v0\.2\.0 failed\. Reverted to firmware v0\.2\.0/);
    assert.ok(!commands(fake).includes(Command.OTA_CONFIRM), 'OTA_CONFIRM is not sent');
    session.stop();

    const ok = await connected({});
    const same = await runUpdate({ session: ok.session, image: espImage('0.2.0'), signature: SIGNED, version: '0.2.0',
        restartMs: 2000 });
    assert.equal(same.booted, true, 'the same version, booted');
    assert.ok(commands(ok.fake).includes(Command.OTA_CONFIRM) && ok.fake.confirmed, 'OTA_CONFIRM is sent');
    ok.session.stop();
});
