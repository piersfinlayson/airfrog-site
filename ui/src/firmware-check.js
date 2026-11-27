// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The Airfrog UI works with an Airfrog only if its firmware has the UI's
// Airfrog manifest address and at least one of its release keys. Checked on
// every connection before logging in.

import { AIRFROG_MANIFEST, RELEASE_KEYS } from '../../commissioning/release-keys.js';
import { AirfrogError } from '../../js/awp.js';
import { hex } from '../../js/setup/bytes.js';
import { CONNECTION } from '../../js/messages.js';

/**
 * @param {import('../../js/awp.js').Hello} hello
 * @param {{manifest?: string, keys?: Array<string>}} [own] - the Airfrog
 *        UI's manifest address and release keys in hex, release-keys.js's
 *        by default
 * @returns {AirfrogError|null} OTHER_FIRMWARE when the firmware's differ
 */
export function checkHello(hello, { manifest = AIRFROG_MANIFEST, keys = RELEASE_KEYS } = {}) {
    const theirs = hello.releaseKeys().map(hex);
    if (hello.manifestUrl === manifest && theirs.some(k => keys.includes(k))) {
        return null;
    }
    return new AirfrogError('OTHER_FIRMWARE', `${hello.manifestUrl} ${theirs.join(',')}`, CONNECTION.OTHER_FIRMWARE);
}
