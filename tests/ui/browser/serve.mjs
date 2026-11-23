// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Serves the site for index.html, Airfrog's full user interface as built
// against the fake Airfrog in a browser, with /logo.png and /favicon.png as
// Airfrog serves them and /setup.js, the setup module with the test
// models. POST /sign responds with the request body's minisign signature
// file, signed with airfrog-v2's test key. Run ci/test-deps.sh first.
//
// Usage: node tests/ui/browser/serve.mjs [port]
// Then open http://localhost:PORT/tests/ui/browser/ (default port 8765).
// ?password=PASSWORD sets the fake's password, and ?target=bootloader or
// ?target=pico another target. ?sta=1 has Airfrog joining a network, ?ap
// with AP mode on, ?open without a WiFi password saved, ?latest with the
// latest release installed and ?fw=0.2.1 another firmware version. ?opener
// stands in for onerom.org's window, with #bridge=https://onerom.org.
// ?apip=ADDRESS and ?staip=ADDRESS set AP mode's and the network's address.
// ?bootloader=2 reports the recovery bootloader, and ?chip=CHIP&model=MODEL
// an Airfrog of GET_HW_INFO's chip and model. ?stuck keeps One ROM as it is when it restarts. ?fwerror
// serves the firmware manifest with an invalid signature, and ?fwinvalid
// one with an empty list of releases. ?extensions=URL is the extensions
// manifest, ?installed=URL,URL the extension images installed and ?module=NAME an
// extension whose EXT_CMD replies with its data reversed. ?fallback=REASON displays
// Airfrog's setup, ?tab=ID on that tab.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { minisig } from '../minisign.mjs';

const root = path.resolve(new URL('../../../', import.meta.url).pathname);
const port = Number(process.argv[2] ?? 8765);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png',
    '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css' };
const AIRFROG = { '/logo.png': 'images/logo.png', '/favicon.png': 'images/favicon.png',
    '/setup.js': 'build/test-deps/setup/setup.js' };

http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/sign') {
        const body = [];
        req.on('data', (b) => body.push(b));
        req.on('end', () => res.writeHead(200, { 'Content-Type': 'text/plain' }).end(minisig(Buffer.concat(body))));
        return;
    }
    let file = path.join(root, AIRFROG[url.pathname] ?? decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) {
        res.writeHead(403).end();
        return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
        file = path.join(file, 'index.html');
    }
    fs.readFile(file, (err, data) => {
        if (err) {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
            'Cache-Control': 'no-store' }).end(data);
    });
}).listen(port, () => console.log(`http://localhost:${port}/tests/ui/browser/`));
