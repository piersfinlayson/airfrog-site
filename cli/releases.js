// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The latest Airfrog CLI release of each architecture, from the CLI manifest.
// airfrog-v2/docs/ac3-design.md specifies it.

import { ReleaseError, loadManifest } from '../commissioning/release.js';
import { RELEASE_LIST } from '../js/messages.js';

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Downloads and verifies the CLI manifest through the Airfrog manifest at url.
 * key is the manifest key's public half in hex, which signs both.
 * @param {object} [options] - loadManifest()'s
 * @returns {Promise<Map<string, {version: string, url: string, file: string}>>}
 *          each architecture's latest release, by its Rust target, and its
 *          file's address and name
 * @throws {ReleaseError}
 */
export async function latestDownloads(url, key, options = {}) {
  const manifest = await loadManifest(url, key, 'cli_manifest', 'cli', options);
  if (!isObject(manifest.latest) || !Array.isArray(manifest.releases)) {
    throw new ReleaseError(RELEASE_LIST.INVALID);
  }
  const downloads = new Map();
  for (const [target, version] of Object.entries(manifest.latest)) {
    const release = manifest.releases.find((r) => r?.version === version);
    const platform = Array.isArray(release?.platforms) && release.platforms.find((p) => p?.target === target);
    if (!platform || !/^https?:\/\//.test(platform.url)) {
      throw new ReleaseError(RELEASE_LIST.INVALID);
    }
    downloads.set(target, { version, url: platform.url, file: platform.url.split('/').pop() });
  }
  return downloads;
}
