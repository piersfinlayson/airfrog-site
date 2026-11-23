// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The Airfrog manifest and the firmware manifest, signed with a key made here, a release's files from
// the fake release in fixtures/releases/, the release's copy of Airfrog's
// internal JS setup module, MD5 against RFC 1321's vectors, and the models
// the Model select lists for a board.

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { md5Hex } from '../../commissioning/md5.js';
import {
  ReleaseError, latestRelease, loadFirmware, loadReleases, loadSetup, boardModels,
} from '../../commissioning/release.js';
import { DOWNLOAD_TIMEOUT_MS, MODELS } from '../../js/schema.js';

const RELEASE = new URL('fixtures/releases/v0.2.0/firmware/mini/', import.meta.url);
const AIRFROG_URL = 'https://meta.test/airfrog/manifest.json';
const MANIFEST_URL = 'https://images.test/firmware/manifest.json';
const AIRFROG = { type: 'airfrog', version: 1, ui_manifest: 'https://images.test/ui/manifest.json',
  firmware_manifest: MANIFEST_URL, js_library: 'https://images.test/js/' };
// The fixture release's files are served at BASE.
const BASE = 'https://images.test/firmware/airfrog-mini/v0.2.0/airfrog-mini.factory/';
const FLASH = 4194304;

const keys = generateKeyPairSync('ed25519');
const KEY = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

const sha = (data) => createHash('sha256').update(data).digest('hex');
const SETUP = new TextEncoder().encode('export const API = 2;\n');

/** The firmware manifest of the fixture release, as ci/release-firmware.py writes it. */
async function firmwareManifest() {
  const commission = JSON.parse(await readFile(new URL('commission.json', RELEASE), 'utf8'));
  const files = commission.files.map((f) => ({ offset: f.offset, url: `${BASE}${f.file}`,
    size: f.size, sha256: f.sha256 }));
  const image = files.find((f) => f.url.endsWith('/airfrog.bin'));
  return {
    type: 'firmware', version: 1, latest: { 'airfrog-mini': '0.2.0' },
    firmware: {
      'airfrog-mini': [{ version: '0.2.0', commit: '1a2b3c4d',
        image: { url: image.url, size: image.size, sha256: image.sha256 },
        setup: { url: 'https://images.test/firmware/airfrog-mini/v0.2.0/setup.js', size: SETUP.length,
          sha256: sha(SETUP) },
        flash_size: FLASH, files }],
    },
  };
}

/** body's minisign signature file, as the signing server writes it. */
function minisig(body, key = keys.privateKey, algorithm = 'Ed') {
  const signature = sign(null, body, key);
  const trusted = Buffer.from('timestamp:0\tfile:manifest.json');
  const line = Buffer.concat([Buffer.from(algorithm), Buffer.from(KEY.slice(0, 16), 'hex'), signature]);
  return Buffer.from(`untrusted comment: signature from the Airfrog signing server\n${line.toString('base64')}\n`
    + `trusted comment: ${trusted}\n${sign(null, Buffer.concat([signature, trusted]), key).toString('base64')}\n`);
}

/** The manifest and its signature file, served at url. */
function signedAt(url, manifest, key = keys.privateKey) {
  const body = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  return { [url]: body, [`${url}.minisig`]: minisig(body, key) };
}

/** The firmware manifest at MANIFEST_URL and the Airfrog manifest, each with its signature file. */
function signed(manifest, key = keys.privateKey, airfrog = AIRFROG) {
  return { ...signedAt(AIRFROG_URL, airfrog), ...signedAt(MANIFEST_URL, manifest, key) };
}

// fetch for the fixture release's files at BASE, and the firmware manifest
// and setup.js served. replace maps a URL's last part to other bytes to
// serve.
function fakeFetch(served = {}, replace = {}) {
  const fetched = [];
  const fn = async (url) => {
    fetched.push(url);
    const name = url.split('/').pop();
    let data = replace[name] ?? served[url];
    if (data === undefined && url.startsWith(BASE)) {
      try {
        data = await readFile(new URL(url.slice(BASE.length), RELEASE));
      } catch {
        return new Response('', { status: 404 });
      }
    }
    return data === undefined ? new Response('', { status: 404 }) : new Response(data);
  };
  return { fn, fetched };
}

test('loads and verifies the firmware manifest', async () => {
  const manifest = await firmwareManifest();
  const { fn } = fakeFetch(signed(manifest));
  assert.deepEqual(await loadReleases(AIRFROG_URL, KEY, { fetch: fn }), manifest);
});

test('rejects a firmware manifest that is unsigned, signed by another key or invalid', async () => {
  const manifest = await firmwareManifest();
  const other = generateKeyPairSync('ed25519').privateKey;
  const good = signed(manifest);
  const tampered = signed(manifest);
  tampered[MANIFEST_URL][tampered[MANIFEST_URL].length - 3] ^= 1;
  const cases = {
    'a prehashed signature': { ...good, [`${MANIFEST_URL}.minisig`]: minisig(good[MANIFEST_URL], keys.privateKey, 'ED') },
    'another key': signed(manifest, other),
    tampered,
    'a UI manifest': signed({ ...manifest, type: 'ui' }),
    'without firmware': signed({ ...manifest, firmware: undefined }),
    'without releases': signed({ ...manifest, firmware: { 'airfrog-mini': [] } }),
    'without latest': signed({ ...manifest, latest: undefined }),
    'a latest release not listed': signed({ ...manifest, latest: { 'airfrog-mini': '0.2.1' } }),
    'not JSON': { ...signedAt(AIRFROG_URL, AIRFROG), [MANIFEST_URL]: Buffer.from('x'), [`${MANIFEST_URL}.minisig`]: minisig(Buffer.from('x')) },
    'an empty signature file': { ...good, [`${MANIFEST_URL}.minisig`]: Buffer.from('') },
    'an Airfrog manifest of another type': signed(manifest, keys.privateKey, { ...AIRFROG, type: 'ui' }),
    'an Airfrog manifest without firmware_manifest': signed(manifest, keys.privateKey,
      { ...AIRFROG, firmware_manifest: undefined }),
    'an Airfrog manifest signed by another key': { ...good, ...signedAt(AIRFROG_URL, AIRFROG, other) },
  };
  for (const [name, served] of Object.entries(cases)) {
    const { fn } = fakeFetch(served);
    await assert.rejects(loadReleases(AIRFROG_URL, KEY, { fetch: fn }), ReleaseError, name);
  }
  {
    const { fn } = fakeFetch({ ...signedAt(AIRFROG_URL, AIRFROG), [MANIFEST_URL]: good[MANIFEST_URL] });
    await assert.rejects(loadReleases(AIRFROG_URL, KEY, { fetch: fn }), /HTTP 404/, 'without a signature file');
  }
  const { fn } = fakeFetch();
  await assert.rejects(loadReleases(AIRFROG_URL, KEY, { fetch: fn }), /HTTP 404/);
  await assert.rejects(loadReleases(AIRFROG_URL, '', { fetch: fn }), /Manifest key not set/);
});

test('a download that receives nothing in time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const release = (await firmwareManifest()).firmware['airfrog-mini'][0];
  // A server that doesn't answer, and one that stops part way.
  const answers = [
    (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    async (url, { signal }) => new Response(new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1]));
        signal.addEventListener('abort', () => c.error(signal.reason));
      },
    })),
  ];
  for (const fn of answers) {
    for (const [load, message] of [
      [() => loadReleases(AIRFROG_URL, KEY, { fetch: fn }), 'Release list download failed (timed out).'],
      [() => loadFirmware(release, FLASH, { fetch: fn }), 'Firmware download failed (timed out).'],
      [() => loadSetup(release, { fetch: fn }), 'Release v0.2.0 download failed (timed out).'],
    ]) {
      const loaded = assert.rejects(load(), { message });
      await new Promise(setImmediate);
      t.mock.timers.tick(DOWNLOAD_TIMEOUT_MS);
      await loaded;
    }
  }
});

test('the latest release of a firmware, and a firmware without one', async () => {
  const manifest = await firmwareManifest();
  const [release] = manifest.firmware['airfrog-mini'];
  const older = { ...release, version: '0.1.0' };
  manifest.firmware['airfrog-mini'].push(older);
  assert.equal(latestRelease(manifest, 'mini'), release);
  manifest.latest['airfrog-mini'] = '0.1.0';
  assert.equal(latestRelease(manifest, 'mini'), older);
  assert.equal(latestRelease({ ...manifest, latest: {} }, 'mini'), null);
  assert.equal(latestRelease(manifest, 'pro'), null);
});

test('downloads and checks every file, in address order', async () => {
  const release = (await firmwareManifest()).firmware['airfrog-mini'][0];
  const { fn } = fakeFetch();
  const progress = [];
  const files = await loadFirmware(release, FLASH,
    { fetch: fn, onProgress: (done, total) => progress.push([done, total]) });
  assert.deepEqual(files.map((f) => [f.offset, f.url.split('/').pop(), f.data.length]), [
    [0, 'bootloader.bin', 300],
    [32768, 'partition-table.bin', 3072],
    [53248, 'otadata.bin', 8192],
    [327680, 'airfrog.bin', 5000],
  ]);
  assert.deepEqual(files[3].data, new Uint8Array(await readFile(new URL('airfrog.bin', RELEASE))));
  assert.deepEqual(progress.at(-1), [16564, 16564]);
  assert.equal(progress.length, 5);
});

test('rejects a file of the wrong size or SHA-256, a missing file and another flash size', async () => {
  const release = (await firmwareManifest()).firmware['airfrog-mini'][0];
  const data = new Uint8Array(await readFile(new URL('airfrog.bin', RELEASE)));
  data[100] ^= 1;
  for (const replace of [{ 'otadata.bin': new Uint8Array(8191) }, { 'airfrog.bin': data }]) {
    const { fn } = fakeFetch({}, replace);
    await assert.rejects(loadFirmware(release, FLASH, { fetch: fn }),
      { message: 'Firmware download corrupt.' });
  }
  const gone = structuredClone(release);
  gone.files[0].url += '.gone';
  await assert.rejects(loadFirmware(gone, FLASH, { fetch: fakeFetch().fn }),
    { message: 'Firmware download failed (HTTP 404).' });
  await assert.rejects(loadFirmware(release, 8388608, { fetch: fakeFetch().fn }), ReleaseError);
});

test("imports the release's copy of Airfrog's internal JS setup module after checking it", async () => {
  const release = (await firmwareManifest()).firmware['airfrog-mini'][0];
  const imported = [];
  const importFn = async (url) => { imported.push(url); return { API: 2 }; };
  const { fn } = fakeFetch({ [release.setup.url]: SETUP });
  assert.deepEqual(await loadSetup(release, { fetch: fn, importFn }), { API: 2 });
  assert.ok(imported[0].startsWith('blob:'));
  const bad = fakeFetch({ [release.setup.url]: new TextEncoder().encode('export const API = 3;\n') });
  await assert.rejects(loadSetup(release, { fetch: bad.fn, importFn }), /Release v0.2.0 download corrupt\./);
  assert.equal(imported.length, 1);
});

test('MD5 matches RFC 1321 and node:crypto', () => {
  const md5 = (s) => md5Hex(new TextEncoder().encode(s));
  assert.equal(md5(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(md5('message digest'), 'f96b697d7cb7938d525a2f31aaf161d0');
  assert.equal(md5('1234567890'.repeat(8)), '57edf4a22be3c955ac49da2e2107b67a');
  for (const n of [55, 56, 63, 64, 65, 100000]) {
    const b = Uint8Array.from({ length: n }, (_, i) => i * 31 + 7);
    assert.equal(md5Hex(b), createHash('md5').update(b).digest('hex'), String(n));
  }
});

// Run with the test models (ci/test-commissioning.sh): Mini v2 is released on
// the C3 and Pro v2 isn't released.
test("lists the released models whose MCU and PSRAM match the board's, lowest number first", () => {
  const keys = (board) => boardModels(board).map((v) => v.key);
  assert.deepEqual(keys({ name: 'ESP32-C3', psram: false }), ['mini', 'mini-v2']);
  assert.deepEqual(boardModels({ name: 'ESP32-C3', psram: false }).map((v) => v.number), [1, 98]);
  assert.deepEqual(keys({ name: 'ESP32-C3', psram: true }), ['mini', 'mini-v2']);
  assert.deepEqual(keys({ name: 'ESP32-S3', psram: true }), ['pro']);
  assert.deepEqual(keys({ name: 'ESP32-S3', psram: false }), []);
  assert.deepEqual(keys({ name: 'ESP32-C6', psram: false }), []);
  assert.equal(boardModels({ name: 'ESP32-S3', psram: true })[0].name, MODELS[2].name);
});
