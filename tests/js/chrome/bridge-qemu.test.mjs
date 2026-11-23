// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// A page on onerom.org programs a target through Airfrog's window in
// headless Chrome, against QEMU Airfrog offering PICOBOOT_RP2350_SWD, without
// and with a password.
//
// Usage: node tests/js/chrome/bridge-qemu.test.mjs ADDRESS:PORT
//   ADDRESS:PORT  QEMU Airfrog (ci/qemu.sh --serve), for example
//                 127.0.0.1:18080. Its host aliases are set to 127.0.0.1 and
//                 its password is cleared at the end.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from './harness.mjs';

const airfrog = process.argv[2];
const ADMIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'airfrog_admin.py');
const admin = (...args) => execFileSync('python3', [ADMIN, airfrog, ...args], { encoding: 'utf8' }).trim();

let failures = 0;
const check = (ok, what) => {
    if (!ok) failures++;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${what}\n`);
};

admin('airfrog', '-', 'set-aliases', '127.0.0.1');
const browser = await start({ airfrog });
const { cdp, bridgeHost } = browser;
const BRIDGE_PAGE = `http://${bridgeHost}/`;

async function connect(site, passwords) {
    const popup = cdp.popup(BRIDGE_PAGE);
    check(await site.eval(`test.connect('${bridgeHost}')`, true) === 'opening', 'connectBridge() from a click');
    const bridge = await popup;
    await bridge.until("typeof window.bridgeStarted === 'object'");
    for (const password of passwords) {
        await bridge.until(`!document.querySelector('#bridge-login').hidden`).catch(async (e) => {
            const status = await bridge.eval(`document.body.innerText + ' | ' + location.href`).catch(err => err.message);
            throw new Error(`${e.message}: ${status} ${bridge.console.join('; ')}`);
        });
        await bridge.eval(`document.querySelector('#bridge-password').value = ${JSON.stringify(password)};
            document.querySelector('#bridge-login').requestSubmit(); true`);
        await new Promise(r => setTimeout(r, 1500));
    }
    // The first connection asks to allow onerom.org, which isn't authorised yet.
    await bridge.until(`!/Connecting|Logging in/.test(document.getElementById('bridge-status').textContent)`);
    const asked = await bridge.eval(`document.getElementById('bridge-status').textContent`);
    if (asked === `Allow onerom.org to connect to ${bridgeHost}?`) {
        check(true, `asks to allow onerom.org (${asked})`);
        await bridge.eval(`document.getElementById('bridge-button').click(); true`);
    }
    return bridge;
}

try {
    const site = await cdp.open('https://onerom.org/__test/site.html');
    await site.until('window.ready');

    // Without a password
    let bridge = await connect(site, []);
    check(await site.eval('window.connecting') === 'connected', 'connected through Airfrog\'s window');
    const siteLine = await bridge.eval(`document.querySelector('#bridge-status > div').textContent`);
    check(siteLine === `onerom.org is connected to ${bridgeHost}.`, `bridge displays the website (${siteLine})`);
    const r = await site.eval('test.program(0x10010000, 64 * 1024)');
    check(r.match, `programmed and read 64 KB through the bridge (write ${r.writeMs} ms, read ${r.readMs} ms)`);

    await bridge.eval(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Disconnect').click(); true`);
    await site.until('window.closes.length');
    const closes = await site.eval('window.closes');
    check(closes[0] === `The ${bridgeHost} window ended the connection.`, `Disconnect reaches the page (${closes[0]})`);

    // With a password
    admin('127.0.0.1', '-', 'set-password', 'frogpass');
    bridge = await connect(site, ['frogpass']);
    check(await site.until('window.connecting.then(v => v)', 15000) === 'connected', 'logged in in Airfrog\'s window');
    const r2 = await site.eval('test.program(0x10020000, 16 * 1024)');
    check(r2.match, `programmed and read 16 KB with a password (write ${r2.writeMs} ms, read ${r2.readMs} ms)`);
    await site.eval('window.airfrog.close(); true');
    await new Promise(r => setTimeout(r, 500));
    const targets = await cdp.send('Target.getTargets');
    check(!targets.targetInfos.some(t => t.targetId === bridge.targetId), 'close() closes Airfrog\'s window');

    // A wrong password asks again
    const wrong = await connect(site, ['wrong']);
    const lastLine = `(s => s !== 'Logging in…' && s)([...document.querySelectorAll('#bridge-status > div')].at(-1)?.textContent)`;
    const status = await wrong.until(lastLine);
    check(status === 'Incorrect password.', `a wrong password asks again (${status})`);

    // Wrong passwords back to back are blocked
    const submit = (password) => wrong.eval(`document.querySelector('#bridge-password').value = ${JSON.stringify(password)};
        document.querySelector('#bridge-login').requestSubmit(); true`);
    let blocked = status;
    for (let i = 0; i < 4 && !/^Too many/.test(blocked); i++) {
        await wrong.until(`!document.querySelector('#bridge-login').hidden`);
        await submit('wrong');
        blocked = await wrong.until(lastLine);
    }
    check(/^Too many failed login attempts\. Retry in \d+ seconds?\.$/.test(blocked), `a blocked login displays when to retry (${blocked})`);

    // The right password once the block ends, then the password changes
    await new Promise(r => setTimeout(r, 3000));
    await wrong.until(`!document.querySelector('#bridge-login').hidden`);
    await submit('frogpass');
    check(await site.until('window.connecting.then(v => v)', 15000) === 'connected', 'logs in after the block ends');
    const closesBefore = (await site.eval('window.closes')).length;
    admin('127.0.0.1', 'frogpass', 'set-password', 'toadpass');
    await site.until(`window.closes.length > ${closesBefore}`);
    const changed = (await site.eval('window.closes')).at(-1);
    check(changed === `${bridgeHost}'s password was changed.`, `a password change reaches the page (${changed})`);
    admin('127.0.0.1', 'toadpass', 'clear-password');
    await wrong.eval('window.close(); true').catch(() => {});

    const errors = [...site.console, ...bridge.console, ...wrong.console].filter(l => /EXCEPTION/.test(l));
    check(errors.length === 0, `no exceptions ${errors.join('; ')}`);
} finally {
    try {
        admin('127.0.0.1', 'frogpass', 'clear-password');
    } catch (e) {
        // No password was set
    }
    await browser.stop();
}

process.stdout.write(failures ? `${failures} FAILED\n` : 'all passed\n');
process.exit(failures ? 1 : 0);
