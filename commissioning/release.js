// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Airfrog's releases, from the firmware manifest: downloading an Airfrog
// firmware release's files, and importing the release's Airfrog's internal JS
// setup module. Reading and verifying a manifest through the Airfrog manifest,
// which airfrog.org/cli also uses. Also the released models whose firmware
// runs on a board.

import { download } from '../js/setup/download.js';
import { ReleaseError, checkFirmwareManifest } from '../js/setup/releases.js';
import { CHIPS, MODELS } from '../js/schema.js';
import { COMMISSIONING_FIRMWARE, RELEASE_LIST } from '../js/messages.js';

export { ReleaseError, findRelease, latestRelease, modelReleases } from '../js/setup/releases.js';

/**
 * The released models whose firmware runs on a board, lowest model number
 * first, each its MODELS entry with its number. board is { name, psram }: the
 * MCU's name as esptool-js reports it and whether the board has PSRAM. A
 * model on an MCU the schema records PSRAM for requires PSRAM.
 * @returns {object[]}
 */
export function boardModels(board) {
  return Object.entries(MODELS)
    .map(([number, v]) => ({ number: Number(number), ...v }))
    .sort((a, b) => a.number - b.number)
    .filter((v) => v.key && CHIPS[v.chip].name === board.name && (!CHIPS[v.chip].psram || board.psram));
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(text) {
  return new Uint8Array(text.match(/../g).map((b) => parseInt(b, 16)));
}

async function sha256Hex(data) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

async function get(url, fetchFn, what, options = {}) {
  try {
    return await download(url, { ...options, fetch: fetchFn });
  } catch (e) {
    if (e.timedOut) {
      throw new ReleaseError(COMMISSIONING_FIRMWARE.DOWNLOAD_TIMED_OUT(what));
    }
    throw new ReleaseError(e.status === null ? COMMISSIONING_FIRMWARE.DOWNLOAD_FAILED(what)
      : COMMISSIONING_FIRMWARE.DOWNLOAD_HTTP(what, e.status));
  }
}

/**
 * Downloads a manifest and its minisign signature file, url with .minisig
 * added, verifies the signature with key, the manifest key's public half in
 * hex, and checks its type. The signature is minisign's legacy Ed25519
 * signature on the file's second line.
 * @returns {Promise<object>} the manifest
 */
async function signedManifest(url, key, type, fetchFn) {
  const list = COMMISSIONING_FIRMWARE.RELEASE_LIST;
  const [body, minisig] = await Promise.all([get(url, fetchFn, list, { cache: 'no-cache' }),
    get(`${url}.minisig`, fetchFn, list, { cache: 'no-cache' })]);
  let signature = null;
  try {
    const line = new TextDecoder().decode(minisig).split('\n')[1];
    signature = Uint8Array.from(atob(line.trim()), (c) => c.charCodeAt(0));
  } catch {
    // An invalid signature fails below.
  }
  let valid = false;
  if (signature?.length === 74 && signature[0] === 0x45 && signature[1] === 0x64) {
    const publicKey = await crypto.subtle.importKey('raw', fromHex(key), { name: 'Ed25519' }, false, ['verify']);
    valid = await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature.subarray(10), body);
  }
  if (!valid) {
    throw new ReleaseError(RELEASE_LIST.SIGNATURE);
  }
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new ReleaseError(RELEASE_LIST.INVALID);
  }
  if (manifest?.type !== type) {
    throw new ReleaseError(RELEASE_LIST.INVALID);
  }
  return manifest;
}

/**
 * Downloads and verifies the Airfrog manifest at url, then the manifest of
 * type at the Airfrog manifest's field. key is the manifest key's public half
 * in hex, which signs both.
 * @returns {Promise<object>} the manifest of type
 */
export async function loadManifest(url, key, field, type, { fetch: fetchFn = fetch } = {}) {
  if (!key) {
    throw new ReleaseError(COMMISSIONING_FIRMWARE.MANIFEST_KEY_NOT_SET);
  }
  const airfrog = await signedManifest(url, key, 'airfrog', fetchFn);
  if (typeof airfrog[field] !== 'string') {
    throw new ReleaseError(RELEASE_LIST.INVALID);
  }
  return signedManifest(airfrog[field], key, type, fetchFn);
}

/**
 * Downloads and verifies the firmware manifest through the Airfrog manifest
 * at url.
 * @returns {Promise<object>} the firmware manifest
 */
export async function loadReleases(url, key, options = {}) {
  return checkFirmwareManifest(await loadManifest(url, key, 'firmware_manifest', 'firmware', options));
}

/**
 * Downloads an Airfrog firmware release's files and checks each file's size
 * and SHA-256.
 * @returns {Promise<Array<{offset: number, url: string, data: Uint8Array}>>}
 *          in address order. onProgress is called with the bytes
 *          downloaded and the total.
 */
export async function loadFirmware(release, flashSize, { fetch: fetchFn = fetch, onProgress = () => {} } = {}) {
  if (release.flash_size !== flashSize) {
    throw new ReleaseError(COMMISSIONING_FIRMWARE.FLASH_SIZE_DIFFERS);
  }
  const files = [...release.files].sort((a, b) => a.offset - b.offset);
  const total = files.reduce((n, f) => n + f.size, 0);
  let done = 0;
  onProgress(done, total);
  const out = [];
  for (const f of files) {
    const data = await get(f.url, fetchFn, COMMISSIONING_FIRMWARE.FIRMWARE);
    if (data.length !== f.size || await sha256Hex(data) !== f.sha256) {
      throw new ReleaseError(COMMISSIONING_FIRMWARE.DOWNLOAD_CORRUPT(COMMISSIONING_FIRMWARE.FIRMWARE));
    }
    out.push({ offset: f.offset, url: f.url, data });
    done += f.size;
    onProgress(done, total);
  }
  return out;
}

/**
 * Imports the release's Airfrog's internal JS setup module, the one its
 * firmware serves, after checking its size and SHA-256.
 * @returns {Promise<object>} the module
 */
export async function loadSetup(release, { fetch: fetchFn = fetch, importFn = (url) => import(url) } = {}) {
  const what = COMMISSIONING_FIRMWARE.RELEASE_VERSION(release.version);
  const data = await get(release.setup.url, fetchFn, what);
  if (data.length !== release.setup.size || await sha256Hex(data) !== release.setup.sha256) {
    throw new ReleaseError(COMMISSIONING_FIRMWARE.DOWNLOAD_CORRUPT(what));
  }
  return importFn(URL.createObjectURL(new Blob([data], { type: 'text/javascript' })));
}
