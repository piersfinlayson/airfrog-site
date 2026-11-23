// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// airfrog.org/web in headless Chrome, served from 127.0.0.1 with a stand-in
// Airfrog on another port of 127.0.0.1. Checks the form, an invalid address,
// no response and its link, the blocked text, the frame and its content, Change
// address, a saved address connecting again, an alias opening in the tab only
// from a click, the time allowed while Chrome asks for the permission, and a
// frame refused by another site's frame-ancestors header against the header
// Airfrog sends. Chrome's own prompt isn't tested: the permission is granted
// by script, and a stand-in replaces permissions.query where a test needs
// 'prompt' or 'denied'.
//
// Usage: node tests/js/chrome/web.test.mjs
//   CHROME  Chrome's path (default: macOS's)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SITE_PORT = 18770;
const AIRFROG_PORT = 18771;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const PAGE = `${SITE}/web/`;
const AIRFROG = `127.0.0.1:${AIRFROG_PORT}`;
const ALIAS = `airfrog.test:${AIRFROG_PORT}`;
/** The header Airfrog sends with its home page. */
const AIRFROG_HEADER = 'frame-ancestors https://airfrog.org https://onerom.org http://127.0.0.1:*';
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox '
    + 'allow-downloads allow-modals';
const ALLOW = 'local-network-access; local-network; loopback-network';

let failures = 0;
const check = (ok, what) => {
    if (!ok) failures++;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${what}\n`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** A port nothing listens on. */
const freePort = () => new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address();
        s.close(() => resolve(port));
    });
});

// The stand-in Airfrog. Its home page tells the page that framed it.
const stand = { header: null, delayMs: 0, requests: [] };
const airfrog = http.createServer((req, res) => {
    stand.requests.push(`${req.headers.host}${req.url}`);
    setTimeout(() => {
        const headers = { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' };
        if (stand.header) headers['Content-Security-Policy'] = stand.header;
        res.writeHead(200, headers);
        res.end('<!doctype html><title>Stand-in Airfrog</title><p id=hello>Stand-in Airfrog</p>'
            + '<script>parent.postMessage("frame " + location.origin, "*")</script>');
    }, stand.delayMs);
});
await new Promise(r => airfrog.listen(AIRFROG_PORT, '127.0.0.1', r));

const site = spawn(process.execPath, [path.join(ROOT, 'tests/ui/browser/serve.mjs'), String(SITE_PORT)],
    { stdio: 'ignore' });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'web-'));
const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,900',
    '--host-resolver-rules=MAP airfrog.test 127.0.0.1', 'about:blank'], { stdio: 'ignore' });
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

/** A stand-in for permissions.query, so a test sets the state. */
const stubPermission = (state, flipTo = null, afterMs = 0) => `(() => {
    const status = new EventTarget();
    status.state = ${JSON.stringify(state)};
    ${flipTo ? `setTimeout(() => { status.state = ${JSON.stringify(flipTo)}; status.dispatchEvent(new Event('change')); }, ${afterMs});` : ''}
    navigator.permissions.query = async () => status;
})()`;

/**
 * Opens the page in a new tab, with a script that runs before the page's.
 * The saved address is cleared first unless keep is true.
 */
async function open(url, before = '', keep = false) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const page = await cdp.attach(targetId);
    if (!keep) {
        // A page left open by an earlier test can save its address after the clear, so the clear is
        // from a file that isn't a page.
        await page.navigate(`${SITE}/images/favicon.png`);
        await page.eval('localStorage.clear(), true');
    }
    await page.call('Page.addScriptToEvaluateOnNewDocument', { source: `
        window.addEventListener('message', (e) => (window.frameMessages ??= []).push(e.data));
        ${before}` });
    await page.navigate(url);
    return page;
}

const q = (selector, expression = 'e') => `(e => e ? ${expression} : null)(document.querySelector(${JSON.stringify(selector)}))`;
const shown = (selector) => `document.querySelector(${JSON.stringify(selector)})?.offsetParent != null`;
const typeAddress = (text) => `(() => {
    const field = document.querySelector('input[name=address]');
    field.value = ${JSON.stringify(text)};
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
})()`;
const hasField = `!!document.querySelector('input[name=address]')`;
const hasFrame = `!!document.querySelector('iframe')`;
const clickConnect = `document.querySelector('form button').click(), true`;
const message = q('.msg', 'e.textContent');
const frameLoaded = `(window.frameMessages ?? []).some(m => String(m).startsWith('frame '))`;

try {
    // The form
    let page = await open(PAGE);
    await page.until(hasField, 10000);
    check(await page.eval(q('h1', 'e.textContent')) === 'Airfrog Web', 'the page\'s heading is Airfrog Web');
    check(await page.eval(`document.querySelector('label').textContent`) === 'Airfrog address',
        'the field is labelled Airfrog address');
    check(await page.eval(q('input[name=address]', 'e.value')) === 'airfrog.local', 'the field starts as airfrog.local');
    check(await page.eval(q('form button', 'e.textContent')) === 'Connect', 'the button is Connect');
    check(await page.eval(`!document.querySelector('iframe')`), 'the form doesn\'t display a frame');
    await page.until(`document.querySelector('.site-head')`, 5000);
    check(await page.eval(`!!document.querySelector('.site-foot') || !!document.getElementById('footer')`),
        'the site header and footer load');

    // An invalid address
    await page.eval(typeAddress('https://airfrog.local'));
    await page.eval(clickConnect, true);
    check(await page.eval(message) === 'Invalid address https://airfrog.local.', 'an https address is invalid');
    check(await page.eval(q('input[name=address]', 'e.hasAttribute("aria-invalid")')),
        'the field is marked invalid');
    check(await page.eval(`!document.querySelector('iframe') && location.pathname === '/web/'`),
        'an invalid address doesn\'t connect or leave the page');
    check(await page.eval(`localStorage.getItem('airfrog-web-address')`) === null, 'an invalid address isn\'t saved');

    // No response, with the link
    const closed = `127.0.0.1:${await freePort()}`;
    await page.eval(typeAddress(closed));
    check(await page.eval(q('input[name=address]', 'e.hasAttribute("aria-invalid")')) === false,
        'typing clears the invalid mark');
    await page.eval(clickConnect, true);
    await page.until(`/^No response from/.test(document.querySelector('.msg').textContent)`, 10000);
    check(await page.eval(message) === `No response from ${closed}. Open http://${closed}/`,
        `no response: the text and the link's text (${await page.eval(message)})`);
    check(await page.eval(q('.msg a', 'e.href')) === `http://${closed}/`, 'the link opens the Airfrog address');
    check(await page.eval(`!document.querySelector('input[name=address]').disabled`) && await page.eval(`!document.querySelector('iframe')`),
        'after no response the form is displayed again');
    check(await page.eval(`localStorage.getItem('airfrog-web-address')`) === null, 'an address with no response isn\'t saved');

    // The blocked text: permission denied
    page = await open(PAGE, stubPermission('denied'));
    await page.until(hasField, 10000);
    await page.eval(typeAddress(closed));
    await page.eval(clickConnect, true);
    await page.until(`document.querySelector('.msg a')`, 10000);
    check(await page.eval(message) === `Local network access is blocked for 127.0.0.1. Allow it in the browser's site settings. Open http://${closed}/`,
        `a denied permission has its own text and the link (${await page.eval(message)})`);

    // Connect displays the frame
    page = await open(PAGE);
    await page.until(hasField, 10000);
    await page.eval(typeAddress(AIRFROG));
    await page.eval(clickConnect, true);
    await page.until(hasFrame, 10000);
    check(true, 'Connect to a frameable address displays a frame');
    const frame = await page.eval(q('iframe', `({ src: e.src, title: e.title, sandbox: e.getAttribute('sandbox'),
        allow: e.getAttribute('allow') })`));
    check(frame.src === `http://${AIRFROG}/` && frame.title === AIRFROG, `the frame's address and title (${frame.src}, ${frame.title})`);
    check(frame.sandbox === SANDBOX, 'the frame has the extension frame\'s sandbox');
    check(frame.allow === ALLOW, 'the frame delegates the local network permissions');
    await page.until(frameLoaded, 10000);
    check(await page.eval(`window.frameMessages.some(m => m === 'frame http://${AIRFROG}')`),
        'the stand-in Airfrog\'s page loads and runs in the frame');
    check(await page.eval(`localStorage.getItem('airfrog-web-address')`) === AIRFROG, 'the address is saved');
    const bar = await page.eval(q('.web-bar', 'e.textContent'));
    check(bar === `${AIRFROG}Change address`, `the row has the host and Change address (${bar})`);
    check(await page.eval(`getComputedStyle(document.getElementById('footer')).display === 'none'`),
        'the site footer is hidden');
    check(await page.eval(`getComputedStyle(document.querySelector('h1')).display === 'none'`), 'the heading is hidden');
    const layout = await page.eval(`(() => {
        const f = document.querySelector('iframe').getBoundingClientRect();
        const header = document.querySelector('.site-head').getBoundingClientRect();
        const bar = document.querySelector('.web-bar').getBoundingClientRect();
        return { top: f.top, bottom: f.bottom, width: f.width, innerWidth, innerHeight, headerBottom: header.bottom,
            barBottom: bar.bottom, scroll: document.documentElement.scrollHeight };
    })()`);
    check(Math.abs(layout.bottom - layout.innerHeight) <= 1 && layout.width === layout.innerWidth
        && layout.top >= layout.barBottom - 1 && layout.barBottom > layout.headerBottom,
    `the frame fills the window below the header and the row (${JSON.stringify(layout)})`);
    check(layout.scroll <= layout.innerHeight, 'the window doesn\'t scroll');
    const hostLeft = await page.eval(`document.querySelector('.web-bar .host').getBoundingClientRect().left`);
    check(Math.abs(hostLeft - ((layout.innerWidth - 720) / 2 + 16)) <= 1,
        `the row lines up with the Airfrog interface (${hostLeft})`);
    const requested = stand.requests.filter(r => r === `${AIRFROG}/`);
    check(requested.length >= 2, `the probe and the frame both request the home page (${requested.length})`);

    // Two clicks on Connect in one task probe once and display one frame. The first disables the button.
    // requestSubmit() isn't used because it submits a form whose controls are disabled.
    page = await open(PAGE, `
        window.probes = 0;
        window.frames = 0;
        const realFetch = fetch;
        window.fetch = (url, ...rest) => (String(url) === 'http://${AIRFROG}/' && window.probes++, realFetch(url, ...rest));
        new MutationObserver((records) => {
            for (const r of records) for (const n of r.addedNodes) if (n.tagName === 'IFRAME') window.frames++;
        }).observe(document, { childList: true, subtree: true });`);
    await page.until(hasField, 10000);
    await page.eval(typeAddress(AIRFROG));
    await page.eval(`(() => { const b = document.querySelector('form button'); b.click(); b.click(); return true; })()`);
    await page.until(hasFrame, 10000);
    await sleep(1000);
    check(await page.eval('window.probes') === 1 && await page.eval('window.frames') === 1,
        `two clicks at once make one probe and display one frame (${await page.eval('window.probes')}, ${await page.eval('window.frames')})`);
    page = await open(PAGE);
    await page.until(hasField, 10000);
    await page.eval(typeAddress(AIRFROG));
    await page.eval(clickConnect, true);
    await page.until(hasFrame, 10000);

    // Change address
    await page.eval(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Change address').click(), true`, true);
    check(await page.eval(`!document.querySelector('iframe')`) && await page.eval(shown('input[name=address]')),
        'Change address removes the frame and displays the form');
    check(await page.eval(q('input[name=address]', 'e.value')) === AIRFROG, 'the field keeps the address');
    check(await page.eval(`getComputedStyle(document.getElementById('footer')).display !== 'none'`),
        'the site footer is displayed again');

    // A saved frameable address connects on a later visit without a click
    await page.navigate(PAGE);
    await page.until(hasFrame, 10000);
    check(await page.eval(q('iframe', 'e.src')) === `http://${AIRFROG}/`,
        'a saved frameable address connects when the page loads');
    // Enter in the field connects
    await page.eval(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Change address').click(), true`, true);
    await page.eval(`document.querySelector('input[name=address]').focus(), true`);
    await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.until(hasFrame, 10000);
    check(true, 'Enter in the field connects');
    // A pasted URL
    await page.eval(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Change address').click(), true`, true);
    await page.eval(typeAddress(`http://${AIRFROG}/index.html`));
    await page.eval(clickConnect, true);
    await page.until(hasFrame, 10000);
    check(await page.eval(q('.web-bar .host', 'e.textContent')) === AIRFROG, 'a pasted URL connects to its host and port');

    // An alias opens in the tab, from a click only
    page = await open(PAGE);
    await page.until(hasField, 10000);
    await page.eval(typeAddress(ALIAS));
    stand.requests.length = 0;
    const navigated = cdp.waitFor(m => m.sessionId === page.sessionId && m.method === 'Page.frameNavigated'
        && m.params.frame.url === `http://${ALIAS}/`, 10000);
    await page.eval(clickConnect, true);
    await navigated.then(() => check(true, 'Connect with an alias opens it in the tab'),
        () => check(false, 'Connect with an alias opens it in the tab'));
    check(stand.requests.includes(`${ALIAS}/`), 'the tab requests the home page by the alias');
    stand.requests.length = 0;
    await page.navigate(PAGE);
    await page.until(hasField, 10000);
    await sleep(1500);
    check(await page.eval(q('input[name=address]', 'e.value')) === ALIAS && await page.eval(`location.pathname === '/web/'`),
        'a saved alias fills the field when the page loads and the page stays');
    check(!stand.requests.some(r => r.startsWith(ALIAS) && !r.endsWith('/favicon.ico')),
        `a saved alias isn't requested when the page loads (${stand.requests})`);
    check(await page.eval(`!document.querySelector('iframe')`), 'a saved alias doesn\'t display a frame');

    // A browser without the permission opens the address in the tab, from a click only
    page = await open(PAGE, `navigator.permissions.query = () => Promise.reject(new TypeError('no'))`);
    await page.eval(`localStorage.setItem('airfrog-web-address', ${JSON.stringify(AIRFROG)}), true`);
    await page.navigate(PAGE);
    await page.until(hasField, 10000);
    await sleep(1000);
    check(await page.eval(`location.pathname === '/web/' && !document.querySelector('iframe')`),
        'without the permission a saved address fills the field and the page stays');
    const left = cdp.waitFor(m => m.sessionId === page.sessionId && m.method === 'Page.frameNavigated'
        && m.params.frame.url === `http://${AIRFROG}/`, 10000);
    await page.eval(clickConnect, true);
    await left.then(() => check(true, 'without the permission Connect opens the address in the tab'),
        () => check(false, 'without the permission Connect opens the address in the tab'));

    // The time allowed doesn't run while Chrome asks for the permission
    stand.delayMs = 7000;
    page = await open(PAGE, stubPermission('prompt'));
    await page.until(hasField, 10000);
    await page.eval(typeAddress(AIRFROG));
    await page.eval(clickConnect, true);
    await sleep(6500);
    check(await page.eval(message) === 'Connecting to Airfrog…', 'while the prompt is displayed, Connecting is displayed past the time allowed');
    await page.until(hasFrame, 10000);
    check(true, 'a response after the time allowed connects when the prompt was displayed');

    // The time allowed runs once the permission isn't being asked
    page = await open(PAGE, stubPermission('prompt', 'granted', 1000));
    await page.until(hasField, 10000);
    await page.eval(typeAddress(AIRFROG));
    await page.eval(clickConnect, true);
    await page.until(`/^No response from/.test(document.querySelector('.msg').textContent)`, 15000);
    check(await page.eval(`!document.querySelector('iframe')`),
        'when the permission changes the time allowed starts, and a later response fails');
    stand.delayMs = 0;

    // The frame-ancestors header
    // Chrome reports a frame the response's header refuses as a failed document.
    const refusals = (page) => {
        const found = [];
        cdp.on(m => m.sessionId === page.sessionId && m.method === 'Network.loadingFailed'
            && m.params.type === 'Document' && found.push(m.params.errorText));
        return found;
    };
    for (const [header, refused, what] of [['frame-ancestors https://example.com', true, 'another site\'s frame-ancestors header'],
        [AIRFROG_HEADER, false, 'Airfrog\'s header']]) {
        stand.header = header;
        page = await open(PAGE);
        await page.call('Network.enable');
        const found = refusals(page);
        await page.until(hasField, 10000);
        await page.eval(typeAddress(AIRFROG));
        await page.eval(clickConnect, true);
        await page.until(hasFrame, 10000);
        await sleep(1500);
        const loaded = await page.eval(frameLoaded);
        check(refused ? !loaded && found.join() === 'net::ERR_BLOCKED_BY_RESPONSE' : loaded && found.length === 0,
            `${what} ${refused ? 'refuses' : 'lets a page on 127.0.0.1 load'} the frame (${found})`);
    }
} catch (e) {
    failures++;
    process.stdout.write(`FAIL ${e.message}\n`);
} finally {
    cdp.close();
    chrome.kill();
    site.kill();
    airfrog.close();
    airfrog.closeAllConnections();
    await sleep(300);
    fs.rmSync(profile, { recursive: true, force: true });
}
process.stdout.write(failures ? `${failures} FAILED\n` : 'all passed\n');
process.exit(failures ? 1 : 0);
