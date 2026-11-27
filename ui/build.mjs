// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Bundles src/main.js into one ES module with esbuild. ci/build-ui.sh runs
// it with the path of the pinned esbuild and the node_modules directory of
// noble-ed25519 and noble-hashes. Their licences go at the end of the
// bundle. --schema replaces js/schema.js with another, for example one with
// the test models.
//
// The environment variables AIRFROG_MANIFEST, the Airfrog manifest's
// address, and AIRFROG_KEYS, release keys in hex separated by commas,
// replace commissioning/release-keys.js's. The build fails when two keys
// have the same key ID, their first 8 bytes.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const { values: args } = parseArgs({
    options: {
        esbuild: { type: 'string' },
        'node-modules': { type: 'string' },
        schema: { type: 'string' },
        'ui-version': { type: 'string' },
        banner: { type: 'string' },
        out: { type: 'string' },
    },
});

const esbuild = await import(pathToFileURL(args.esbuild).href);

/** The name, version and licence of each package in dir, a node_modules directory. */
function licences(dir) {
    return fs.readdirSync(dir).filter(name => !name.startsWith('.')).flatMap((name) => {
        const p = path.join(dir, name);
        if (name.startsWith('@')) {
            return licences(p);
        }
        const { name: pkg, version } = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8'));
        return [`${pkg} ${version}\n\n${fs.readFileSync(path.join(p, 'LICENSE'), 'utf8').trim()}`];
    });
}

/**
 * commissioning/release-keys.js's exports with the environment's overrides.
 * Exits when a key isn't 64 hex digits or two keys have the same key ID.
 */
async function releaseKeys() {
    const own = await import(new URL('../commissioning/release-keys.js', import.meta.url).href);
    const manifest = process.env.AIRFROG_MANIFEST || own.AIRFROG_MANIFEST;
    const keys = process.env.AIRFROG_KEYS
        ? process.env.AIRFROG_KEYS.split(',').map(k => k.trim().toLowerCase()) : own.RELEASE_KEYS;
    const ids = new Set();
    for (const key of keys) {
        if (!/^[0-9a-f]{64}$/.test(key)) {
            console.error(`AIRFROG_KEYS: ${key} isn't an Ed25519 public key in hex`);
            process.exit(1);
        }
        if (ids.has(key.slice(0, 16))) {
            console.error(`AIRFROG_KEYS: two keys have the key ID ${key.slice(0, 16)}`);
            process.exit(1);
        }
        ids.add(key.slice(0, 16));
    }
    return { manifest, keys };
}

const overridden = process.env.AIRFROG_MANIFEST || process.env.AIRFROG_KEYS;
const { manifest, keys } = await releaseKeys();

const releaseKeysModule = {
    name: 'release-keys',
    setup(build) {
        build.onResolve({ filter: /\/commissioning\/release-keys\.js$/ }, () => ({
            path: 'release-keys', namespace: 'release-keys',
        }));
        build.onLoad({ filter: /.*/, namespace: 'release-keys' }, () => ({
            contents: `export const RELEASE_KEYS = ${JSON.stringify(keys)};\n`
                + `export const AIRFROG_MANIFEST = ${JSON.stringify(manifest)};\n`,
            loader: 'js',
        }));
    },
};

const schema = {
    name: 'schema',
    setup(build) {
        const real = new URL('../js/schema.js', import.meta.url).pathname;
        build.onResolve({ filter: /(^|\/)schema\.js$/ }, (file) =>
            (path.resolve(file.resolveDir, file.path) === real ? { path: path.resolve(args.schema) } : undefined));
    },
};

await esbuild.build({
    entryPoints: [new URL('src/main.js', import.meta.url).pathname],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: args.out,
    banner: { js: args.banner },
    footer: { js: `/*\n${licences(args['node-modules']).join('\n\n')}\n*/` },
    define: {
        __UI_VERSION__: JSON.stringify(args['ui-version']),
    },
    nodePaths: [args['node-modules']],
    plugins: [overridden && releaseKeysModule, args.schema && schema].filter(Boolean),
    loader: { '.webp': 'dataurl' },
    logLevel: 'warning',
});
