// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// ui/build.mjs with AIRFROG_MANIFEST and AIRFROG_KEYS in place of
// commissioning/release-keys.js's, and two keys with the same key ID.
// Run after ci/build-ui.sh, which installs esbuild and noble.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AIRFROG_MANIFEST, RELEASE_KEYS } from '../../commissioning/release-keys.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ESBUILD = fs.readFileSync(path.join(ROOT, 'ci/esbuild-version'), 'utf8').trim();
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ui-build-')), 'ui.js');

/** Runs ui/build.mjs with env added. */
function build(env) {
    return spawnSync(process.execPath, [path.join(ROOT, 'ui/build.mjs'),
        '--esbuild', path.join(ROOT, `build/ui-deps/esbuild-${ESBUILD}/node_modules/esbuild/lib/main.js`),
        '--node-modules', path.join(ROOT, 'build/ui-deps/noble/node_modules'), '--ui-version', '0.0.0',
        '--banner', '// test', '--out', out], { env: { ...process.env, AIRFROG_MANIFEST: '', AIRFROG_KEYS: '', ...env },
        encoding: 'utf8' });
}

test("without the variables: release-keys.js's keys and address", () => {
    assert.equal(build({}).status, 0);
    const ui = fs.readFileSync(out, 'utf8');
    assert.ok(RELEASE_KEYS.every(k => ui.includes(k)) && ui.includes(AIRFROG_MANIFEST));
});

test('AIRFROG_MANIFEST and AIRFROG_KEYS replace them', () => {
    const keys = ['aa'.repeat(32), `bb${'cc'.repeat(31)}`];
    const r = build({ AIRFROG_MANIFEST: 'http://dev.test:8000/manifest.json', AIRFROG_KEYS: keys.join(',').toUpperCase() });
    assert.equal(r.status, 0, r.stderr);
    const ui = fs.readFileSync(out, 'utf8');
    assert.ok(keys.every(k => ui.includes(k)) && ui.includes('http://dev.test:8000/manifest.json'));
    assert.ok(!RELEASE_KEYS.some(k => ui.includes(k)) && !ui.includes(AIRFROG_MANIFEST));
});

test('two keys with the same key ID, or a key that isn\'t one, fail the build', () => {
    const dup = build({ AIRFROG_KEYS: [`${'ab'.repeat(8)}${'00'.repeat(24)}`, `${'ab'.repeat(8)}${'11'.repeat(24)}`].join() });
    assert.equal(dup.status, 1);
    assert.match(dup.stderr, /two keys have the key ID abababababababab/);
    const bad = build({ AIRFROG_KEYS: 'abc' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /isn't an Ed25519 public key/);
});
