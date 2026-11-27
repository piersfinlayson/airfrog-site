// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The manifests Airfrog's full user interface reads: the Airfrog
// manifest, the firmware manifest and the extensions manifest. The Airfrog
// manifest is signed with one of the full user interface's own release keys.
// Another manifest with a key in the Airfrog manifest is signed with that
// key, and one without is read only from an https address. The page is on
// http, where crypto.subtle isn't available, so Ed25519 and SHA-512 are
// noble-ed25519's and noble-hashes'.

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { AIRFROG_MANIFEST, RELEASE_KEYS } from '../../commissioning/release-keys.js';
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
const KEY = /^[0-9a-f]{64}$/;
const MANIFESTS = ['ui_manifest', 'firmware_manifest', 'support_firmware_manifest', 'cli_manifest',
    'extensions_manifest'];

/** Whether v is a manifest's entry in the Airfrog manifest: its url and an optional key. */
const isEntry = (v) => typeof v === 'object' && v !== null && isText(v.url) && (v.key === undefined || KEY.test(v.key));

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
 * Whether minisig, a minisign signature file, is the legacy Ed25519
 * signature of body by one of keys, selected by its key ID. The signature
 * is the file's second line.
 */
function signedBy(minisig, body, keys) {
    let signature;
    try {
        const line = new TextDecoder().decode(minisig).split('\n')[1];
        signature = Uint8Array.from(atob(line.trim()), (c) => c.charCodeAt(0));
    } catch (e) {
        return false;
    }
    const id = Array.from(signature.subarray(2, 10), (b) => b.toString(16).padStart(2, '0')).join('');
    const key = keys.find((k) => k.startsWith(id));
    try {
        return signature.length === 74 && signature[0] === 0x45 && signature[1] === 0x64 && Boolean(key)
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
        return MANIFESTS.every((name) => isEntry(m[name])) && isText(m.js_library) && m.js_library.endsWith('/')
            && Array.isArray(m.full_access_websites) && m.full_access_websites.every(isText);
    }
    if (type === 'extensions') {
        return typeof m.extensions === 'object' && m.extensions !== null && !Array.isArray(m.extensions);
    }
    return true;
}

export class Manifests {
    /** The extensions manifest's address, from the Airfrog manifest once it loads, or null. */
    extensionsUrl = null;
    /** The Airfrog manifest's full_access_websites, empty until it loads. */
    fullAccessWebsites = [];
    #airfrog = null;
    #firmware = null;
    #extensions = null;

    /**
     * @param {object} [options]
     * @param {string} [options.url] - the Airfrog manifest's address
     * @param {Array<string>} [options.keys] - the release keys in hex
     */
    constructor({ url = AIRFROG_MANIFEST, keys = RELEASE_KEYS } = {}) {
        this.url = url;
        this.keys = keys;
    }

    /** The Airfrog manifest, loaded once, and again after a failure. */
    airfrog() {
        this.#airfrog ??= this.#manifestAt({ url: this.url }, 'airfrog', this.keys).then((m) => {
            this.extensionsUrl = m.extensions_manifest.url;
            this.fullAccessWebsites = m.full_access_websites;
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
                const entry = (await this.airfrog()).extensions_manifest;
                return { url: entry.url, manifest: await this.#manifestAt(entry, 'extensions') };
            } finally {
                this.#extensions = null;
            }
        })();
        return this.#extensions;
    }

    /**
     * Fetches the manifest of type at entry.url. With keys, or entry.key,
     * its signature file url.minisig is fetched too and verified. Without
     * either, url must be https.
     * @param {{url: string, key?: string}} entry
     * @param {string} type
     * @param {Array<string>} [keys] - the keys that may sign it
     */
    async #manifestAt({ url, key }, type, keys = key ? [key] : []) {
        if (type === 'airfrog' && !keys.length) {
            throw new ManifestError(COMMISSIONING_FIRMWARE.RELEASE_KEYS_NOT_SET);
        }
        const words = type === 'firmware' ? FIRMWARE_WORDS : MANIFEST_WORDS;
        if (!keys.length && !url.startsWith('https://')) {
            throw new ManifestError(words.invalid, `${url} has no key and isn't https`);
        }
        const fresh = `?t=${Date.now()}`;
        const [body, minisig] = await Promise.all([fetched(url + fresh),
            keys.length ? fetched(`${url}.minisig${fresh}`) : null]);
        if (keys.length && !signedBy(minisig, body, keys)) {
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
