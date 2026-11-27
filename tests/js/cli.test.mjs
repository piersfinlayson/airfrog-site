// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// airfrog.org/cli's downloads, from the Airfrog manifest and the CLI manifest
// signed with the test key 'release' (tests/ui/minisign.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_KEY, minisig } from '../ui/minisign.mjs';
import { latestDownloads } from '../../cli/releases.js';
import { ReleaseError } from '../../commissioning/release.js';
import { COMMISSIONING_FIRMWARE, RELEASE_LIST } from '../../js/messages.js';

const AIRFROG_URL = 'https://meta.test/airfrog/manifest.json';
const CLI_URL = 'https://images.test/cli/manifest.json';
const WINDOWS = 'x86_64-pc-windows-msvc';
const MACOS = 'universal-apple-darwin';
const AIRFROG = { type: 'airfrog', version: 1, cli_manifest: { url: CLI_URL, key: TEST_KEY } };
const platform = (target, version) => ({ target, url: `https://files.test/cli-v${version}/airfrog-${version}-${target}.zip`,
  size: 1, sha256: 'ab'.repeat(32) });
const cli = () => ({
  type: 'cli', version: 1, latest: { [WINDOWS]: '0.2.0', [MACOS]: '0.3.0' },
  releases: [{ version: '0.3.0', platforms: [platform(WINDOWS, '0.3.0'), platform(MACOS, '0.3.0')] },
    { version: '0.2.0', platforms: [platform(WINDOWS, '0.2.0')] }],
});

/** latestDownloads() with the manifests served, body's signature made from signed(body). */
function load(manifests, { signed = (url, body) => body, keys = [TEST_KEY] } = {}) {
  return latestDownloads(AIRFROG_URL, keys, { fetch: async (url) => {
    const at = url.replace(/\.minisig$/, '');
    if (!manifests[at]) return new Response('', { status: 404 });
    const body = Buffer.from(JSON.stringify(manifests[at]));
    return new Response(url === at ? body : minisig(signed(at, body)));
  } });
}

test("each architecture's latest release, which an older release can be", async () => {
  assert.deepEqual([...await load({ [AIRFROG_URL]: AIRFROG, [CLI_URL]: cli() })], [
    [WINDOWS, { version: '0.2.0', url: platform(WINDOWS, '0.2.0').url, file: `airfrog-0.2.0-${WINDOWS}.zip` }],
    [MACOS, { version: '0.3.0', url: platform(MACOS, '0.3.0').url, file: `airfrog-0.3.0-${MACOS}.zip` }],
  ]);
  assert.equal((await load({ [AIRFROG_URL]: AIRFROG, [CLI_URL]: { ...cli(), latest: {} } })).size, 0);
});

test("manifests that don't verify", async () => {
  const good = { [AIRFROG_URL]: AIRFROG, [CLI_URL]: cli() };
  for (const url of [AIRFROG_URL, CLI_URL]) {
    await assert.rejects(load(good, { signed: (at, body) => (at === url ? Buffer.from('x') : body) }),
      { message: RELEASE_LIST.SIGNATURE }, url);
  }
  const invalid = [
    { ...good, [AIRFROG_URL]: { ...AIRFROG, type: 'ui' } },
    { ...good, [AIRFROG_URL]: { ...AIRFROG, cli_manifest: undefined } },
    { ...good, [AIRFROG_URL]: { ...AIRFROG, cli_manifest: CLI_URL } },
    { ...good, [CLI_URL]: { ...cli(), type: 'firmware' } },
    { ...good, [CLI_URL]: { ...cli(), latest: undefined } },
    { ...good, [CLI_URL]: { ...cli(), releases: {} } },
    { ...good, [CLI_URL]: { ...cli(), latest: { [WINDOWS]: '0.1.0' } } },
    { ...good, [CLI_URL]: { ...cli(), latest: { [MACOS]: '0.2.0' } } },
  ];
  for (const [i, manifests] of invalid.entries()) {
    await assert.rejects(load(manifests), { message: RELEASE_LIST.INVALID }, `case ${i}`);
  }
  await assert.rejects(load({ [AIRFROG_URL]: AIRFROG }), ReleaseError);
  await assert.rejects(load(good, { keys: [] }), { message: COMMISSIONING_FIRMWARE.RELEASE_KEYS_NOT_SET });
});
