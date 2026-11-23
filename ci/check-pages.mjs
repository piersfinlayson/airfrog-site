// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Fails when a page, script or stylesheet in DIR refers to a local file that
// isn't in DIR. References starting with / are relative to DIR.
//
// Usage: node ci/check-pages.mjs DIR

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '');

function files(dir) {
    return readdirSync(dir).flatMap(name => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : [path];
    });
}

function references(path, text) {
    switch (extname(path)) {
    case '.html':
        return [...text.matchAll(/\b(?:src|href)="([^"]*)"/g)].map(m => m[1]);
    case '.js':
        text = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        return [...text.matchAll(/(?:from\s+|import\s*\(?\s*|fetch\()['"]([^'"]+)['"]/g)].map(m => m[1])
            .filter(r => r.startsWith('.') || r.startsWith('/'));
    case '.css':
        return [...text.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)].map(m => m[1]);
    default:
        return [];
    }
}

const missing = [];
for (const path of files(root)) {
    for (const ref of references(path, readFileSync(path, 'utf8'))) {
        if (/^([a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(ref)) continue;
        const target = ref.split(/[?#]/)[0];
        if (target === '') continue;
        let file = target.startsWith('/') ? join(root, target) : resolve(dirname(path), target);
        if (target.endsWith('/')) file = join(file, 'index.html');
        if (!existsSync(file) || !file.startsWith(root)) {
            missing.push(`${relative(root, path)}: ${ref}`);
        }
    }
}

if (missing.length > 0) {
    console.error('References to files that are not published:\n' + missing.join('\n'));
    process.exit(1);
}
console.log(`${files(root).length} files, every local reference resolves`);
