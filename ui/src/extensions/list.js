// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The extensions manifest (the signed list of the Airfrog Extension
// Repository), extension metadata and extension images.
// airfrog-v2/docs/ac4-design.md section 13 specifies them. ../manifests.js
// checks the extensions manifest's signature, type and version.

import { sha256 } from '../../../js/sha256.js';
import { hex } from '../../../js/setup/bytes.js';
import {
    EXT_IMAGE_MAGIC, EXT_METADATA_MAX, EXT_NAME_MAX, Firmware, decodeExtImage,
} from '../../../js/schema.js';
import { ERRORS, EXTENSIONS, FIRMWARE } from '../../../js/messages.js';
import { compare, isVersion } from './semver.js';

const NAME = new RegExp(`^[a-z0-9](?:[a-z0-9-]{0,${EXT_NAME_MAX - 2}}[a-z0-9])?$`);
const SHA256 = /^[0-9a-f]{64}$/;
const WAMR = /^\d+\.\d+\.\d+$/;
const NO_MODULE = { model: 0, wamr: '0.0.0' };

/** An install failure, with its reason for display. */
export class ExtensionError extends Error {}

/** Whether name is a valid extension name. */
export function isName(name) {
    return typeof name === 'string' && NAME.test(name);
}

const isText = (v) => typeof v === 'string' && v !== '';

/** Whether url's host is 127.0.0.1 or localhost, on http. */
export function isLocal(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
    } catch (e) {
        return false;
    }
}

/**
 * The extension UI's address, or null when it isn't one the Airfrog UI
 * loads: https, or with local http on 127.0.0.1 or localhost (D1a).
 * @param {*} ui - extension metadata's ui
 * @param {boolean} local - whether a local address is allowed: for a
 *        side-loaded extension, or one from a repository on a local address
 * @returns {string|null}
 */
export function uiAddress(ui, local) {
    if (typeof ui !== 'string') {
        return null;
    }
    try {
        const u = new URL(ui);
        return u.protocol === 'https:' || (local && isLocal(ui)) ? u.href : null;
    } catch (e) {
        return null;
    }
}

/**
 * Checks extension metadata.
 * @param {*} m - extension-meta.json, parsed
 * @returns {object|null} m, or null when a field the Airfrog UI uses is
 *          missing or invalid
 */
export function checkMetadata(m) {
    const ok = m && typeof m === 'object' && isName(m.name) && isText(m.display_name) && isVersion(m.version)
        && typeof m.description === 'string' && typeof m.author === 'string'
        && (m.source === undefined || typeof m.source === 'string')
        && Array.isArray(m.firmware) && m.firmware.every(isText)
        && (m.ui === undefined || typeof m.ui === 'string');
    return ok ? m : null;
}

/** Parses extension metadata's bytes, or returns null. */
export function parseMetadata(bytes) {
    if (bytes.length > EXT_METADATA_MAX) {
        return null;
    }
    try {
        return checkMetadata(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch (e) {
        return null;
    }
}

function checkImage(i) {
    return i && Number.isInteger(i.model) && i.model >= 0 && i.model <= 0xffff && typeof i.wamr === 'string'
        && WAMR.test(i.wamr) && typeof i.url === 'string' && /^https?:\/\//.test(i.url)
        && Number.isInteger(i.size) && i.size > 0 && typeof i.sha256 === 'string' && SHA256.test(i.sha256);
}

/**
 * Checks the extensions manifest's entries. An extension or version that
 * breaks its rules is left out.
 * @param {object} manifest - the extensions manifest, signature checked
 * @returns {Map<string, {name: string, depublished: boolean,
 *          versions: Array<{metadata: object, images: Array<object>}>}>}
 *          each extension by name, its versions highest first
 */
export function checkList(manifest) {
    const out = new Map();
    const extensions = manifest?.extensions;
    if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) {
        return out;
    }
    for (const [name, entry] of Object.entries(extensions)) {
        if (!isName(name) || typeof entry?.depublished !== 'boolean' || !Array.isArray(entry.versions)) {
            console.warn(`Extension list: ${name} left out`);
            continue;
        }
        const versions = entry.versions.filter(v => checkMetadata(v?.metadata)?.name === name
            && Array.isArray(v.images) && v.images.length > 0 && v.images.every(checkImage));
        if (versions.length !== entry.versions.length) {
            console.warn(`Extension list: ${entry.versions.length - versions.length} versions of ${name} left out`);
        }
        if (versions.length) {
            versions.sort((a, b) => compare(b.metadata.version, a.metadata.version));
            out.set(name, { name, depublished: entry.depublished, versions });
        }
    }
    return out;
}

/**
 * The extension image for this Airfrog: the one for its model and WAMR
 * version, or the one of an extension without a module.
 * @param {Array<{model: number, wamr: string}>} images
 * @param {number} model - GET_HW_INFO's
 * @param {string} wamr - GET_FW_INFO's, for example 2.4.5
 * @returns {object|null}
 */
export function pickImage(images, model, wamr) {
    return images.find(i => i.model === model && i.wamr === wamr)
        ?? images.find(i => i.model === NO_MODULE.model && i.wamr === NO_MODULE.wamr) ?? null;
}

/**
 * @returns {{metadata: object, image: object}|null} entry's highest version
 *          with an image for this Airfrog
 */
export function latest(entry, model, wamr) {
    for (const v of entry?.versions ?? []) {
        const image = pickImage(v.images, model, wamr);
        if (image) {
            return { metadata: v.metadata, image };
        }
    }
    return null;
}

/** @returns {{metadata: object, image: object}|null} version of entry, with its image for this Airfrog */
export function findVersion(entry, version, model, wamr) {
    const v = entry?.versions.find(x => x.metadata.version === version);
    const image = v && pickImage(v.images, model, wamr);
    return image ? { metadata: v.metadata, image } : null;
}

/** An extension image header's WAMR version, as the extensions manifest writes it. */
export function wamrText(bytes) {
    return Array.from(bytes).join('.');
}

/**
 * Checks an extension image: its header's magic and name, and its model
 * and WAMR version against expected.
 * @param {Uint8Array} bytes
 * @param {{name: string, model: number, wamr: string}} expected
 * @returns {object} the header
 * @throws {ExtensionError} EXTENSION_INVALID's text
 */
export function checkHeader(bytes, expected) {
    const header = decodeExtImage(bytes);
    if (!header || header.magic !== EXT_IMAGE_MAGIC || header.name !== expected.name
        || header.model !== expected.model || wamrText(header.wamr) !== expected.wamr
        || header.metadataOffset + header.metadataLen > bytes.length
        || header.moduleOffset + header.moduleLen > bytes.length) {
        throw new ExtensionError(ERRORS.EXTENSION_INVALID());
    }
    return header;
}

/** The extension metadata an extension image contains, or null. */
export function imageMetadata(bytes, header) {
    return parseMetadata(bytes.subarray(header.metadataOffset, header.metadataOffset + header.metadataLen));
}

/**
 * Checks a downloaded extension image against its entry in the extension
 * list: size and SHA-256, then its header.
 * @param {Uint8Array} bytes
 * @param {string} name
 * @param {{model: number, wamr: string, size: number, sha256: string}} image
 * @throws {ExtensionError}
 */
export function checkDownload(bytes, name, image) {
    if (bytes.length !== image.size || hex(sha256(bytes)) !== image.sha256) {
        throw new ExtensionError(EXTENSIONS.CORRUPT);
    }
    checkHeader(bytes, { name, model: image.model, wamr: image.wamr });
}

/**
 * Where an extension's metadata firmware list puts it, for Install extensions'
 * checkboxes.
 * @param {Array<string>} firmware - extension metadata's firmware
 * @param {number} found - TARGET's firmware ID of the firmware Airfrog found,
 *        0 for none
 * @returns {'any'|'this'|'other'}
 */
export function targetGroup(firmware, found) {
    if (!firmware.length) {
        return 'any';
    }
    return firmware.some(f => Firmware[f] !== undefined && Firmware[f] === found) ? 'this' : 'other';
}

/** A firmware name from extension metadata, as the Airfrog UI displays it. */
export function firmwareText(name) {
    return FIRMWARE[Firmware[name]]?.name ?? name;
}
