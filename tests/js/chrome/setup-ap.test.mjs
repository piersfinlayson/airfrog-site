// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// AP mode kept on after Airfrog joins its network, in headless
// Chrome: Airfrog's full user interface (build/test-deps/ui/ui.js) with Airfrog's
// internal JS setup module (build/test-deps/setup/setup.js) against tests/ui's fake
// Airfrog, opened through AP mode. The WiFi card displays Airfrog's new
// address, and Stop AP mode sends WIFI_AP_STOP.
//
// Run ci/test-deps.sh first.
//
// Usage: node tests/js/chrome/setup-ap.test.mjs
//   CHROME  Chrome's path (default: macOS's)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 18766;

let failures = 0;
const check = (ok, what) => {
    if (!ok) failures++;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${what}\n`);
};

const server = spawn(process.execPath, [path.join(ROOT, 'tests/ui/browser/serve.mjs'), String(PORT)],
    { stdio: 'ignore' });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-ap-'));
const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
let port = null;
for (let i = 0; i < 100 && !port; i++) {
    await new Promise(r => setTimeout(r, 100));
    try {
        port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
    } catch (e) {
        // Not written yet
    }
}
const cdp = await Cdp.connect(`ws://127.0.0.1:${port[0]}${port[1]}`);
const text = `document.querySelector('main').innerText`;

try {
    // Through AP mode, with Airfrog joined.
    const page = await cdp.open(`http://127.0.0.1:${PORT}/tests/ui/browser/?ap&apip=127.0.0.1#network`);
    await page.until(`/Airfrog joined home/.test(${text})`, 15000);
    const href = await page.eval(`[...document.querySelectorAll('#ap-notice a')].map(a => a.href).join()`);
    check(href === 'http://192.168.1.50/', `displays Airfrog's new address as a link (${href})`);
    const notice = await page.eval(`document.getElementById('ap-notice').firstChild.textContent`);
    check(notice === "Airfrog joined home. This page uses Airfrog's AP mode, which will be disabled in 2 minutes. "
        + 'Open http://192.168.1.50/ on home.', `the notice's text (${notice})`);
    check(await page.eval(`document.getElementById('ap-notice').firstChild.getAttribute('role')`) === 'status',
        'the notice is a status line');
    await page.eval(`window.m1Link = document.querySelector('#ap-notice a'); true`);
    await new Promise(r => setTimeout(r, 3000));
    check(await page.eval(`document.querySelector('#ap-notice a') === window.m1Link`),
        'the notice is kept, not replaced, while its text is unchanged');
    await page.eval(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Stop AP mode').click(); true`);
    await page.until(`/AP mode stopped/.test(${text})`, 10000);
    check(await page.eval('window.fake.received.some(m => m.type === 0x10 && m.payload[0] === 0x13)'),
        'Stop AP mode sends WIFI_AP_STOP');
    check(await page.eval(`[...document.querySelectorAll('.card:not(#ap-notice) a')].some(a => a.href === 'http://192.168.1.50/')`),
        'the status line keeps the address as a link');

    // Through a name, airfrog.local for example, which AP mode resolves too.
    const named = await cdp.open(`http://localhost:${PORT}/tests/ui/browser/?ap#network`);
    await named.until(`/Airfrog joined home/.test(${text})`, 15000);
    check(true, 'through a name: the notice');

    // At Airfrog's address on its network the notice isn't displayed.
    const other = await cdp.open(`http://127.0.0.1:${PORT}/tests/ui/browser/?ap&staip=127.0.0.1#network`);
    await other.until(`/AP mode/.test(${text})`, 15000);
    check(await other.eval(`document.getElementById('ap-notice').hidden`), "at the network's address: no notice");
    check(page.console.every(l => !l.startsWith('EXCEPTION')), `no exceptions ${page.console.join(' | ')}`);
} catch (e) {
    failures++;
    process.stdout.write(`FAIL ${e.message}\n`);
} finally {
    cdp.close();
    chrome.kill();
    server.kill();
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(profile, { recursive: true, force: true });
}
process.stdout.write(failures ? `${failures} FAILED\n` : 'all passed\n');
process.exit(failures ? 1 : 0);
