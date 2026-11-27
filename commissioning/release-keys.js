// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The release keys' public halves in hex, the release key first. They verify
// the Airfrog manifest, and Airfrog firmware and extension images.
// ci/schema.py writes them into the Airfrog firmware and the airfrog CLI.
export const RELEASE_KEYS = ['c44615e017975c65c1248565a67a4918e315aeab4fc0a67189b0f04692c6f85d'];

// The Airfrog manifest's address. ci/schema.py writes it into the Airfrog
// firmware and the airfrog CLI.
export const AIRFROG_MANIFEST = 'https://meta.piers.rocks/airfrog/manifest.json';
