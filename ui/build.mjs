// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Bundles src/main.js into one ES module with esbuild. ci/build-ui.sh runs
// it with the path of the pinned esbuild and the node_modules directory of
// noble-ed25519 and noble-hashes. Their licences go at the end of the
// bundle. --manifest-key replaces commissioning/manifest-key.js with another
// module that exports MANIFEST_KEY and AIRFROG_MANIFEST, for example with a
// test key. --schema replaces js/schema.js with another, for example one
// with the test models.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const { values: args } = parseArgs({
    options: {
        esbuild: { type: 'string' },
        'node-modules': { type: 'string' },
        'manifest-key': { type: 'string' },
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

const manifestKey = {
    name: 'manifest-key',
    setup(build) {
        build.onResolve({ filter: /\/commissioning\/manifest-key\.js$/ }, () => ({
            path: path.resolve(args['manifest-key']),
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
    plugins: [args['manifest-key'] && manifestKey, args.schema && schema].filter(Boolean),
    loader: { '.webp': 'dataurl' },
    logLevel: 'warning',
});
