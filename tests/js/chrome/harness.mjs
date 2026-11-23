// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Headless Chrome with local copies of the sites the browser tests use.
//
// - An HTTPS server stands in for picoflash.org, onerom.org,
//   images.airfrog.org and meta.piers.rocks, serving local checkouts and an
//   Airfrog manifest whose js_library is images.airfrog.org's. Chrome maps
//   those names to it and ignores its self-signed certificate.
// - An HTTP server stands in for Airfrog's home page: it serves bridge.html and
//   relays /api/ws to an Airfrog, so the WebSocket's Host and Origin are the
//   server's. That Airfrog needs the server's address as a host alias.
//
// Environment: CHROME, PICOFLASH_DIR, ONEROM_SITE_DIR.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AIRFROG_SITE = path.resolve(HERE, '../../..');
const BUILDS = path.resolve(AIRFROG_SITE, '../..');
const PICOFLASH = process.env.PICOFLASH_DIR ?? path.join(BUILDS, 'picoflash');
const ONEROM_SITE = process.env.ONEROM_SITE_DIR ?? path.join(BUILDS, 'one-rom-site');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain',
};

function sendFile(res, file) {
    let target = file;
    try {
        if (fs.statSync(target).isDirectory()) {
            target = path.join(target, 'index.html');
        }
        const body = fs.readFileSync(target);
        res.writeHead(200, {
            'Content-Type': TYPES[path.extname(target)] ?? 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
        });
        res.end(body);
    } catch (e) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        res.end('not found');
    }
}

/** The local file for a request to one of the HTTPS sites, or null. */
function siteFile(host, urlPath) {
    const p = decodeURIComponent(urlPath.split('?')[0]);
    if (p.includes('..')) {
        return null;
    }
    if (host === 'picoflash.org') {
        return path.join(PICOFLASH, p.replace(/^\/releases\/v[^/]+\//, '/'));
    }
    if (host === 'images.airfrog.org') {
        return path.join(AIRFROG_SITE, p.replace(/^\/js\/v[^/]+\//, '/js/'));
    }
    if (host === 'meta.piers.rocks') {
        return p === '/airfrog/manifest.json' ? path.join(HERE, 'airfrog-manifest.json') : null;
    }
    if (host === 'onerom.org') {
        return p.startsWith('/__test/') ? path.join(HERE, p.slice('/__test/'.length)) : path.join(ONEROM_SITE, p);
    }
    return null;
}

/**
 * Starts the servers and Chrome.
 * @param {{airfrog: string, airfrogPage?: boolean, bridgePort?: number, httpsPort?: number}} options
 *        airfrog: the Airfrog's ADDRESS:PORT. airfrogPage: relay every
 *        request to Airfrog, so Airfrog's home page and full user interface run in
 *        place of bridge.html
 */
export async function start({ airfrog, airfrogPage = false, bridgePort = 18190, httpsPort = 18443 }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airfrog-chrome-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test',
        '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });

    const secure = https.createServer({
        key: fs.readFileSync(path.join(dir, 'key.pem')),
        cert: fs.readFileSync(path.join(dir, 'cert.pem')),
    }, (req, res) => {
        const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
        const file = siteFile(host, req.url);
        if (!file) {
            res.writeHead(404);
            res.end();
            return;
        }
        sendFile(res, file);
    });
    await new Promise(r => secure.listen(httpsPort, '127.0.0.1', r));

    const [airfrogAddress, airfrogPort] = airfrog.split(':');
    const page = http.createServer((req, res) => {
        if (airfrogPage) {
            const upstream = http.request({
                host: airfrogAddress, port: Number(airfrogPort ?? 80), method: req.method, path: req.url,
                headers: req.headers,
            }, (r) => {
                res.writeHead(r.statusCode, r.headers);
                r.pipe(res);
            });
            upstream.on('error', () => { res.writeHead(502); res.end(); });
            req.pipe(upstream);
            return;
        }
        const p = req.url.split('?')[0];
        sendFile(res, p === '/' ? path.join(HERE, 'bridge.html') : path.join(AIRFROG_SITE, p));
    });
    page.on('upgrade', (req, socket, head) => {
        const upstream = net.connect(Number(airfrogPort ?? 80), airfrogAddress, () => {
            const lines = [`${req.method} ${req.url} HTTP/1.1`];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
            }
            upstream.write(lines.join('\r\n') + '\r\n\r\n');
            upstream.write(head);
            upstream.pipe(socket);
            socket.pipe(upstream);
        });
        // pipe() ends each side when the other ends, after what it has
        // received, so Airfrog's close frame reaches the browser.
        const end = () => { upstream.destroy(); socket.destroy(); };
        upstream.on('error', end);
        socket.on('error', end);
    });
    await new Promise(r => page.listen(bridgePort, '127.0.0.1', r));

    const profile = path.join(dir, 'profile');
    const chrome = spawn(CHROME, [
        '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run',
        '--no-default-browser-check', '--ignore-certificate-errors',
        `--host-resolver-rules=MAP picoflash.org 127.0.0.1:${httpsPort},MAP onerom.org 127.0.0.1:${httpsPort},` +
        `MAP images.airfrog.org 127.0.0.1:${httpsPort},MAP meta.piers.rocks 127.0.0.1:${httpsPort}`,
        'about:blank',
    ], { stdio: 'ignore' });

    let port = null;
    for (let i = 0; i < 100 && !port; i++) {
        await new Promise(r => setTimeout(r, 100));
        try {
            port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
        } catch (e) {
            // Not written yet
        }
    }
    if (!port) {
        throw new Error('Chrome didn\'t start');
    }
    const cdp = await Cdp.connect(`ws://127.0.0.1:${port[0]}${port[1]}`);

    return {
        cdp,
        bridgeHost: `127.0.0.1:${bridgePort}`,
        async stop() {
            cdp.close();
            chrome.kill();
            secure.close();
            page.close();
            page.closeAllConnections?.();
            secure.closeAllConnections?.();
            await new Promise(r => setTimeout(r, 300));
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

/** A Chrome DevTools Protocol connection to the browser. */
export class Cdp {
    static connect(url) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            ws.onopen = () => resolve(new Cdp(ws));
            ws.onerror = () => reject(new Error('CDP connection failed'));
        });
    }

    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.calls = new Map();
        this.listeners = [];
        ws.onmessage = (event) => {
            const m = JSON.parse(event.data);
            if (m.id && this.calls.has(m.id)) {
                const { resolve, reject } = this.calls.get(m.id);
                this.calls.delete(m.id);
                if (m.error) reject(new Error(m.error.message));
                else resolve(m.result);
            } else if (m.method) {
                this.listeners.forEach(fn => fn(m));
            }
        };
    }

    send(method, params = {}, sessionId = undefined) {
        const id = ++this.id;
        this.ws.send(JSON.stringify({ id, method, params, sessionId }));
        return new Promise((resolve, reject) => this.calls.set(id, { resolve, reject }));
    }

    on(fn) {
        this.listeners.push(fn);
        return () => { this.listeners = this.listeners.filter(f => f !== fn); };
    }

    /** Waits for an event that matches. */
    waitFor(match, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { off(); reject(new Error('timed out waiting for a CDP event')); }, timeoutMs);
            const off = this.on((m) => {
                if (match(m)) {
                    clearTimeout(timer);
                    off();
                    resolve(m);
                }
            });
        });
    }

    close() {
        this.ws.close();
    }

    /**
     * Opens url in a new tab.
     * @returns {Promise<Page>}
     */
    async open(url) {
        const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
        const page = await this.attach(targetId);
        await page.navigate(url);
        return page;
    }

    async attach(targetId) {
        const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
        const page = new Page(this, sessionId, targetId);
        await page.call('Page.enable');
        await page.call('Runtime.enable');
        return page;
    }

    /**
     * Waits for a page opened after the call whose URL starts with prefix,
     * and attaches to it.
     */
    async popup(prefix, timeoutMs = 10000) {
        const created = new Set();
        const off = this.on((m) => {
            if (m.method === 'Target.targetCreated') created.add(m.params.targetInfo.targetId);
        });
        const known = new Set((await this.send('Target.getTargets')).targetInfos.map(t => t.targetId));
        await this.send('Target.setDiscoverTargets', { discover: true });
        const fresh = (info) => info.type === 'page' && info.url.startsWith(prefix) && !known.has(info.targetId);
        try {
            const event = await this.waitFor(m => (m.method === 'Target.targetCreated' || m.method === 'Target.targetInfoChanged')
                && fresh(m.params.targetInfo), timeoutMs);
            return await this.attach(event.params.targetInfo.targetId);
        } finally {
            off();
        }
    }
}

class Page {
    constructor(cdp, sessionId, targetId) {
        this.cdp = cdp;
        this.sessionId = sessionId;
        this.targetId = targetId;
        this.console = [];
        cdp.on((m) => {
            if (m.sessionId !== sessionId) return;
            if (m.method === 'Runtime.consoleAPICalled') {
                this.console.push(m.params.args.map(a => a.value ?? a.description).join(' '));
            } else if (m.method === 'Runtime.exceptionThrown') {
                this.console.push(`EXCEPTION ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
            } else if (m.method === 'Page.javascriptDialogOpening') {
                this.console.push(`DIALOG ${m.params.type}: ${m.params.message}`);
                this.dialogs = (this.dialogs ?? []);
                this.dialogs.push(m.params.message);
                this.call('Page.handleJavaScriptDialog', { accept: true });
            }
        });
    }

    call(method, params = {}) {
        return this.cdp.send(method, params, this.sessionId);
    }

    async navigate(url) {
        const loaded = this.cdp.waitFor(m => m.sessionId === this.sessionId && m.method === 'Page.loadEventFired', 30000);
        await this.call('Page.navigate', { url });
        await loaded;
    }

    /**
     * Evaluates expression, awaiting a promise, as from a click when
     * userGesture.
     */
    async eval(expression, userGesture = false) {
        const r = await this.call('Runtime.evaluate', {
            expression, awaitPromise: true, returnByValue: true, userGesture,
        });
        if (r.exceptionDetails) {
            throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        }
        return r.result.value;
    }

    /** Polls expression until it is truthy. */
    async until(expression, timeoutMs = 10000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const value = await this.eval(expression).catch(() => null);
            if (value) return value;
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${expression}`);
            await new Promise(r => setTimeout(r, 100));
        }
    }
}
