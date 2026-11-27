// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The full user interface's manifests: the signature, type and fields checks,
// the release keys and each manifest's own key, the manifests without a key,
// the empty release keys, the download failures, and when each manifest is
// fetched.
// Run with tests/ui/hooks.mjs, after ci/build-ui.sh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { BACKUP_KEY, OTHER_KEY as UNTRUSTED, TEST_KEY, minisig } from './minisign.mjs';

console.warn = () => {};

const { Manifests } = await import('../../ui/src/manifests.js');
const { COMMISSIONING_FIRMWARE, HOME_PAGE } = await import('../../js/messages.js');
const { DOWNLOAD_TIMEOUT_MS } = await import('../../js/schema.js');

const AIRFROG = 'https://meta.test/manifest.json';
const FIRMWARE = 'https://images.test/firmware/manifest.json';
const EXTENSIONS = 'https://extensions.test/manifest.json';
const KEYS = [TEST_KEY, BACKUP_KEY];

/**
 * Serves manifests by address, each with its signature file, and records each
 * fetch. signatures maps an address to a function that makes its signature
 * file from the manifest's bytes in place of minisig().
 */
function serve(manifests, signatures = {}) {
    const fetched = [];
    globalThis.fetch = async (url, options) => {
        fetched.push({ url, options });
        const address = url.split('?')[0];
        const at = address.replace(/\.minisig$/, '');
        const m = manifests[at];
        if (!m) {
            return new Response('', { status: 404 });
        }
        const body = Buffer.from(JSON.stringify(m));
        return new Response(address.endsWith('.minisig') ? (signatures[at] ?? minisig)(body) : body);
    };
    return fetched;
}

/** A signature file whose signature line's bytes edit() changes. */
const edited = (edit) => (body) => {
    const lines = minisig(body).split('\n');
    lines[1] = edit(Buffer.from(lines[1], 'base64'), body).toString('base64');
    return lines.join('\n');
};
const OTHER_KEY = crypto.generateKeyPairSync('ed25519').privateKey;
const BAD_SIGNATURES = {
    'of other bytes': () => minisig(Buffer.from('x')),
    'with algorithm ED': edited((b) => Buffer.concat([Buffer.from('ED'), b.subarray(2)])),
    'a byte short': edited((b) => b.subarray(0, 73)),
    'a byte over': edited((b) => Buffer.concat([b, Buffer.from([0])])),
    'by another key': edited((b, body) => Buffer.concat([b.subarray(0, 10), crypto.sign(null, body, OTHER_KEY)])),
    'on the third line': (body) => minisig(body).replace('\n', '\n\n'),
};

const entry = (url) => ({ url, key: TEST_KEY });
const airfrog = (fields = {}) => ({ type: 'airfrog', version: 1, ui_manifest: entry('https://images.test/ui/manifest.json'),
    firmware_manifest: entry(FIRMWARE), support_firmware_manifest: entry('https://images.test/support-firmware/manifest.json'),
    cli_manifest: entry('https://images.test/cli/manifest.json'), extensions_manifest: entry(EXTENSIONS),
    js_library: 'https://images.test/js/', full_access_websites: ['https://airfrog.org'], ...fields });
const firmware = { type: 'firmware', version: 1, latest: {}, firmware: {} };
const extensions = { type: 'extensions', version: 1, extensions: {} };

test('the firmware manifest through the Airfrog manifest', async () => {
    const fetched = serve({ [AIRFROG]: airfrog(), [FIRMWARE]: firmware });
    const manifests = new Manifests({ url: AIRFROG, keys: KEYS });
    assert.deepEqual(await manifests.firmware(), firmware);
    assert.equal(manifests.extensionsUrl, EXTENSIONS);
    assert.deepEqual(manifests.fullAccessWebsites, ['https://airfrog.org']);
    assert.deepEqual(fetched.map(f => f.url.split('?')[0]),
        [AIRFROG, `${AIRFROG}.minisig`, FIRMWARE, `${FIRMWARE}.minisig`]);
    assert.ok(fetched.every(f => /\?t=\d+$/.test(f.url) && f.options.cache === 'no-store'));
    await manifests.firmware();
    assert.equal(fetched.length, 4, 'loaded once');
});

test("a manifest that doesn't verify", async () => {
    const fails = async (manifests, signatures, message, what) => {
        serve(manifests, signatures);
        await assert.rejects(new Manifests({ url: AIRFROG, keys: KEYS }).firmware(), { message }, what);
    };
    for (const [what, signature] of Object.entries(BAD_SIGNATURES)) {
        await fails({ [AIRFROG]: airfrog(), [FIRMWARE]: firmware }, { [AIRFROG]: signature },
            HOME_PAGE.MANIFEST_SIGNATURE, what);
        await fails({ [AIRFROG]: airfrog(), [FIRMWARE]: firmware }, { [FIRMWARE]: signature },
            HOME_PAGE.RELEASE_LIST_SIGNATURE, what);
    }
    await fails({ [AIRFROG]: airfrog({ type: 'ui' }), [FIRMWARE]: firmware }, {}, HOME_PAGE.MANIFEST_INVALID);
    for (const field of ['ui_manifest', 'firmware_manifest', 'support_firmware_manifest', 'cli_manifest',
        'extensions_manifest', 'js_library', 'full_access_websites']) {
        await fails({ [AIRFROG]: airfrog({ [field]: undefined }), [FIRMWARE]: firmware }, {},
            HOME_PAGE.MANIFEST_INVALID);
    }
    for (const fields of [{ js_library: 'https://images.test/js' }, { firmware_manifest: FIRMWARE },
        { firmware_manifest: { url: FIRMWARE, key: 'ab' } }, { firmware_manifest: { key: TEST_KEY } },
        { full_access_websites: 'https://airfrog.org' }, { full_access_websites: [1] }]) {
        await fails({ [AIRFROG]: airfrog(fields), [FIRMWARE]: firmware }, {}, HOME_PAGE.MANIFEST_INVALID,
            JSON.stringify(fields));
    }
    await fails({ [AIRFROG]: airfrog(), [FIRMWARE]: { ...firmware, type: 'extensions' } }, {},
        HOME_PAGE.RELEASE_LIST_INVALID);
    await fails({ [AIRFROG]: airfrog() }, {}, HOME_PAGE.DOWNLOAD_HTTP(404));
});

test('the Airfrog manifest is signed with either release key, selected by key ID', async () => {
    const m = { [AIRFROG]: airfrog(), [FIRMWARE]: firmware };
    serve(m, { [AIRFROG]: (body) => minisig(body, 'backup') });
    assert.deepEqual(await new Manifests({ url: AIRFROG, keys: KEYS }).firmware(), firmware, 'the backup key');
    serve(m, { [AIRFROG]: (body) => minisig(body, 'other') });
    await assert.rejects(new Manifests({ url: AIRFROG, keys: KEYS }).firmware(), { message: HOME_PAGE.MANIFEST_SIGNATURE },
        'a key that isn\'t a release key');
    serve(m, { [AIRFROG]: (body) => minisig(body, 'backup') });
    await assert.rejects(new Manifests({ url: AIRFROG, keys: [TEST_KEY] }).firmware(),
        { message: HOME_PAGE.MANIFEST_SIGNATURE }, 'the backup key when only the release key is built in');
});

test("a manifest with a key is signed with that key, and one without is read from https", async () => {
    const other = { firmware_manifest: { url: FIRMWARE, key: UNTRUSTED } };
    serve({ [AIRFROG]: airfrog(other), [FIRMWARE]: firmware }, { [FIRMWARE]: (body) => minisig(body, 'other') });
    assert.deepEqual(await new Manifests({ url: AIRFROG, keys: KEYS }).firmware(), firmware, 'its own key');
    serve({ [AIRFROG]: airfrog(other), [FIRMWARE]: firmware });
    await assert.rejects(new Manifests({ url: AIRFROG, keys: KEYS }).firmware(),
        { message: HOME_PAGE.RELEASE_LIST_SIGNATURE }, 'a release key in place of its own key');
    const fetched = serve({ [AIRFROG]: airfrog({ firmware_manifest: { url: FIRMWARE } }), [FIRMWARE]: firmware },
        { [FIRMWARE]: () => 'not a signature' });
    assert.deepEqual(await new Manifests({ url: AIRFROG, keys: KEYS }).firmware(), firmware, 'without a key');
    assert.ok(!fetched.some(f => f.url.startsWith(`${FIRMWARE}.minisig`)), 'without a key no signature is read');
    const http = 'http://images.test/firmware/manifest.json';
    serve({ [AIRFROG]: airfrog({ firmware_manifest: { url: http } }), [http]: firmware });
    await assert.rejects(new Manifests({ url: AIRFROG, keys: KEYS }).firmware(),
        { message: HOME_PAGE.RELEASE_LIST_INVALID }, 'without a key over http');
    serve({ [AIRFROG]: airfrog({ firmware_manifest: { url: http, key: TEST_KEY } }), [http]: firmware });
    assert.deepEqual(await new Manifests({ url: AIRFROG, keys: KEYS }).firmware(), firmware, 'with a key over http');
});

test("a manifest that doesn't download", async (t) => {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(new Manifests({ url: AIRFROG, keys: KEYS }).airfrog(),
        { message: HOME_PAGE.DOWNLOAD_FAILED });

    // A server that doesn't answer, and one that stops part way.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const hang = (signal) => new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)));
    const answers = {
        "doesn't answer": (signal) => hang(signal),
        'stops part way': (signal) => Promise.resolve(new Response(new ReadableStream({
            start(c) {
                c.enqueue(new Uint8Array([0x7b]));
                signal.addEventListener('abort', () => c.error(signal.reason));
            },
        }))),
    };
    for (const [what, answer] of Object.entries(answers)) {
        globalThis.fetch = (url, { signal }) => answer(signal);
        const loaded = assert.rejects(new Manifests({ url: AIRFROG, keys: KEYS }).airfrog(),
            { message: HOME_PAGE.DOWNLOAD_TIMED_OUT }, what);
        await new Promise(setImmediate);
        t.mock.timers.tick(DOWNLOAD_TIMEOUT_MS);
        await loaded;
    }
});

test('a failed load is tried again', async () => {
    serve({ [AIRFROG]: airfrog() });
    const manifests = new Manifests({ url: AIRFROG, keys: KEYS });
    await assert.rejects(manifests.firmware());
    serve({ [AIRFROG]: airfrog(), [FIRMWARE]: firmware });
    assert.deepEqual(await manifests.firmware(), firmware);
});

test('without release keys each load fails', async () => {
    const fetched = serve({ [AIRFROG]: airfrog(), [FIRMWARE]: firmware, [EXTENSIONS]: extensions });
    const manifests = new Manifests({ url: AIRFROG, keys: [] });
    const message = COMMISSIONING_FIRMWARE.RELEASE_KEYS_NOT_SET;
    await assert.rejects(manifests.firmware(), { message });
    await assert.rejects(manifests.extensions(), { message });
    assert.equal(fetched.length, 0);
});

test('the extensions manifest, fetched on each call', async () => {
    const fetched = serve({ [AIRFROG]: airfrog(), [EXTENSIONS]: extensions });
    const manifests = new Manifests({ url: AIRFROG, keys: KEYS });
    const [a, b] = await Promise.all([manifests.extensions(), manifests.extensions()]);
    assert.deepEqual(a, { url: EXTENSIONS, manifest: extensions });
    assert.equal(a, b, 'a call while one loads receives its result');
    await manifests.extensions();
    const lists = fetched.filter(f => f.url.startsWith(`${EXTENSIONS}?`)).length;
    assert.equal(lists, 2);
    assert.equal(fetched.filter(f => f.url.startsWith(`${AIRFROG}?`)).length, 1, 'the Airfrog manifest once');
});

test("an extensions manifest that doesn't verify", async () => {
    const fails = async (manifest, signatures, message) => {
        serve({ [AIRFROG]: airfrog(), [EXTENSIONS]: manifest }, signatures);
        await assert.rejects(new Manifests({ url: AIRFROG, keys: KEYS }).extensions(), { message });
    };
    for (const signature of Object.values(BAD_SIGNATURES)) {
        await fails(extensions, { [EXTENSIONS]: signature }, HOME_PAGE.MANIFEST_SIGNATURE);
    }
    await fails({ ...extensions, type: 'firmware' }, {}, HOME_PAGE.MANIFEST_INVALID);
    await fails({ ...extensions, extensions: [] }, {}, HOME_PAGE.MANIFEST_INVALID);
    await fails({ ...extensions, extensions: undefined }, {}, HOME_PAGE.MANIFEST_INVALID);
});
