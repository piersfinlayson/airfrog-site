// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Test keys, made once in build/test-keys/, and minisign signatures and
// signed files made with them. 'release' and 'backup' stand in for the
// release keys, and 'other' for a key that isn't one.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../../build/test-keys/', import.meta.url));

/** Test key name's private key, made the first time. */
function privateKey(name) {
    const file = `${DIR}${name}.pem`;
    if (!fs.existsSync(file)) {
        fs.mkdirSync(DIR, { recursive: true });
        const { privateKey: key } = crypto.generateKeyPairSync('ed25519');
        fs.writeFileSync(`${file}.new`, key.export({ format: 'pem', type: 'pkcs8' }));
        fs.renameSync(`${file}.new`, file);
    }
    return crypto.createPrivateKey(fs.readFileSync(file));
}

const KEYS = Object.fromEntries(['release', 'backup', 'other'].map((name) => {
    const key = privateKey(name);
    return [name, { key, public: crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32) }];
}));

/** Each test key's public half in hex. */
export const TEST_KEY = KEYS.release.public.toString('hex');
export const BACKUP_KEY = KEYS.backup.public.toString('hex');
export const OTHER_KEY = KEYS.other.public.toString('hex');

/** The 74-byte minisign legacy signature of body: Ed, the key ID and the Ed25519 signature. */
export function signature(body, name = 'release') {
    const k = KEYS[name];
    return Buffer.concat([Buffer.from('Ed'), k.public.subarray(0, 8), crypto.sign(null, body, k.key)]);
}

/** The signature file of body. */
export function minisig(body, name = 'release') {
    const k = KEYS[name];
    const sig = signature(body, name);
    const trusted = Buffer.from('timestamp:0\tfile:manifest');
    return `untrusted comment: signature from the Airfrog signing server\n${sig.toString('base64')}\n`
        + `trusted comment: ${trusted}\n${crypto.sign(null, Buffer.concat([sig.subarray(10), trusted]), k.key)
            .toString('base64')}\n`;
}

/** The signed file of image: zeros to 4 bytes, AFSG and its signature. */
export function signedFile(image, name = 'release') {
    const data = Buffer.from(image);
    return new Uint8Array(Buffer.concat([data, Buffer.alloc(-data.length & 3), Buffer.from('AFSG'),
        signature(data, name)]));
}
