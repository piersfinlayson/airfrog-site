// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Minisign signature files made with airfrog-v2's test key,
// test/keys/manifest.pem, as build/z27/make_manifests.py writes them.

import crypto from 'node:crypto';
import fs from 'node:fs';

const KEY = crypto.createPrivateKey(fs.readFileSync(new URL('../../../airfrog-v2/test/keys/manifest.pem', import.meta.url)));
const PUBLIC = crypto.createPublicKey(KEY).export({ format: 'der', type: 'spki' }).subarray(-32);

/** The test key's public half in hex. */
export const TEST_KEY = PUBLIC.toString('hex');

/** The signature file of body. */
export function minisig(body) {
    const signature = crypto.sign(null, body, KEY);
    const trusted = Buffer.from('timestamp:0\tfile:manifest.json');
    return `untrusted comment: signature from the Airfrog signing server\n${
        Buffer.concat([Buffer.from('Ed'), PUBLIC.subarray(0, 8), signature]).toString('base64')}\n`
        + `trusted comment: ${trusted}\n${crypto.sign(null, Buffer.concat([signature, trusted]), KEY).toString('base64')}\n`;
}
