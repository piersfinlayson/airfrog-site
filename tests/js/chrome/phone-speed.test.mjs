// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Airfrog's setup at a phone's speed, in headless Chrome with the CPU
// throttled until PBKDF2's 100,000 iterations take longer than Airfrog's 5 s
// limit on a connection that hasn't logged in. Against tests/ui's stand-in
// Airfrog, which has the same limit, or with QEMU=ADDRESS:PORT against
// Airfrog in QEMU (airfrog-v2's `ci/qemu.sh --serve mini`) through a relay
// that serves build/setup/setup.js (ci/build-setup.sh) as Airfrog's
// /setup.js, and marks each session and home page request as over the access
// point during first setup and the reset.
//
// - First setup's password: the login card is then displayed.
// - The forgotten password replaced over the recovery button access point:
//   the login card is then displayed for the new password.
// - While the login card is displayed, no connection is open.
// - Logging in with the new password.
// - Airfrog closes no connection for its 5 s limit.
//
// Run ci/test-deps.sh first, and ci/build-setup.sh for QEMU. Airfrog in QEMU
// must start without a password, and is left without one.
//
// Usage: node tests/js/chrome/phone-speed.test.mjs
//   QEMU        QEMU Airfrog's ADDRESS:PORT. AIRFROG_V2 is the airfrog-v2 checkout
//   PAGE_PORT   the port of the stand-in's page or the relay (default 18770)
//   SLOW_MS     how long PBKDF2 takes once throttled (default 8000)
//   CHROME      Chrome's path (default: macOS's)

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp } from './harness.mjs';
import { CONNECTION } from '../../../js/messages.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const QEMU = process.env.QEMU ?? null;
const PAGE_PORT = Number(process.env.PAGE_PORT ?? 18770);
const PAGE = `http://127.0.0.1:${PAGE_PORT}/${QEMU ? '' : 'tests/ui/browser/'}`;
const FIRST = 'Frog pond 1';
const SECOND = 'Newt pond 2';
const SLOW_MS = Number(process.env.SLOW_MS ?? 8000);

let failures = 0;
const check = (ok, what) => {
    if (!ok) failures++;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${what}\n`);
};
const note = (what) => process.stdout.write(`     ${what}\n`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The page's server: the stand-in's, or the relay to QEMU.
let server;
const relay = { ap: false, open: 0, closes: [] };
if (!QEMU) {
    server = spawn(process.execPath, [path.join(ROOT, 'tests/ui/browser/serve.mjs'), String(PAGE_PORT)], { stdio: 'ignore' });
} else {
    const [host, port] = QEMU.split(':');
    const qemu = (route) => new Promise((resolve, reject) => {
        http.get({ host, port: Number(port), path: route }, (r) => { r.resume(); r.on('end', resolve); }).on('error', reject);
    });
    relay.qemu = qemu;
    server = http.createServer(async (req, res) => {
        const p = req.url.split('?')[0];
        if (relay.ap && p === '/') {
            await qemu('/qemu-ap?page=1').catch(() => {});
        }
        if (p === '/setup.js' || p.startsWith('/__site/')) {
            res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
            res.end(fs.readFileSync(p === '/setup.js' ? path.join(ROOT, 'build/setup/setup.js')
                : path.join(ROOT, p.slice('/__site/'.length))));
            return;
        }
        const upstream = http.request({ host, port: Number(port), method: req.method, path: req.url,
            headers: req.headers }, (r) => {
            res.writeHead(r.statusCode, r.headers);
            r.pipe(res);
        });
        upstream.on('error', () => { res.writeHead(502); res.end(); });
        req.pipe(upstream);
    });
    server.on('upgrade', async (req, socket, head) => {
        if (relay.ap) {
            await qemu('/qemu-ap?session=1').catch(() => {});
        }
        relay.open += 1;
        socket.on('close', () => { relay.open -= 1; });
        const upstream = net.connect(Number(port), host, () => {
            const lines = [`${req.method} ${req.url} HTTP/1.1`];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
            }
            upstream.write(lines.join('\r\n') + '\r\n\r\n');
            upstream.write(head);
            upstream.on('data', closeCodes());
            upstream.pipe(socket);
            socket.pipe(upstream);
        });
        const end = () => { upstream.destroy(); socket.destroy(); };
        upstream.on('error', end);
        socket.on('error', end);
    });
    server.listen(PAGE_PORT, '127.0.0.1');
}
/** Reads Airfrog's side of a WebSocket, recording the code of its close frame in relay.closes. */
function closeCodes() {
    let data = Buffer.alloc(0);
    let upgraded = false;
    return (chunk) => {
        data = Buffer.concat([data, chunk]);
        if (!upgraded) {
            const end = data.indexOf('\r\n\r\n');
            if (end < 0) return;
            data = data.subarray(end + 4);
            upgraded = true;
        }
        for (;;) {
            if (data.length < 2) return;
            let len = data[1] & 0x7f;
            let at = 2;
            if (len === 126) {
                if (data.length < 4) return;
                len = data.readUInt16BE(2);
                at = 4;
            } else if (len === 127) {
                if (data.length < 10) return;
                len = Number(data.readBigUInt64BE(2));
                at = 10;
            }
            if (data.length < at + len) return;
            if ((data[0] & 0x0f) === 8 && len >= 2) {
                relay.closes.push(data.readUInt16BE(at));
            }
            data = data.subarray(at + len);
        }
    };
}
const V2 = path.resolve(process.env.AIRFROG_V2 ?? path.join(ROOT, '../airfrog-v2'));
const admin = (hostname, password, ...args) => execFileSync('python3', [path.join(HERE, '..', 'airfrog_admin.py'), QEMU,
    hostname, password, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AIRFROG_V2: V2 } }).trim();

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-speed-'));
const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
let devtools = null;
for (let i = 0; i < 100 && !devtools; i++) {
    await sleep(100);
    try {
        devtools = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
    } catch (e) {
        // Not written yet
    }
}
const cdp = await Cdp.connect(`ws://127.0.0.1:${devtools[0]}${devtools[1]}`);

const text = `document.querySelector('main').innerText`;
const ready = `(c => c && !c.hidden && !c.inert)(document.querySelector('.content'))
    && /^v/.test(document.getElementById('firmware-version')?.textContent ?? '')`;
const loginCard = `[...document.querySelectorAll('section.card')].find(c => c.querySelector('h2')?.textContent === 'Log in')`;
const loginShown = `(c => c && !c.hidden)(${loginCard})`;
const loginMsg = `${loginCard}.querySelector('.msg').textContent`;
/** The login card's message, 'logged in', or the first line the page displays. */
const outcome = `(${loginShown} && ${loginMsg}) || ((${ready}) ? 'logged in' : ${text}.split('\\n')[0])`;
const submit = (values) => `(() => {
    const v = ${JSON.stringify(values)};
    const first = [...document.querySelectorAll('input[name=' + Object.keys(v)[0] + ']')].find(i => i.offsetParent);
    for (const [name, value] of Object.entries(v)) {
        const i = first.form.elements[name];
        i.value = value;
        i.dispatchEvent(new Event('input', { bubbles: true }));
    }
    first.form.requestSubmit();
    return true;
})()`;
const throttle = (page, rate) => page.call('Emulation.setCPUThrottlingRate', { rate });
/** The page's connections to Airfrog that are open. */
const openConnections = (page) => (QEMU ? relay.open : page.eval('window.fake.sessions.size'));
/** The connections Airfrog closed with 4005, LOGIN_TIMEOUT, in the stand-in. */
const loginTimeouts = async (page) => (QEMU ? relay.closes : await page.eval('window.fake.closes')).filter(c => c === 4005).length;
/** Whether password logs in to Airfrog. */
async function logsIn(page, password) {
    if (QEMU) {
        try {
            admin('127.0.0.1', password, 'get-aliases');
            return true;
        } catch (e) {
            return false;
        }
    }
    const { key, salt, iterations } = await page.eval(`({ key: [...window.fake.key], salt: [...window.fake.salt],
        iterations: window.fake.config.iterations })`);
    return Buffer.from(key).equals(crypto.pbkdf2Sync(password, Buffer.from(salt), iterations, 32, 'sha256'));
}

/** Opens Airfrog's setup for case 'first', 'reset' or 'login' with Airfrog's password. */
async function open(kind, password = null) {
    if (!QEMU) {
        const query = { first: `via=3&sta=0&ap&open&ssid=`, reset: `via=4&password=${encodeURIComponent(password)}`,
            login: `password=${encodeURIComponent(password)}` }[kind];
        return cdp.open(`${PAGE}?fallback=x&${query}`);
    }
    await relay.qemu(kind === 'first' ? '/qemu-ap?mode=1' : '/qemu-ap?mode=0');
    if (kind === 'reset') {
        await relay.qemu('/qemu-button?ms=120000');
    } else {
        await relay.qemu('/qemu-button?ms=1');
    }
    relay.ap = kind !== 'login';
    return cdp.open(`${PAGE}#local`);
}

/** Waits for expression on page. On a timeout, notes what the page displayed and returns false. */
async function wait(page, expression, timeoutMs) {
    try {
        return await page.until(expression, timeoutMs);
    } catch (e) {
        note(`timed out after ${timeoutMs / 1000} s. The page displayed: ${(await page.eval(text).catch(() => '?')).split('\n')[0]}`);
        note(`Airfrog's close codes: ${QEMU ? relay.closes.join() : await page.eval('window.fake.closes.join()')}`);
        return false;
    }
}

/** Runs fn with the page's CPU throttled to rate. */
async function throttled(page, rate, fn) {
    await throttle(page, rate);
    try {
        return await fn();
    } finally {
        await throttle(page, 1);
    }
}

// Airfrog's password, which the end removes
let password = null;
try {
    if (QEMU) {
        admin('airfrog', '-', 'set-aliases', '127.0.0.1');
    }
    // The throttling rate at which PBKDF2's 100,000 iterations take SLOW_MS.
    const calibrate = await cdp.open(QEMU ? `${PAGE}#local` : `${PAGE}?fallback=x`);
    const sha = QEMU ? '/__site/js/sha256.js' : '/js/sha256.js';
    const pbkdf2Ms = `(async () => { const { pbkdf2HmacSha256 } = await import('${sha}'); const t = performance.now();
        pbkdf2HmacSha256(new TextEncoder().encode('x'), new Uint8Array(16), 100000); return performance.now() - t; })()`;
    const fast = await calibrate.eval(pbkdf2Ms);
    const rate = Math.ceil(SLOW_MS / fast);
    const slow = await throttled(calibrate, rate, () => calibrate.eval(pbkdf2Ms));
    await cdp.send('Target.closeTarget', { targetId: calibrate.targetId });
    check(slow > 5000, `at ${rate}x throttling PBKDF2 takes ${Math.round(slow)} ms, past Airfrog's 5 s (${Math.round(fast)} ms unthrottled)`);

    // First setup's password, then the login card
    const first = await open('first');
    await first.until(`(c => c && !c.hidden)(document.getElementById('first-setup'))`, 30000);
    await throttled(first, rate, async () => {
        await first.eval(submit({ password: FIRST, repeat: FIRST }));
        await wait(first, `${loginShown} || ${ready}`, 60000);
    });
    check(await first.eval(`${loginShown} && ${loginMsg} === ${JSON.stringify(CONNECTION.PASSWORD_SAVED)}`)
        && !await first.eval(ready), `first setup: the login card asks to log in with the new password (${
        await first.eval(outcome)})`);
    password = await logsIn(first, FIRST) ? FIRST : null;
    check(password === FIRST, 'first setup: the password is set');
    await cdp.send('Target.closeTarget', { targetId: first.targetId });

    // The forgotten password replaced over the recovery button access point
    const reset = await open('reset', FIRST);
    await reset.until(`${loginShown} && ${text}.includes(${JSON.stringify(CONNECTION.RESET_PASSWORD)})`, 30000);
    const before = await loginTimeouts(reset);
    await throttled(reset, rate, async () => {
        await reset.eval(submit({ repeat: SECOND, password: SECOND }));
        await wait(reset, `(${loginShown} && ${loginMsg}) || ${ready}`, 60000);
    });
    const shown = await reset.eval(outcome);
    note(`the reset displayed: ${shown}`);
    check(shown === CONNECTION.PASSWORD_SAVED, 'reset: the login card asks to log in with the new password');
    password = await logsIn(reset, SECOND) ? SECOND : password;
    check(password === SECOND, 'reset: the new password is set');
    check(await loginTimeouts(reset) === before, 'reset: Airfrog closed no connection for its 5 s login limit');

    // No connection is open while the login card waits for the password.
    await sleep(7000);
    check(await openConnections(reset) === 0 && await reset.eval(loginShown),
        'no connection is open while the login card is displayed');

    // Logging in with the new password
    await throttled(reset, rate, async () => {
        await reset.eval(submit({ password: SECOND }));
        await wait(reset, `${ready} || (${loginShown} && ${loginMsg}) || /timed out/.test(${text})`, 60000);
    });
    const loggedIn = await reset.eval(ready);
    note(`the login: ${await reset.eval(outcome)}`);
    check(loggedIn, 'logging in at phone speed');
    check(await loginTimeouts(reset) === before, 'login: Airfrog closed no connection for its 5 s login limit');
} catch (e) {
    failures++;
    process.stdout.write(`FAIL ${e.stack}\n`);
} finally {
    cdp.close();
    chrome.kill();
    await sleep(300);
    if (QEMU) {
        if (password) {
            admin('127.0.0.1', password, 'clear-password');
        }
        await relay.qemu('/qemu-button?ms=1').catch(() => {});
        await relay.qemu('/qemu-ap?mode=0').catch(() => {});
        server.close();
        server.closeAllConnections?.();
    } else {
        server.kill();
    }
    fs.rmSync(profile, { recursive: true, force: true });
}
process.stdout.write(failures ? `${failures} FAILED\n` : 'all passed\n');
process.exit(failures ? 1 : 0);
