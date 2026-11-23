// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The signed manifests Airfrog's full user interface reads: the Airfrog
// manifest, the firmware manifest and the extensions manifest
// (airfrog-v2/docs/ac3-design.md, "Manifests"). Each is verified as Airfrog's
// home page verifies it, with the full user interface's own copy of the
// manifest key. The page is on http, where crypto.subtle isn't available, so
// Ed25519 and SHA-512 are noble-ed25519's and noble-hashes'.

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { AIRFROG_MANIFEST, MANIFEST_KEY } from '../../commissioning/manifest-key.js';
import { COMMISSIONING_FIRMWARE, HOME_PAGE } from '../../js/messages.js';
import { download } from '../../js/setup/download.js';
import { downloadText } from './download.js';

ed.hashes.sha512 = sha512;

const FIRMWARE_WORDS = {
    signature: HOME_PAGE.RELEASE_LIST_SIGNATURE,
    invalid: HOME_PAGE.RELEASE_LIST_INVALID,
};
const MANIFEST_WORDS = {
    signature: HOME_PAGE.MANIFEST_SIGNATURE,
    invalid: HOME_PAGE.MANIFEST_INVALID,
};

/** A manifest that didn't load. The message is for users and detail goes to the console. */
export class ManifestError extends Error {
    constructor(message, detail = null) {
        super(message);
        if (detail) {
            console.warn(`Airfrog's full user interface: ${detail}`);
        }
    }
}

const isText = (v) => typeof v === 'string' && v !== '';

function fromHex(s) {
    return new Uint8Array(s.match(/../g).map((b) => parseInt(b, 16)));
}

async function fetched(url) {
    try {
        return await download(url, { cache: 'no-store' });
    } catch (e) {
        throw new ManifestError(downloadText(e), `${url}: ${e.message}`);
    }
}

/**
 * Whether minisig, a minisign signature file, is key's legacy Ed25519
 * signature of body. The signature is the file's second line.
 */
function signedBy(minisig, body, key) {
    let signature;
    try {
        const line = new TextDecoder().decode(minisig).split('\n')[1];
        signature = Uint8Array.from(atob(line.trim()), (c) => c.charCodeAt(0));
    } catch (e) {
        return false;
    }
    try {
        return signature.length === 74 && signature[0] === 0x45 && signature[1] === 0x64
            && ed.verify(signature.subarray(10), body, fromHex(key));
    } catch (e) {
        return false;
    }
}

/**
 * Whether every field of an Airfrog or extensions manifest is present.
 * Airfrog's internal JS setup module checks the firmware manifest's
 * releases, and extensions/list.js each extension in the extensions manifest.
 */
function complete(m, type) {
    if (!Number.isInteger(m.version)) {
        return false;
    }
    if (type === 'airfrog') {
        return isText(m.ui_manifest) && isText(m.firmware_manifest) && isText(m.support_firmware_manifest)
            && isText(m.cli_manifest) && isText(m.extensions_manifest) && isText(m.js_library)
            && m.js_library.endsWith('/');
    }
    if (type === 'extensions') {
        return typeof m.extensions === 'object' && m.extensions !== null && !Array.isArray(m.extensions);
    }
    return true;
}

export class Manifests {
    /** The extensions manifest's address, from the Airfrog manifest once it loads, or null. */
    extensionsUrl = null;
    #airfrog = null;
    #firmware = null;
    #extensions = null;

    /**
     * @param {object} [options]
     * @param {string} [options.url] - the Airfrog manifest's address
     * @param {string} [options.key] - the manifest key's public half in hex
     */
    constructor({ url = AIRFROG_MANIFEST, key = MANIFEST_KEY } = {}) {
        this.url = url;
        this.key = key;
    }

    /** The Airfrog manifest, loaded once, and again after a failure. */
    airfrog() {
        this.#airfrog ??= this.#manifestAt(this.url, 'airfrog').then((m) => {
            this.extensionsUrl = m.extensions_manifest;
            return m;
        }).catch((e) => {
            this.#airfrog = null;
            throw e;
        });
        return this.#airfrog;
    }

    /** The firmware manifest, loaded once, and again after a failure. */
    firmware() {
        this.#firmware ??= this.airfrog().then((a) => this.#manifestAt(a.firmware_manifest, 'firmware')).catch((e) => {
            this.#firmware = null;
            throw e;
        });
        return this.#firmware;
    }

    /**
     * The extensions manifest, loaded on each call. A call while one loads
     * receives that load's result.
     * @returns {Promise<{url: string, manifest: object}>}
     */
    extensions() {
        this.#extensions ??= (async () => {
            try {
                const url = (await this.airfrog()).extensions_manifest;
                return { url, manifest: await this.#manifestAt(url, 'extensions') };
            } finally {
                this.#extensions = null;
            }
        })();
        return this.#extensions;
    }

    /** Fetches the manifest of type at url and its signature file, url.minisig, and verifies them. */
    async #manifestAt(url, type) {
        if (!this.key) {
            throw new ManifestError(COMMISSIONING_FIRMWARE.MANIFEST_KEY_NOT_SET);
        }
        const words = type === 'firmware' ? FIRMWARE_WORDS : MANIFEST_WORDS;
        const fresh = `?t=${Date.now()}`;
        const [body, minisig] = await Promise.all([fetched(url + fresh), fetched(`${url}.minisig${fresh}`)]);
        if (!signedBy(minisig, body, this.key)) {
            throw new ManifestError(words.signature, url);
        }
        let manifest;
        try {
            manifest = JSON.parse(new TextDecoder().decode(body));
        } catch (e) {
            throw new ManifestError(words.invalid, `${url}: ${e.message}`);
        }
        if (manifest?.type !== type) {
            throw new ManifestError(words.invalid, `${url} isn't a ${type} manifest`);
        }
        if (!complete(manifest, type)) {
            throw new ManifestError(words.invalid, `${url} is missing a field`);
        }
        return manifest;
    }
}
