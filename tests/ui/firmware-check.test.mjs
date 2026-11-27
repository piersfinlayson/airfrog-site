// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// checkHello: HELLO's manifest address and release keys against the Airfrog
// UI's own.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkHello } from '../../ui/src/firmware-check.js';
import { Hello } from '../../js/awp.js';
import { AIRFROG_MANIFEST, RELEASE_KEYS } from '../../commissioning/release-keys.js';
import { CONNECTION } from '../../js/messages.js';

const key = (byte) => new Uint8Array(32).fill(byte);
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const hello = (manifestUrl, keys) => Object.assign(new Hello(), { manifestUrl, keys: keys.map(k => ({ key: k })) });
const own = { manifest: 'https://meta.test/manifest.json', keys: [hex(key(1)), hex(key(2))] };

test('the same address and a key in common: the check passes', () => {
    assert.equal(checkHello(hello(own.manifest, [key(1)]), own), null);
    assert.equal(checkHello(hello(own.manifest, [key(9), key(2)]), own), null, 'any key in common');
});

test('another address or no key in common: OTHER_FIRMWARE', () => {
    for (const [what, h] of [['another address', hello('https://other.test/manifest.json', [key(1)])],
        ['no key in common', hello(own.manifest, [key(9)])], ['no keys', hello(own.manifest, [])]]) {
        const e = checkHello(h, own);
        assert.equal(e?.code, 'OTHER_FIRMWARE', what);
        assert.equal(e.message, CONNECTION.OTHER_FIRMWARE);
    }
});

test("release-keys.js's address and keys by default", () => {
    const keys = RELEASE_KEYS.map(k => Uint8Array.from(k.match(/../g), b => parseInt(b, 16)));
    assert.equal(checkHello(hello(AIRFROG_MANIFEST, keys)), null);
    assert.equal(checkHello(hello(AIRFROG_MANIFEST, [key(9)]))?.code, 'OTHER_FIRMWARE');
});
