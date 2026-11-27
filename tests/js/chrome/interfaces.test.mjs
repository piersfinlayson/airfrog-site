// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// What each interface allows, in headless Chrome: Airfrog's internal JS setup
// module (build/test-deps/setup/setup.js), alone as Airfrog's setup and in
// Airfrog's full user interface (build/test-deps/ui/ui.js), against
// tests/ui's fake Airfrog reporting each interface in HELLO. First setup over
// the access point, the forgotten password over the recovery button's access
// point, the access point's name and password, recovery through the target,
// unsigned and older firmware, unsigned extensions, and the full user
// interface's check of the firmware's manifest address and release keys.
//
// Run ci/test-deps.sh first.
//
// Usage: node tests/js/chrome/interfaces.test.mjs
//   CHROME  Chrome's path (default: macOS's)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp } from './harness.mjs';
import { BACKUP_KEY, OTHER_KEY, signedFile } from '../../ui/minisign.mjs';
import { IMAGE_MODEL_OFFSET, Model, encodeExtImage } from '../../../build/test-deps/schema/js/schema.js';
import {
    CONNECTION, EXTENSIONS, HOME_PAGE, NETWORK, PASSWORD, PASSWORD_RULE, TARGET_SETTINGS, UPDATE, WIFI_AP,
} from '../../../js/messages.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 18769;
const PAGE = `http://127.0.0.1:${PORT}/tests/ui/browser/`;
const STATION = 0, AP = 2, AP_FIRST_SETUP = 3, AP_BUTTON = 4;

let failures = 0;
const check = (ok, what) => {
    if (!ok) failures++;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${what}\n`);
};

const server = spawn(process.execPath, [path.join(ROOT, 'tests/ui/browser/serve.mjs'), String(PORT)],
    { stdio: 'ignore' });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'interfaces-'));
const files = fs.mkdtempSync(path.join(os.tmpdir(), 'interfaces-files-'));
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
const ready = `(c => c && !c.hidden && !c.inert)(document.querySelector('.content'))
    && /^v/.test(document.getElementById('firmware-version')?.textContent ?? '')`;
const loginCard = `[...document.querySelectorAll('section.card')].find(c => c.querySelector('h2')?.textContent === 'Log in')`;
const loginShown = `(c => c && !c.hidden)(${loginCard})`;
const apNotice = `(c => c && !c.hidden)(document.getElementById('access-point'))`;
const noticeText = `document.getElementById('access-point').textContent`;
const click = (label) => `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)}
    && b.offsetParent).click(), true`;
/** The card titled title. */
const card = (title) => `[...document.querySelectorAll('section.card')].find(c => c.querySelector('h2')?.textContent
    === ${JSON.stringify(title)})`;
/** Fills the named fields of the form containing the first, then submits it. */
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
const fake = (expression) => `(f => ${expression})(window.fake)`;
const fileCheck = `document.querySelector('.file-check').textContent`;
/**
 * Chooses an Airfrog firmware file of version, signed by serve.mjs when signed:
 * with test key signed when it is a name, otherwise with 'release'.
 */
const chooseFirmware = (version, signed) => `(async () => {
    let image = new Uint8Array(2000);
    image[0] = 0xE9;
    image[1] = 1;
    new DataView(image.buffer).setUint32(28, 2000 - 48, true);
    new DataView(image.buffer).setUint16(${IMAGE_MODEL_OFFSET}, ${Model.MINI}, true);
    new DataView(image.buffer).setUint32(32, 0xABCD5432, true);
    image.set(new TextEncoder().encode(${JSON.stringify(version)}), 48);
    image.set(new TextEncoder().encode('airfrog'), 80);
    if (${Boolean(signed)}) {
        const key = ${JSON.stringify(typeof signed === 'string' ? signed : 'release')};
        image = new Uint8Array(await (await fetch('/sign-file?key=' + key, { method: 'POST', body: image })).arrayBuffer());
    }
    const files = new DataTransfer();
    files.items.add(new File([image], 'airfrog-mini.bin'));
    const input = document.querySelector('input[type=file][accept=".bin"]');
    input.files = files.files;
    input.dispatchEvent(new Event('change'));
    return true;
})()`;

/** An extension image without a module, and its signed file, in files. */
function extensionFiles() {
    const encoder = new TextEncoder();
    const metadata = encoder.encode(JSON.stringify({ name: 'signed-test', display_name: 'Signed Test', version: '1.0.0',
        description: 'A test', author: 'Ada', firmware: [] }));
    const head = encodeExtImage({ magic: 'AFXI', model: 0, wamr: [0, 0, 0], metadataOffset: 0, metadataLen: 0,
        moduleOffset: 0, moduleLen: 0, name: 'signed-test' }).length;
    const image = new Uint8Array(head + metadata.length);
    image.set(encodeExtImage({ magic: 'AFXI', model: 0, wamr: [0, 0, 0], metadataOffset: head,
        metadataLen: metadata.length, moduleOffset: head + metadata.length, moduleLen: 0, name: 'signed-test' }));
    image.set(metadata, head);
    const signed = path.join(files, 'signed-test.bin');
    fs.writeFileSync(signed, signedFile(image));
    return signed;
}

/** Sets the Extensions tab's file input to file. */
async function installFile(page, file) {
    const { root } = await page.call('DOM.getDocument', { depth: 0 });
    const { nodeId } = await page.call('DOM.querySelector', { nodeId: root.nodeId,
        selector: 'input[type=file][accept=".afx,.bin"]' });
    await page.call('DOM.setFileInputFiles', { nodeId, files: [file] });
}

try {
    // First setup over the access point: the password first, then the home network.
    const first = await cdp.open(`${PAGE}?fallback=x&via=${AP_FIRST_SETUP}&sta=0&ap&open&ssid=`);
    await first.until(`!document.getElementById('first-setup').hidden`, 15000);
    check(await first.eval(`document.querySelector('nav.tabs').hidden && document.querySelector('.content').hidden`),
        'first setup: the password screen replaces the tabs');
    check(await first.eval(`/${PASSWORD.FIRST_SETUP.replace('.', '\\.')}/.test(${text})
        && ${text}.includes(${JSON.stringify(PASSWORD_RULE.INTRO)})
        && document.querySelectorAll('#first-setup .rule li').length === 4`), 'first setup: its note and the password rule as a list');
    check(await first.eval(`[...document.querySelectorAll('section.card.warn')].every(c => c.hidden || !c.offsetParent)`),
        'first setup: no warning card above it');
    check(await first.eval(apNotice) && await first.eval(noticeText) === HOME_PAGE.ACCESS_POINT,
        'first setup: the access point notice');
    await first.eval(submit({ password: 'frogpond', repeat: 'frogpond' }));
    await first.until(`document.querySelector('#first-setup .rule-intro.bad')?.textContent === ${JSON.stringify(PASSWORD_RULE.NOT_MET)}
        && document.querySelectorAll('#first-setup .rule li').length === 4`,
        5000);
    check(await first.eval(fake('f.key === null')), "a password that doesn't follow the rule isn't sent");
    await first.eval(submit({ password: 'Frog pond 1', repeat: 'Frog pond 1' }));
    await first.until(`document.getElementById('first-setup').hidden && ${loginShown}`, 15000);
    check(await first.eval(`${loginCard}.querySelector('.msg.ok')?.textContent`) === CONNECTION.PASSWORD_SAVED,
        'first setup: the login card asks to log in with the new password');
    check(await first.eval(fake('f.key && f.key.every((b, i) => b === f.sentKey[i])')),
        'first setup: SET_PASSWORD with the key in the clear');
    await first.eval(submit({ password: 'Frog pond 1' }));
    await first.until(ready, 15000);
    check(await first.eval(fake('f.closes.includes(4003)')), 'Airfrog closed the connection after SET_PASSWORD');
    await first.eval(click('Advanced'));
    check(await first.eval(`(b => !b.disabled && !b.checked)(document.querySelector('input[name=recovery]'))`),
        'first setup: recovery is off and can be turned on');
    await first.eval(`document.querySelector('input[name=recovery]').click(), true`);
    await first.until(`!${card(TARGET_SETTINGS.TITLE)}.querySelector('button.primary').disabled`, 5000);
    await first.eval(`${card(TARGET_SETTINGS.TITLE)}.querySelector('button.primary').click(), true`);
    await first.until(fake('(f.settings.flags & 1) === 1'), 5000);
    check(true, 'first setup: turning recovery on is saved');
    await first.eval(click('Network'));
    check(await first.eval(`!${card(WIFI_AP.TITLE)}.hidden && document.querySelector('input[name=apSsid]').value`)
        === 'airfrog-1a2b', "over the access point: the Access point card with the access point's name");
    await first.eval(submit({ apSsid: 'bench-ap', apPassword: 'short' }));
    await first.until(`${text}.includes(${JSON.stringify(WIFI_AP.INVALID_PASSWORD)})`, 5000);
    check(await first.eval(fake("f.apSsid === 'airfrog-1a2b'")), "an access point password that's too short isn't sent");
    await first.eval(submit({ apSsid: 'bench-ap', apPassword: 'apsecret1' }));
    await first.until(`${text}.includes(${JSON.stringify(WIFI_AP.SAVED)})`, 5000);
    check(await first.eval(fake("f.apSsid === 'bench-ap' && f.apPassword === 'apsecret1' && f.closes.includes(4006)")),
        'SET_WIFI_AP saves the name and password, and Airfrog closes the connection');

    // The home network: recovery can't be turned on, and the access point isn't displayed.
    const station = await cdp.open(`${PAGE}?fallback=x&via=${STATION}&ap`);
    await station.until(ready, 15000);
    check(await station.eval(`!(${apNotice})`), 'over the home network: no access point notice');
    await station.eval(click('Advanced'));
    check(await station.eval(`document.querySelector('input[name=recovery]').disabled`)
        && await station.eval(`${text}.includes(${JSON.stringify(TARGET_SETTINGS.RECOVERY_NOT_HERE)})`),
    'over the home network: the recovery checkbox is disabled, with why');
    await station.eval(click('Network'));
    check(await station.eval(`${card(WIFI_AP.TITLE)}.hidden`), 'over the home network: no Access point card');
    const apRow = await station.eval(`[...document.querySelectorAll('dt')].find(d => d.textContent.startsWith('AP mode'))
        .nextElementSibling.textContent`);
    check(apRow === '192.168.4.1', `over the home network: the AP mode row without the access point's name (${apRow})`);
    await station.eval(click('System'));
    await station.eval(chooseFirmware('0.2.9', false));
    await station.until(`document.querySelector('.file-check .cross')`, 5000);
    check(await station.eval(fileCheck) === UPDATE.UNSIGNED_NOT_HERE, 'over the home network: unsigned firmware, why');
    await station.eval(chooseFirmware('0.1.0', true));
    await station.until(`${fileCheck} === ${JSON.stringify(UPDATE.OLDER_NOT_HERE('v0.2.0'))}`, 5000);
    check(true, 'over the home network: older firmware, why');
    check(await station.eval(fake('!f.received.some(m => m.type === 0x10 && m.payload[0] === 0x0E)')),
        'neither is sent');

    // Turning recovery off works on every connection.
    const off = await cdp.open(`${PAGE}?fallback=x&via=${STATION}&recovery`);
    await off.until(ready, 15000);
    await off.eval(click('Advanced'));
    check(await off.eval(`(b => !b.disabled && b.checked)(document.querySelector('input[name=recovery]'))`)
        && await off.eval(`!${text}.includes(${JSON.stringify(TARGET_SETTINGS.RECOVERY_NOT_HERE)})`),
    'over the home network with recovery on: the checkbox is enabled');
    await off.eval(`document.querySelector('input[name=recovery]').click(), true`);
    await off.until(`!${card(TARGET_SETTINGS.TITLE)}.querySelector('button.primary').disabled`, 5000);
    await off.eval(`${card(TARGET_SETTINGS.TITLE)}.querySelector('button.primary').click(), true`);
    await off.until(fake('(f.settings.flags & 1) === 0'), 5000);
    check(true, 'turning recovery off is saved');
    await off.until(`document.querySelector('input[name=recovery]').disabled`, 5000);
    check(true, 'once off, it is disabled again');

    // The access point after first setup: the name and password, but not recovery.
    const ap = await cdp.open(`${PAGE}?fallback=x&via=${AP}&ap`);
    await ap.until(ready, 15000);
    check(await ap.eval(`document.querySelector('input[name=recovery]').disabled`),
        'over the access point after first setup: recovery is disabled');
    await ap.eval(click('Network'));
    check(await ap.eval(`!${card(WIFI_AP.TITLE)}.hidden`), 'over the access point: the Access point card');
    await ap.eval(submit({ ssid: 'home2', password: 'wifisecret' }));
    await ap.until(`${card(NETWORK.JOIN_TITLE)}.innerText.includes(${JSON.stringify(PASSWORD.FIRST_SETUP)})`, 5000);
    check(await ap.eval(fake('f.wifi === null')),
        'over the access point without a password: a home network displays why a password is needed, and nothing is sent');

    // Over the access point nothing is downloaded: no release is offered.
    const offer = `[...document.querySelectorAll('button')].some(b => b.offsetParent
        && b.textContent === ${JSON.stringify(UPDATE.UPDATE_TO('v0.2.1 (5e6f7a8b)'))})`;
    const apSystem = await cdp.open(`${PAGE}?fallback=x&tab=system&via=${AP}&ap`);
    await apSystem.until(ready, 15000);
    const before = await apSystem.eval('window.fetched.length');
    await apSystem.until(`document.getElementById('firmware-version')`, 5000);
    check(await apSystem.eval(apNotice) && await apSystem.eval(`document.getElementById('reason').hidden`),
        'over the access point: the notice, without why the full user interface didn\'t load');
    check(!await apSystem.eval(offer) && !await apSystem.eval(`${text}.includes(${JSON.stringify(UPDATE.LATEST_UNKNOWN)})`)
        && await apSystem.eval('window.fetched.length') === before, 'over the access point: no release offered, nothing downloaded');
    const stationSystem = await cdp.open(`${PAGE}?fallback=x&tab=system&via=${STATION}`);
    await stationSystem.until(ready, 15000);
    await stationSystem.until(offer, 5000);
    check(true, 'over the home network: the release is offered');

    // Airfrog joined its network while the access point was on: the notice,
    // but not over the recovery button's access point.
    const joined = `(c => c && !c.hidden)(document.getElementById('ap-notice'))`;
    const apJoined = await cdp.open(`${PAGE}?fallback=x&via=${AP}&ap&apip=127.0.0.1`);
    await apJoined.until(joined, 15000);
    const buttonJoined = await cdp.open(`${PAGE}?fallback=x&via=${AP_BUTTON}&ap&apip=127.0.0.1`);
    await buttonJoined.until(ready, 15000);
    check(!await buttonJoined.eval(joined), 'over the recovery button access point: no notice that Airfrog joined its network');

    // The recovery button's access point: a forgotten password, then unsigned and older firmware.
    const button = await cdp.open(`${PAGE}?fallback=x&via=${AP_BUTTON}&password=frog`);
    await button.until(`${loginShown}`, 15000);
    check(await button.eval(`${text}.includes(${JSON.stringify(CONNECTION.RESET_PASSWORD)})
        && !${text}.includes(${JSON.stringify(CONNECTION.FORGOTTEN)})
        && !${text}.includes(${JSON.stringify(CONNECTION.FORGOTTEN_AP)})`),
    "the login card offers a new password in place of the recovery page's link");
    check(await button.eval(apNotice) && await button.eval(noticeText)
        === `${HOME_PAGE.ACCESS_POINT} ${HOME_PAGE.ACCESS_POINT_BUTTON}`,
    'over the recovery button access point: the notice on the login card, with when the access point stops');
    await button.eval(submit({ repeat: 'Newt pond 2', password: 'Newt pond 2' }));
    await button.until(`${loginShown} && ${loginCard}.querySelector('.msg').textContent`, 15000);
    check(await button.eval(`${loginCard}.querySelector('.msg.ok')?.textContent`) === CONNECTION.PASSWORD_SAVED,
        'the reset: the login card asks to log in with the new password');
    check(await button.eval(fake("f.received.find(m => m.type === 0x10 && m.payload[0] === 0x06) && f.received[0].type === 0x10")),
        'SET_PASSWORD before LOGIN');
    check(await button.eval(fake('f.key.every((b, i) => b === f.sentKey[i])')), 'its key in the clear');
    await button.eval(submit({ password: 'Newt pond 2' }));
    await button.until(ready, 15000);
    await button.eval(click('System'));
    await button.eval(chooseFirmware('0.1.0', false));
    await button.until(`document.querySelector('.file-check .tick')`, 5000);
    check(await button.eval(fileCheck) === UPDATE.UNSIGNED, 'over the recovery button access point: unsigned older firmware is allowed');
    const login = await cdp.open(`${PAGE}?fallback=x&via=${STATION}&password=frog`);
    await login.until(`${loginShown}`, 15000);
    check(await login.eval(`!${text}.includes(${JSON.stringify(CONNECTION.RESET_PASSWORD)})
        && ${text}.includes(${JSON.stringify(CONNECTION.FORGOTTEN)})
        && !${text}.includes(${JSON.stringify(CONNECTION.FORGOTTEN_AP)})`),
    'over the home network: the recovery page link, without a new password');
    const apLogin = await cdp.open(`${PAGE}?fallback=x&via=${AP}&ap&password=frog`);
    await apLogin.until(`${loginShown}`, 15000);
    check(await apLogin.eval(`${text}.includes(${JSON.stringify(CONNECTION.FORGOTTEN_AP)})
        && !${text}.includes(${JSON.stringify(CONNECTION.FORGOTTEN)}) && !${text}.includes(${JSON.stringify(CONNECTION.RESET_PASSWORD)})`),
    'over the access point: the recovery button, in place of the recovery page link');

    // The full user interface: firmware with other release keys or another manifest address.
    for (const [what, query] of [['other release keys', `keys=${'ab'.repeat(32)}`],
        ['another manifest address', 'manifest=https://other.test/manifest.json']]) {
        const other = await cdp.open(`${PAGE}?${query}`);
        await other.until(`${text}.includes(${JSON.stringify(CONNECTION.OTHER_FIRMWARE)})`, 15000);
        await new Promise(r => setTimeout(r, 2500));
        check(await other.eval(`${text}.includes(${JSON.stringify(CONNECTION.OTHER_FIRMWARE)})
            && !/Reconnecting/.test(${text})`) && await other.eval(fake('f.received.length === 0')),
        `the full user interface with ${what}: why, without login, commands or a retry`);
    }
    const backup = await cdp.open(`${PAGE}?keys=${'ab'.repeat(32)},${BACKUP_KEY}`);
    await backup.until(ready, 15000);
    check(true, 'the full user interface with one release key in common connects');

    // The full user interface: unsigned and signed extensions.
    const pkg = path.join(ROOT, 'tests/ui/fixtures/hello-0.3.0.afx');
    const homeUi = await cdp.open(`${PAGE}#extensions`);
    await homeUi.until(`document.querySelector('input[accept=".afx,.bin"]') && !document.querySelector('.actions button:disabled')`,
        15000);
    await installFile(homeUi, pkg);
    await homeUi.until(`/Install failed/.test(${text})`, 5000);
    check(await homeUi.eval(`${text}.includes(${JSON.stringify(EXTENSIONS.UNSIGNED_NOT_HERE)})`)
        && await homeUi.eval(fake('!f.received.some(m => m.type === 0x10 && m.payload[0] === 0x18)')),
    'over the home network: a package from a file, why, and nothing sent');
    await installFile(homeUi, extensionFiles());
    await homeUi.until(`/Installed Signed Test/.test(${text})`, 10000);
    check(await homeUi.eval(fake("f.extensions.some(x => x.name === 'signed-test' && !(x.flags & 2))"))
        && await homeUi.eval(fake('f.signatures.at(-1).some(b => b !== 0)')),
    'over the home network: a signed extension image from a file installs with its signature, without a prompt');
    check(!/unsigned/.test(await homeUi.eval(`document.querySelector('tr.ext-row').textContent`)),
        "a signed extension isn't marked unsigned");
    const buttonUi = await cdp.open(`${PAGE}?via=${AP_BUTTON}#extensions`);
    await buttonUi.until(`document.querySelector('input[accept=".afx,.bin"]') && !document.querySelector('.actions button:disabled')`,
        15000);
    await installFile(buttonUi, pkg);
    await buttonUi.until(`document.querySelector('.prompt:not([hidden])')`, 5000);
    await buttonUi.eval(`[...document.querySelectorAll('.prompt button')].find(b => b.textContent === 'Install').click(), true`);
    await buttonUi.until(`/Installed/.test(${text})`, 10000);
    check(await buttonUi.eval(fake("f.extensions.some(x => x.name === 'hello' && (x.flags & 2))"))
        && await buttonUi.eval(fake('f.signatures.at(-1).every(b => b === 0)')),
    'over the recovery button access point: a package is confirmed and installs unsigned');
    const ver = await buttonUi.eval(`document.querySelector('tr.ext-row td.ver').textContent`);
    check(/^v\S+ \(unsigned\)$/.test(ver) && ver.endsWith(`(${EXTENSIONS.UNSIGNED})`),
        `an unsigned extension is marked unsigned, in brackets after its version (${ver})`);
    // An Airfrog without the key a file is signed with: the file is sent unsigned.
    const backupOnly = `keys=${BACKUP_KEY}`;
    const otherKey = await cdp.open(`${PAGE}?fallback=x&tab=system&${backupOnly}`);
    await otherKey.until(ready, 15000);
    await otherKey.eval(chooseFirmware('0.2.9', true));
    await otherKey.until(`document.querySelector('.file-check .cross')`, 5000);
    check(await otherKey.eval(fileCheck) === UPDATE.UNSIGNED_NOT_HERE,
        'over the home network, firmware signed with a key Airfrog lacks: why, as unsigned');
    await otherKey.eval(`document.getElementById('firmware-offer').click(), true`);
    await otherKey.until(`document.getElementById('firmware-msg').textContent === ${JSON.stringify(UPDATE.UNSIGNED_NOT_HERE)}`,
        10000);
    check(await otherKey.eval(fake('!f.received.some(m => m.type === 0x10 && m.payload[0] === 0x0E)')),
        'over the home network, a release signed with a key Airfrog lacks: why, and nothing sent');
    const putBack = await cdp.open(`${PAGE}?fallback=x&tab=system&via=${AP_BUTTON}&${backupOnly}`);
    await putBack.until(ready, 15000);
    await putBack.eval(chooseFirmware('0.1.0', true));
    await putBack.until(`document.querySelector('.file-check .tick')`, 5000);
    check(await putBack.eval(fileCheck) === UPDATE.UNSIGNED,
        'over the recovery button access point, older firmware signed with a key Airfrog lacks: accepted as unsigned');
    const install = `[...${card(UPDATE.TITLE)}.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(UPDATE.UPDATE)})`;
    await putBack.until(`!${install}.disabled`, 5000);
    await putBack.eval(`${install}.click(), true`);
    await putBack.until(fake('f.signatures.length > 0'), 10000);
    check(await putBack.eval(fake('f.signatures.at(-1).every(b => b === 0)')),
        'the file is put back over the recovery button access point with 74 zero bytes for its signature');
    const extKey = await cdp.open(`${PAGE}?${backupOnly}#extensions`);
    await extKey.until(`document.querySelector('input[accept=".afx,.bin"]') && !document.querySelector('.actions button:disabled')`,
        15000);
    await installFile(extKey, extensionFiles());
    await extKey.until(`/Install failed/.test(${text})`, 5000);
    check(await extKey.eval(`${text}.includes(${JSON.stringify(EXTENSIONS.UNSIGNED_NOT_HERE)})`),
        'over the home network, an extension signed with a key Airfrog lacks: why, as unsigned');
    const extButton = await cdp.open(`${PAGE}?via=${AP_BUTTON}&${backupOnly}#extensions`);
    await extButton.until(`document.querySelector('input[accept=".afx,.bin"]') && !document.querySelector('.actions button:disabled')`,
        15000);
    await installFile(extButton, extensionFiles());
    await extButton.until(`document.querySelector('.prompt:not([hidden])')`, 5000);
    await extButton.eval(`[...document.querySelectorAll('.prompt button')].find(b => b.textContent === 'Install').click(), true`);
    await extButton.until(`/Installed Signed Test/.test(${text})`, 10000);
    check(await extButton.eval(fake("f.extensions.some(x => x.name === 'signed-test' && (x.flags & 2))"))
        && await extButton.eval(fake('f.signatures.at(-1).every(b => b === 0)')),
    'over the recovery button access point, it is confirmed and installs unsigned');

    // Released firmware put back from a test-key Airfrog UI over the recovery
    // button access point: the reconnect after the install isn't checked, so
    // the firmware with other release keys and another address is confirmed.
    // The next connection is checked. The result isn't kept, so the page
    // doesn't reload.
    const released = await cdp.open(`${PAGE}?via=${AP_BUTTON}&${backupOnly}&newkeys=${OTHER_KEY}`
        + '&newmanifest=https://released.test/manifest.json#system');
    await released.until(ready, 15000);
    await released.eval(`Storage.prototype.setItem = () => { throw new Error('denied'); }, true`);
    await released.eval(chooseFirmware('0.2.1', 'other'));
    await released.until(`document.querySelector('.file-check .tick')`, 5000);
    await released.eval(click('Update'));
    await released.until(`/Updated to firmware|failed/.test(document.getElementById('firmware-msg').textContent)`, 30000);
    check(await released.eval(`document.getElementById('firmware-msg').textContent`) === 'Updated to firmware v0.2.1 (5e6f7a8b).'
        && await released.eval(fake('f.confirmed && f.signatures.at(-1).every(b => b === 0)')),
    'released firmware put back over the recovery button access point is confirmed by an unchecked reconnect');
    await released.until(`${text}.includes(${JSON.stringify(CONNECTION.OTHER_FIRMWARE)})`, 15000);
    check(true, 'then the next connection is checked, and fails with why');

    for (const page of [first, station, off, ap, button, login, homeUi, buttonUi, otherKey, putBack, extKey, extButton,
        released]) {
        check(page.console.every(l => !l.startsWith('EXCEPTION')), `no exceptions ${page.console.join(' | ')}`);
    }
} catch (e) {
    failures++;
    process.stdout.write(`FAIL ${e.message}\n`);
} finally {
    cdp.close();
    chrome.kill();
    server.kill();
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(files, { recursive: true, force: true });
}
process.stdout.write(failures ? `${failures} FAILED\n` : 'all passed\n');
process.exit(failures ? 1 : 0);
