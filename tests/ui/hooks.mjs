// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Resolves noble-ed25519 and noble-hashes to the copies ci/build-ui.sh puts in
// build/ui-deps/, and loads an imported .webp image as its data URL, as the
// bundle contains it. js/schema.js resolves to
// build/test-deps/schema/js/schema.js, written with the test models by
// `ci/schema.py --test write site build/test-deps/schema`. Usage:
// node --import ./tests/ui/hooks.mjs ...

import fs from 'node:fs';
import { registerHooks } from 'node:module';

const root = new URL('../../', import.meta.url);
const noble = new URL('build/ui-deps/noble/', root);
const schema = new URL('js/schema.js', root).href;
const testSchema = new URL('build/test-deps/schema/js/schema.js', root).href;

registerHooks({
    resolve(specifier, context, next) {
        if (specifier.startsWith('@noble/')) {
            return next(specifier, { ...context, parentURL: noble.href });
        }
        const resolved = next(specifier, context);
        return resolved.url === schema ? { ...resolved, url: testSchema } : resolved;
    },
    load(url, context, next) {
        if (url.endsWith('.webp')) {
            const data = fs.readFileSync(new URL(url)).toString('base64');
            return { format: 'module', source: `export default 'data:image/webp;base64,${data}';`, shortCircuit: true };
        }
        return next(url, context);
    },
});
