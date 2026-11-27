// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The release keys' public halves in hex, the release key first. They verify
// the Airfrog manifest, and Airfrog firmware and extension images.
// ci/schema.py writes them into the Airfrog firmware and the airfrog CLI.
export const RELEASE_KEYS = ['c44615e017975c65c1248565a67a4918e315aeab4fc0a67189b0f04692c6f85d', '8ef11f983e35a9750449ccdd998252a1d08fd2378e9f39334a6ea24dadb8710d'];

// The Airfrog manifest's address. ci/schema.py writes it into the Airfrog
// firmware and the airfrog CLI.
export const AIRFROG_MANIFEST = 'https://meta.piers.rocks/airfrog/manifest.json';
