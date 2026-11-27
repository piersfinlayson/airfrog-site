// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Airfrog's firmware update: OTA_BEGIN, OTA_WRITE, OTA_FINISH, then
// OTA_CONFIRM once Airfrog has restarted into the new firmware: when
// GET_FW_INFO's SHA-256 of the running image is the SHA-256 OTA_BEGIN sent.

import { sha256 } from '../sha256.js';
import { readSignedFile } from '../signed.js';
import { hex, view } from './bytes.js';
import { download } from './download.js';
import { Command, EMPTY, encodeOtaBegin, encodeOtaWrite, parseFwInfo } from './protocol.js';
import { MODELS, versionText } from './format.js';
import { checkFirmwareManifest, latestRelease } from './releases.js';
import { UPDATE } from '../messages.js';
import { CLOSE_GOING_AWAY, IMAGE_MODEL_OFFSET, PROJECT } from '../schema.js';

/** The limit on each OTA request but OTA_FINISH. */
const CMD_MS = 10000;
/** The limit on OTA_FINISH, which checks the image. */
const FINISH_MS = 30000;
/** How long the page waits for Airfrog to restart and reconnect. */
const RESTART_MS = 90000;

const ESP_IMAGE_MAGIC = 0xE9;
const APP_DESC_MAGIC = 0xABCD5432;
/** esp_app_desc_t's project_name, after the image and segment headers. */
const PROJECT_OFFSET = 80;

/** A NUL-terminated text field of an image. */
function cText(data, start, end) {
    const v = data.subarray(start, end);
    const nul = v.indexOf(0);
    return new TextDecoder().decode(nul < 0 ? v : v.subarray(0, nul));
}

/**
 * @param {Uint8Array} data
 * @returns {string|null} the version in an ESP-IDF image's app description,
 *          or null when data isn't an ESP-IDF app image
 */
export function imageVersion(data) {
    if (data.length < 80 || data[0] !== ESP_IMAGE_MAGIC || view(data).getUint32(32, true) !== APP_DESC_MAGIC) {
        return null;
    }
    return cText(data, 48, 80);
}

/**
 * Checks a chosen firmware file: an ESP-IDF app image whose project is
 * Airfrog, for the model the image contains.
 * @param {Uint8Array} data
 * @param {number} model - GET_HW_INFO's model
 * @returns {{version: string|null, error: string|null}} the image's version,
 *          or the reason it can't be installed: UPDATE.INVALID_FILE when it
 *          isn't Airfrog firmware, or UPDATE.WRONG_MODEL when its model
 *          isn't model
 */
export function checkFirmwareFile(data, model) {
    const version = imageVersion(data);
    if (version === null || data.length < IMAGE_MODEL_OFFSET + 2
        || cText(data, PROJECT_OFFSET, PROJECT_OFFSET + 32) !== PROJECT) {
        return { version: null, error: UPDATE.INVALID_FILE };
    }
    if (view(data).getUint16(IMAGE_MODEL_OFFSET, true) !== model) {
        return { version: null, error: UPDATE.WRONG_MODEL };
    }
    return { version, error: null };
}

/** A version without a leading v, as GET_FW_INFO reports it. */
function plainVersion(version) {
    return version.replace(/^v/, '');
}

const VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Whether firmware version is older than the running firmware's, by
 * Airfrog's comparison: a version that isn't MAJOR.MINOR.PATCH is older, and a
 * running version that isn't is the oldest.
 * @param {string|null} version - the image's
 * @param {string} running - GET_FW_INFO's
 */
export function isOlder(version, running) {
    if (!VERSION.test(version ?? '')) {
        return true;
    }
    return VERSION.test(running) && compareVersions(version, running) < 0;
}

/** Compares versions MAJOR.MINOR.PATCH, with or without a leading v. */
export function compareVersions(a, b) {
    const pa = plainVersion(a).split('.').map(Number);
    const pb = plainVersion(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) {
            return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
        }
    }
    return 0;
}

/**
 * The firmware manifest's latest release for this Airfrog, compared with the
 * version running.
 * @param {object} firmware - the verified firmware manifest
 * @param {number} model - GET_HW_INFO's model
 * @param {string} running - GET_FW_INFO's version
 * @returns {{latest: boolean, offer: {version: string, commit: string, notes: string|null,
 *           url: string, size: number, sha256: string}|null}|null} null
 *          when the firmware manifest doesn't have a latest release for this
 *          Airfrog. latest when it is the version running, and offer when it
 *          is newer
 * @throws {ReleaseError} when the firmware manifest isn't valid
 */
export function firmwareRelease(firmware, model, running) {
    if (!firmware) {
        return null;
    }
    checkFirmwareManifest(firmware);
    const key = MODELS[model]?.key;
    const release = key ? latestRelease(firmware, key) : null;
    if (!release) {
        return null;
    }
    const image = release.image;
    const order = compareVersions(release.version, running);
    const offer = order > 0 ? { version: release.version, commit: release.commit, notes: release.notes ?? null,
        url: image.url, size: image.size, sha256: image.sha256 } : null;
    return { latest: order === 0, offer };
}

class UpdateError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UpdateError';
    }
}

/**
 * Downloads a release's firmware, a signed file, and checks its size and
 * SHA-256.
 * @param {{version: string, url: string, size: number, sha256: string}} offer
 * @param {object} [options] - download()'s
 * @returns {Promise<{image: Uint8Array, signature: Uint8Array|null}>}
 */
export async function downloadFirmware(offer, options = {}) {
    const failed = (reason) =>
        new UpdateError(UPDATE.DOWNLOAD_FAILED(versionText(offer.version, offer.commit), reason));
    let data;
    try {
        data = await download(offer.url, options);
    } catch (e) {
        if (e.timedOut) {
            throw failed(UPDATE.TIMED_OUT);
        }
        throw failed(e.status === null ? e.message : UPDATE.HTTP_STATUS(e.status));
    }
    const file = data.length === offer.size && hex(sha256(data)) === offer.sha256
        ? readSignedFile(data, 'firmware') : null;
    if (!file) {
        throw failed(UPDATE.CORRUPT);
    }
    return file;
}

/**
 * Writes image to Airfrog, restarts Airfrog into it and confirms it.
 * @param {object} options
 * @param {import('./session.js').Session} options.session
 * @param {Uint8Array} options.image
 * @param {Uint8Array|null} options.signature - the image's signature, null
 *        for an unsigned image
 * @param {string} options.version - the image's version
 * @param {string} [options.commit] - the image's commit, when known
 * @param {{version: string, commit: string}} options.previous - the
 *        firmware running before the update, GET_FW_INFO's
 * @param {function(string)} [options.onPhase] - what the update is doing
 * @param {function(number)} [options.onProgress] - 0 to 1 while writing
 * @param {number} [options.restartMs] - the wait for Airfrog to reconnect
 * @returns {Promise<{running: string, commit: string, wanted: string, wantedCommit: string, booted: boolean}>}
 *          the version and commit Airfrog runs after the update, the
 *          version and commit written, and whether Airfrog runs the image
 *          written. OTA_CONFIRM is sent only when it does
 */
export async function runUpdate({ session, image, signature, version, commit = '', previous, onPhase = () => {},
    onProgress = () => {}, restartMs = RESTART_MS }) {
    const airfrog = session.airfrog;
    if (!airfrog) {
        throw new UpdateError(UPDATE.NOT_CONNECTED);
    }
    const max = airfrog.getMaxTransfer();
    const named = versionText(version, commit);
    const sum = sha256(image);
    onProgress(0);
    onPhase(UPDATE.UPDATING(named));
    await airfrog.airfrogCmd(Command.OTA_BEGIN, encodeOtaBegin(image.length, sum, signature), CMD_MS);
    for (let offset = 0; offset < image.length; offset += max) {
        await airfrog.airfrogCmd(Command.OTA_WRITE, encodeOtaWrite(offset, image.subarray(offset, offset + max)), CMD_MS);
        onProgress(Math.min(1, (offset + max) / image.length));
    }

    onPhase(UPDATE.VERIFYING);
    const next = session.nextConnection(restartMs);
    // The reconnect isn't checked against the Airfrog UI's manifest address
    // and release keys, so firmware with others is confirmed rather than
    // reverted. It is closed once it has confirmed.
    session.expectClose({ message: UPDATE.RESTARTING(named), confirm: true });
    try {
        await airfrog.airfrogCmd(Command.OTA_FINISH, EMPTY, FINISH_MS);
    } catch (e) {
        // Airfrog closes the connection as it restarts. Another failure
        // isn't followed by a reconnect to confirm, so the next connection
        // is checked.
        if (!(e.code === 'CLOSED' && e.detail === CLOSE_GOING_AWAY)) {
            session.cancelExpected();
            session.endConfirming();
            throw e;
        }
    }

    try {
        // The connection's status displays the restart.
        onPhase('');
        const after = await next;
        if (!after) {
            throw new UpdateError(UPDATE.NO_RESPONSE(versionText(previous.version, previous.commit)));
        }
        const fw = parseFwInfo(await after.airfrogCmd(Command.GET_FW_INFO, EMPTY, CMD_MS));
        // Otherwise the new image didn't boot and the previous one runs.
        const booted = fw.sha256 === hex(sum);
        if (booted) {
            await after.airfrogCmd(Command.OTA_CONFIRM, EMPTY, CMD_MS);
        }
        return { running: fw.version, commit: fw.commit, wanted: plainVersion(version), wantedCommit: commit, booted };
    } finally {
        session.endConfirming();
    }
}

/** @returns {{text: string, ok: boolean}} the update's result for display */
export function describeResult({ running, commit = '', wanted, wantedCommit = '', booted }) {
    if (booted) {
        return { text: UPDATE.UPDATED(versionText(running, commit)), ok: true };
    }
    return { text: UPDATE.REVERTED(versionText(wanted, wantedCommit), versionText(running, commit)), ok: false };
}

/** Where an update's result waits while the page reloads. */
const RESULT_KEY = 'airfrog-update-result';

/**
 * Keeps an update's result for the page that loads after the update, so
 * that page is the new firmware's home page.
 * @returns {boolean} whether it was kept
 */
export function keepResult(result, storage = globalThis.sessionStorage) {
    try {
        storage.setItem(RESULT_KEY, JSON.stringify(result));
        return true;
    } catch (e) {
        return false;
    }
}

/** @returns {object|null} the result keepResult() kept, removing it */
export function takeResult(storage = globalThis.sessionStorage) {
    try {
        const kept = storage.getItem(RESULT_KEY);
        storage.removeItem(RESULT_KEY);
        return kept ? JSON.parse(kept) : null;
    } catch (e) {
        return null;
    }
}
