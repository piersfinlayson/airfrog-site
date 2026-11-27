// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Airfrog's internal JS setup module as bundled (ci/build-setup.sh) over serial in headless Chrome,
// against tests/commissioning's fake Airfrog: it reads the settings, saves a
// hostname, keeps the saved WiFi password, scans, sets the password and
// saves the target settings, as on airfrog.org/commissioning. Then a failed
// join's status, and the saved static settings while Airfrog isn't connected.
//
// Usage: node tests/js/chrome/setup-serial.test.mjs
//   CHROME  Chrome's path (default: macOS's)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp } from './harness.mjs';
import { PASSWORD, PASSWORD_RULE } from '../../../js/messages.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };

let failures = 0;
const check = (ok, what) => {
    if (!ok) failures++;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${what}\n`);
};

const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end();
        return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
        .end(fs.readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-serial-'));
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

/** Clicks the button with this text in the card with this title. */
const click = (title, text) => `(() => { const card = [...document.querySelectorAll('section.card')]
    .find(c => c.querySelector('h2')?.textContent === ${JSON.stringify(title)});
    [...card.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(text)}).click(); return true; })()`;
const msgOf = (title) => `[...[...document.querySelectorAll('section.card')]
    .find(c => c.querySelector('h2')?.textContent === ${JSON.stringify(title)}).querySelectorAll('.msg')]
    .map(m => m.textContent).join(' ')`;

try {
    const page = await cdp.open(`http://127.0.0.1:${server.address().port}/tests/commissioning/browser/setup-serial.html`);
    await page.until('window.ready', 15000);
    const read = await page.eval(`({ hostname: document.querySelector('input[name=hostname]').value,
        ssid: document.querySelector('input[name=ssid]').value,
        password: document.querySelector('input[name=password]').value,
        serial: document.body.innerText.includes('4146240AC4010203') })`);
    check(read.hostname === 'bench' && read.ssid === 'bench-net' && read.password === '********' && read.serial,
        `reads Airfrog's settings over serial (${JSON.stringify(read)})`);

    await page.eval(`(() => { const i = document.querySelector('input[name=hostname]'); i.value = 'workshop';
        i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await page.eval(click('Hostname', 'Save'));
    await page.until(`/Hostname changed/.test(${msgOf('Hostname')})`);
    check(await page.eval('window.fake.hostname') === 'workshop', 'saves the hostname over serial');
    await page.until(`window.setup.state.hostname === 'workshop'`, 5000);
    check(true, 'then reads the hostname back');

    const saveAndConnect = `[...document.querySelectorAll('button')].find(b => b.textContent === 'Save and connect')`;
    check(await page.eval(`${saveAndConnect}.disabled`), 'Save and connect is disabled until a field changes');
    await page.eval(`(() => { const i = document.querySelector('input[name=password]'); i.value = 'new-secret';
        i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    check(!await page.eval(`${saveAndConnect}.disabled`), 'then enabled');
    await page.eval(click('Join a network', 'Save and connect'));
    await page.until(`/joining/.test(${msgOf('Join a network')})`);
    const wifi = await page.eval('({ ...window.fake.wifi, ipv4: null })');
    check(wifi.ssid === 'bench-net' && wifi.password === 'new-secret',
        `saves the network with the new WiFi password (${JSON.stringify(wifi)})`);
    await page.until(`/Connected/.test(document.querySelector('.card .pill:not([hidden])')?.textContent)`, 15000);
    check(true, 'reads the WiFi state again while Airfrog joins');
    await page.until(`window.setup.state.joining === null && !/joining/.test(${msgOf('Join a network')})`, 15000);
    check(true, 'once joined, the network is no longer being joined and the message clears');

    await page.eval(click('Join a network', 'Scan'));
    await page.until(`!document.querySelector('ul.nets').hidden`, 15000);
    const nets = await page.eval(`[...document.querySelectorAll('ul.nets li')].map(li => li.textContent + (li.querySelector('.padlock') ? ' (padlock)' : ''))`);
    check(nets.length === 3 && nets[0] === 'bench-net (padlock)' && nets[2] === 'corp-netNot supported',
        `scans over serial (${nets.join(', ')})`);

    check(await page.eval(`document.body.innerText.includes(${JSON.stringify(PASSWORD_RULE.INTRO)})
        && document.querySelectorAll('.rule li').length > 0`), 'the password rule is displayed');
    await page.eval(`(() => { const f = document.querySelector('input[name=repeat]').form;
        f.password.value = 'frog pw'; f.repeat.value = 'frog pw'; f.requestSubmit(); return true; })()`);
    await page.until(`[...document.querySelectorAll('section.card')].find(c => c.querySelector('h2')?.textContent
        === ${JSON.stringify(PASSWORD.TITLE)}).querySelector('.rule-intro.bad')?.textContent
        === ${JSON.stringify(PASSWORD_RULE.NOT_MET)}`, 5000);
    check(!await page.eval('window.fake.password'), "a password that doesn't follow the rule isn't sent");
    await page.eval(`(() => { const f = document.querySelector('input[name=repeat]').form;
        f.password.value = 'Frog pw 1'; f.repeat.value = 'Frog pw 1'; f.requestSubmit(); return true; })()`);
    await page.until(`/Password set/.test(${msgOf('Password')})`, 20000);
    check(Boolean(await page.eval('window.fake.password')), 'sets the password over serial, without login');
    check(await page.eval(`(i => i.textContent === ${JSON.stringify(PASSWORD_RULE.INTRO)} && !i.classList.contains('bad'))(
        document.querySelector('.rule-intro'))`), 'the rule\'s intro is back once the password follows it');
    check(await page.eval(`document.body.innerText.includes('Password set.')`), 'then displays Password set.');

    check(await page.eval(`(b => !b.checked && !b.disabled)(document.querySelector('input[name=recovery]'))`)
        && await page.eval(`!document.body.innerText.includes('Airfrog recovery can be turned on only')`),
    'recovery through the target is off by default, and can be turned on over serial');
    await page.eval(`(() => { const i = document.querySelector('input[name=changeCheckMs]'); i.value = '500';
        i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('input[name=recovery]').click();
        return true; })()`);
    await page.eval(click('Target settings', 'Save'));
    await page.until(`/Saved/.test(${msgOf('Target settings')})`);
    const settings = await page.eval('window.fake.settings');
    check(settings.changeCheckMs === 500 && settings.flags === 1,
        `saves the target settings with recovery turned on (${JSON.stringify(settings)})`);

    // The Authorised websites card, as on airfrog.org/commissioning
    const WEBSITES = 'Authorised websites';
    const CARD_JS = `[...document.querySelectorAll('section.card')].find(c => c.querySelector('h2')?.textContent
        === ${JSON.stringify(WEBSITES)})`;
    const rowsOf = `[...[...document.querySelectorAll('section.card')].find(c => c.querySelector('h2')?.textContent
        === ${JSON.stringify(WEBSITES)}).querySelectorAll('tr')].map(r => r.cells[0].textContent).join()`;
    const typeWebsite = (v) => `(() => { const i = document.querySelector('input[name=website]');
        i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
    check(await page.eval(`document.body.innerText.includes('None.')`) && await page.eval(rowsOf) === '',
        'Authorised websites: None. while empty');
    await page.eval(typeWebsite('OneROM.org'));
    await page.eval(click(WEBSITES, 'Add'));
    await page.until(`${rowsOf} === 'onerom.org'`, 5000);
    check(JSON.stringify(await page.eval('window.fake.websites')) === '["https://onerom.org"]',
        'Add saves a website typed without a scheme as https, displayed without https://');
    await page.eval(typeWebsite('http://127.0.0.1:18091'));
    await page.eval(click(WEBSITES, 'Add'));
    await page.until(`${rowsOf} === 'onerom.org,http://127.0.0.1:18091'`, 5000);
    check(true, 'an http website is displayed in full');
    check(await page.eval(`[...document.querySelectorAll('tr button')].every(b => b.className === 'danger')`),
        'Revoke is red');
    await page.eval(typeWebsite('https://onerom.org'));
    await page.eval(click(WEBSITES, 'Add'));
    await page.until(`/already/.test(${msgOf(WEBSITES)})`, 5000);
    check(await page.eval(msgOf(WEBSITES)) === 'onerom.org is already authorised.', 'already authorised');
    await page.eval(typeWebsite('onerom.org/web'));
    await page.eval(click(WEBSITES, 'Add'));
    check(await page.eval(msgOf(WEBSITES)) === 'Invalid website onerom.org/web. Use a host name or IP address with '
        + 'optional http(s):// and :port.', 'an invalid website');
    await page.eval("window.fake.websites = ['https://a.org', 'https://b.org', 'https://c.org', 'https://d.org', "
        + "'https://e.org', 'https://f.org', 'https://g.org', 'https://h.org']");
    await page.eval(typeWebsite('i.org'));
    await page.eval(click(WEBSITES, 'Add'));
    await page.until(`/Too many/.test(${msgOf(WEBSITES)})`, 5000);
    check(await page.eval(msgOf(WEBSITES)) === 'Too many authorised websites. Maximum 8.'
        && (await page.eval(rowsOf)).split(',').length === 8, 'a full list and the list read again');
    // Revoke asks first: the prompt, then its own Revoke or Cancel.
    const revokeRow = (site) => page.eval(`(() => { [...document.querySelectorAll('tr')]
        .find(r => r.cells[0].textContent === ${JSON.stringify(site)}).querySelector('button').click(); return true; })()`);
    const promptOf = `(p => p && !p.hidden ? [p.firstChild.textContent, ...[...p.querySelectorAll('button')]
        .map(b => b.textContent + (b.className ? '/' + b.className : '') + (b === document.activeElement ? '/focus' : ''))].join('|')
        : null)(${CARD_JS}.querySelector('.prompt'))`;
    const answer = (label) => page.eval(`(() => { [...${CARD_JS}.querySelectorAll('.prompt button')]
        .find(b => b.textContent === ${JSON.stringify(label)}).click(); return true; })()`);
    await revokeRow('c.org');
    check(await page.eval(promptOf) === 'Are you sure you want to revoke c.org?|Revoke/danger|Cancel/cancel/focus',
        `Revoke asks first, with Cancel focused: ${await page.eval(promptOf)}`);
    await answer('Cancel');
    await new Promise(r => setTimeout(r, 300));
    check(await page.eval(promptOf) === null && (await page.eval('window.fake.websites')).includes('https://c.org'),
        'Cancel keeps the website');
    await revokeRow('c.org');
    await page.eval(typeWebsite('z.org'));
    await page.eval(click(WEBSITES, 'Add'));
    check(await page.eval(promptOf) === null, 'Add closes the prompt');
    await page.until(`/Too many/.test(${msgOf(WEBSITES)})`, 5000);
    await revokeRow('d.org');
    await page.eval("window.fake.websites = window.fake.websites.filter(w => w !== 'https://d.org')");
    await page.eval("window.setup.reload('websites').then(() => true)");
    check(await page.eval(promptOf) === null && !(await page.eval(rowsOf)).includes('d.org'),
        'a list read without the website closes its prompt');
    await page.eval("window.fake.websites = window.fake.websites.filter(w => w !== 'https://b.org')");
    await revokeRow('b.org');
    await answer('Revoke');
    await page.until(`!${rowsOf}.includes('b.org')`, 5000);
    check(await page.eval(msgOf(WEBSITES)) === '', 'Revoke of a website already revoked refreshes without an error');
    await revokeRow('a.org');
    await answer('Revoke');
    await page.until(`!${rowsOf}.includes('a.org')`, 5000);
    check(!(await page.eval('window.fake.websites')).includes('https://a.org') && await page.eval(msgOf(WEBSITES)) === '',
        'Revoke removes the website');
    check(page.console.every(l => !l.startsWith('EXCEPTION')), `no exceptions ${page.console.join(' | ')}`);

    const failed = await cdp.open(`http://127.0.0.1:${server.address().port}/tests/commissioning/browser/setup-serial.html?fail=1`);
    await failed.until('window.ready', 15000);
    const form = await failed.eval(`(f => [f.staticIpv4.checked, f.address.value, f.netmask.value, f.gateway.value,
        f.dns.value].join())(document.querySelector('input[name=address]').form.elements)`);
    check(form === 'true,192.168.1.60,255.255.255.0,192.168.1.254,',
        `not connected: the form displays the saved static settings (${form})`);
    await failed.until(`/Network not found/.test(document.querySelector('.card .pill:not([hidden])')?.textContent)`, 15000);
    check(true, 'a failed join displays Network not found');
} catch (e) {
    failures++;
    process.stdout.write(`FAIL ${e.message}\n`);
} finally {
    cdp.close();
    chrome.kill();
    server.close();
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(profile, { recursive: true, force: true });
}
process.stdout.write(failures ? `${failures} FAILED\n` : 'all passed\n');
process.exit(failures ? 1 : 0);
