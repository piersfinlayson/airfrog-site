// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The firmware manifest: each released model's Airfrog firmware's releases
// in version order, highest first, and its latest release.
// airfrog-v2/docs/ac3-design.md specifies it.

import { UPDATE } from '../messages.js';
import { MODELS } from '../schema.js';

const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT = /^[0-9a-f]{4,40}$/;
const SECTOR = 4096;
const MODEL_KEYS = Object.values(MODELS).map(v => v.key).filter(k => k);

/** Whether version a is lower than b, each MAJOR.MINOR.PATCH. */
function lower(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    const i = pa.findIndex((n, j) => n !== pb[j]);
    return i >= 0 && pa[i] < pb[i];
}

export class ReleaseError extends Error {}

const INVALID = UPDATE.INVALID_RELEASE_LIST;

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function isFile(f) {
    return typeof f?.url === 'string' && /^https?:\/\//.test(f.url) && Number.isInteger(f.size) && f.size > 0
        && typeof f.sha256 === 'string' && SHA256.test(f.sha256);
}

/** model's key in the firmware manifest, for example airfrog-mini for mini. */
function firmwareKey(model) {
    return `airfrog-${model}`;
}

function checkRelease(v) {
    if (typeof v?.version !== 'string' || !VERSION.test(v.version) || typeof v.commit !== 'string'
        || !COMMIT.test(v.commit) || (v.notes !== undefined && !/^https:\/\//.test(v.notes)) || !isFile(v.setup)
        || !Number.isInteger(v.flash_size) || !isFile(v.image) || !Array.isArray(v.files) || !v.files.length) {
        throw new ReleaseError(INVALID);
    }
    const files = [...v.files].sort((a, b) => a.offset - b.offset);
    files.forEach((f, i) => {
        if (!isFile(f) || !Number.isInteger(f.offset) || f.offset < 0 || f.offset % SECTOR !== 0
            || f.offset + f.size > v.flash_size || (i + 1 < files.length && f.offset + f.size > files[i + 1].offset)) {
            throw new ReleaseError(INVALID);
        }
    });
    // The update image is the factory files' app, at its own URL.
    if (!files.some(f => f.size === v.image.size && f.sha256 === v.image.sha256)) {
        throw new ReleaseError(INVALID);
    }
}

/**
 * Checks a parsed firmware manifest.
 * @returns {object} manifest
 * @throws {ReleaseError} when it isn't a valid firmware manifest
 */
export function checkFirmwareManifest(manifest) {
    if (manifest?.type !== 'firmware' || !isObject(manifest.firmware) || !isObject(manifest.latest)) {
        throw new ReleaseError(INVALID);
    }
    for (const key of MODEL_KEYS) {
        const releases = manifest.firmware[firmwareKey(key)];
        if (releases === undefined) {
            continue;
        }
        if (!Array.isArray(releases) || !releases.length) {
            throw new ReleaseError(INVALID);
        }
        let previous = null;
        for (const r of releases) {
            checkRelease(r);
            if (previous && !lower(r.version, previous)) {
                throw new ReleaseError(INVALID);
            }
            previous = r.version;
        }
    }
    for (const key of MODEL_KEYS) {
        const version = manifest.latest[firmwareKey(key)];
        if (version !== undefined && !modelReleases(manifest, key).some(r => r.version === version)) {
            throw new ReleaseError(INVALID);
        }
    }
    return manifest;
}

/**
 * @param {string} model - a released model's key, for example mini
 * @returns {object[]} the releases of model's Airfrog firmware, highest
 *          first
 */
export function modelReleases(manifest, model) {
    return manifest?.firmware?.[firmwareKey(model)] ?? [];
}

/** @returns {object[]} the releases of every released model's Airfrog firmware */
export function airfrogReleases(manifest) {
    return MODEL_KEYS.flatMap(k => modelReleases(manifest, k));
}

/** @returns {object|null} the latest release of model's Airfrog firmware, or null when it doesn't have one */
export function latestRelease(manifest, model) {
    const version = manifest?.latest?.[firmwareKey(model)];
    return modelReleases(manifest, model).find(r => r.version === version) ?? null;
}

/** @returns {object|null} release version of model's Airfrog firmware, version without a leading v */
export function findRelease(manifest, model, version) {
    const plain = version.replace(/^v/, '');
    return modelReleases(manifest, model).find(r => r.version === plain) ?? null;
}
