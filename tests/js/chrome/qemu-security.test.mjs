// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Airfrog's setup and the Airfrog full user interface in headless Chrome
// against Airfrog in QEMU (airfrog-v2's `ci/qemu.sh --serve mini`), over each
// interface: first setup, the home network and the recovery button's access
// point, signed and unsigned firmware and extension files, and the full user
// interface's check of the firmware's manifest address and release keys.
// Where the page doesn't send a request, the same request is sent to Airfrog
// directly, to check Airfrog fails it too.
//
// A server on 127.0.0.1:MANIFEST_PORT, the manifest address the QEMU build has,
// serves the Airfrog, UI, firmware and extensions manifests, signed with
// airfrog-v2's test release key, and two builds of the full user interface:
// one with the QEMU build's keys and address, and one with the test key
// 'other'. A server on 127.0.0.1:PAGE_PORT relays Airfrog, serving
// build/setup/setup.js (ci/build-setup.sh) in place of Airfrog's /setup.js.
// While a session or a home page request is to be over the access point, it
// first sends /qemu-ap?session=1 or /qemu-ap?page=1 to Airfrog. It records the command of each AIRFROG_CMD
// the page sends, so the test checks what the page doesn't send.
//
// Run ci/build-setup.sh and ci/build-ui.sh first. Airfrog must start without a
// password. It is left without a password, without extensions this test
// installs, with recovery off, AP mode off and without button rights.
//
// Usage: AIRFROG_V2=../airfrog-v2 node tests/js/chrome/qemu-security.test.mjs [ADDRESS:PORT]
//   ADDRESS:PORT   QEMU Airfrog (default 127.0.0.1:18080)
//   MANIFEST_PORT  the port of the QEMU build's manifest address (default 18190)
//   PAGE_PORT      the relay's port (default 18196)
//   QEMU_OUT       ci/qemu.sh's OUT, relative to airfrog-v2 (default build/qemu)
//   RELEASED_BIN   Mini firmware for QEMU built with other release keys and
//                  another manifest address. When set, it stands in for
//                  released firmware, put back last over the recovery button
//                  access point from Airfrog's setup.
//   CHROME         Chrome's path (default: macOS's)

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp } from './harness.mjs';
import { Airfrog, Interface } from '../../../js/airfrog.js';
import {
    CONNECTION, EXTENSIONS, HOME_PAGE, NETWORK, PASSWORD_RULE, TARGET_SETTINGS, UPDATE, WIFI_AP,
} from '../../../js/messages.js';
import { Command, ExtensionFlag, encodeExtImage, encodeOtaBegin } from '../../../js/schema.js';
import { encodeSetWifiSta, encodeSettings, parseFwInfo, parseSettings } from '../../../js/setup/protocol.js';
import { sha256 } from '../../../js/sha256.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const V2 = path.resolve(process.env.AIRFROG_V2 ?? path.join(ROOT, '../airfrog-v2'));
const AIRFROG = process.argv[2] ?? '127.0.0.1:18080';
const [AIRFROG_HOST, AIRFROG_PORT] = AIRFROG.split(':');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MANIFEST_PORT = Number(process.env.MANIFEST_PORT ?? 18190);
const PAGE_PORT = Number(process.env.PAGE_PORT ?? 18196);
const BASE = `http://127.0.0.1:${MANIFEST_PORT}`;
const PAGE = `http://127.0.0.1:${PAGE_PORT}/`;
const ADMIN = path.join(HERE, '..', 'airfrog_admin.py');
const KEYS = path.join(V2, 'build/test-keys/ed25519');
const RELEASE_BIN = path.join(V2, process.env.QEMU_OUT ?? 'build/qemu', 'mini/release/airfrog-mini.bin');
const FIRST = 'Frog pond 1';
const SECOND = 'Newt pond 2';
const ESBUILD = fs.readFileSync(path.join(ROOT, 'ci/esbuild-version'), 'utf8').trim();

let failures = 0;
const check = (ok, what) => {
    if (!ok) failures++;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${what}\n`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// airfrog-v2's test keys
const privateKey = (name) => crypto.createPrivateKey(fs.readFileSync(path.join(KEYS, `${name}.pem`)));
const publicKey = (name) => crypto.createPublicKey(privateKey(name)).export({ format: 'der', type: 'spki' }).subarray(-32);
const keyHex = (name) => publicKey(name).toString('hex');
const signature = (data, name = 'release') => Buffer.concat([Buffer.from('Ed'), publicKey(name).subarray(0, 8),
    crypto.sign(null, data, privateKey(name))]);
const minisig = (body, name = 'release') => {
    const sig = signature(body, name);
    const trusted = Buffer.from('timestamp:0\tfile:manifest');
    return Buffer.from(`untrusted comment: test\n${sig.toString('base64')}\ntrusted comment: ${trusted}\n`
        + `${crypto.sign(null, Buffer.concat([sig.subarray(10), trusted]), privateKey(name)).toString('base64')}\n`);
};
const signedFile = (image, name = 'release') => Buffer.concat([image, Buffer.alloc(-image.length & 3),
    Buffer.from('AFSG'), signature(image, name)]);

// Airfrog's own requests
const qemu = (route) => new Promise((resolve, reject) => {
    http.get({ host: AIRFROG_HOST, port: Number(AIRFROG_PORT), path: route }, (r) => { r.resume(); r.on('end', resolve); })
        .on('error', reject);
});
const admin = (password, ...args) => execFileSync('python3', [ADMIN, AIRFROG, args[0] === 'set-aliases' ? 'airfrog' : '127.0.0.1',
    password, ...args],
    { encoding: 'utf8', env: { ...process.env, AIRFROG_V2: V2 } }).trim();
/** A connection of this script's own to Airfrog, over the access point when ap. */
async function direct(password, ap = false) {
    if (ap && password) {
        // Without K for the password the login's first connection closes
        // and a second opens, which the mark wouldn't cover. A login first
        // keeps K.
        (await Airfrog.connect(AIRFROG, password)).close();
    }
    if (ap) {
        await qemu('/qemu-ap?session=1');
    }
    return Airfrog.connect(AIRFROG, password);
}

// The two builds of the full user interface
const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qemu-security-ui-'));
function buildUi(name, keys) {
    const out = path.join(uiDir, `${name}.js`);
    execFileSync(process.execPath, [path.join(ROOT, 'ui/build.mjs'),
        '--esbuild', path.join(ROOT, `build/ui-deps/esbuild-${ESBUILD}/node_modules/esbuild/lib/main.js`),
        '--node-modules', path.join(ROOT, 'build/ui-deps/noble/node_modules'), '--ui-version', '0.0.1',
        '--banner', `// The full user interface for tests/js/chrome/qemu-security.test.mjs, ${name}`, '--out', out],
    { env: { ...process.env, AIRFROG_MANIFEST: `${BASE}/manifest.json`, AIRFROG_KEYS: keys.join(',') }, stdio: 'inherit' });
    return fs.readFileSync(out);
}
const uis = { match: buildUi('match', [keyHex('release'), keyHex('backup')]), other: buildUi('other', [keyHex('other')]) };

// The manifest server
const manifestState = { ui: 'match' };
function served() {
    const entry = (p) => ({ url: BASE + p, key: keyHex('release') });
    const ui = uis[manifestState.ui];
    const sign = (p, m) => {
        const body = Buffer.from(JSON.stringify(m, null, 2));
        return { [p]: body, [`${p}.minisig`]: minisig(body) };
    };
    return {
        ...sign('/manifest.json', {
            type: 'airfrog', version: 1, ui_manifest: entry('/ui/manifest.json'),
            firmware_manifest: entry('/firmware/manifest.json'),
            support_firmware_manifest: { url: 'https://example.org/support-firmware/manifest.json' },
            cli_manifest: entry('/cli/manifest.json'), extensions_manifest: entry('/extensions/manifest.json'),
            js_library: `${BASE}/js/`, full_access_websites: [],
        }),
        ...sign('/ui/manifest.json', {
            type: 'ui', version: 1, ui_version: '0.0.1', min_home_page: 1, entry: `${BASE}/ui/ui.js`,
            files: { [`${BASE}/ui/ui.js`]: { size: ui.length, sha256: crypto.createHash('sha256').update(ui).digest('hex') } },
        }),
        '/ui/ui.js': ui,
        ...sign('/firmware/manifest.json', { type: 'firmware', version: 1, latest: {}, firmware: {} }),
        ...sign('/extensions/manifest.json', { type: 'extensions', version: 1, extensions: {} }),
    };
}
// The manifest server's requests, which the home page over the access point doesn't make.
let manifestRequests = 0;
const manifests = http.createServer((req, res) => {
    manifestRequests += 1;
    const body = served()[req.url.split('?')[0]];
    res.writeHead(body ? 200 : 404, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(body ?? '');
});
await new Promise(r => manifests.listen(MANIFEST_PORT, '127.0.0.1', r));

// The relay
const relayState = { ap: false, sent: [] };

/**
 * Reads a WebSocket's client frames from chunks of its bytes, and records
 * each AIRFROG_CMD's command in relayState.sent.
 */
function recorder() {
    let buf = Buffer.alloc(0);
    return (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
            if (buf.length < 2) return;
            const opcode = buf[0] & 15;
            let len = buf[1] & 127;
            let at = 2;
            if (len === 126) {
                if (buf.length < 4) return;
                len = buf.readUInt16BE(2);
                at = 4;
            } else if (len === 127) {
                if (buf.length < 10) return;
                len = Number(buf.readBigUInt64BE(2));
                at = 10;
            }
            const mask = buf[1] & 128 ? buf.subarray(at, at + 4) : null;
            at += mask ? 4 : 0;
            if (buf.length < at + len) return;
            const payload = Buffer.from(buf.subarray(at, at + len));
            mask?.forEach((m, i) => { for (let j = i; j < len; j += 4) payload[j] ^= m; });
            buf = buf.subarray(at + len);
            // AWP's header is 48 bytes, and AIRFROG_CMD's command follows it.
            if (opcode === 2 && payload.length >= 50 && payload.readUInt16LE(0) === 0x10) {
                relayState.sent.push(payload.readUInt16LE(48));
            }
        }
    };
}
/** Whether the page sent none of commands since mark, an index in relayState.sent. */
const notSent = (mark, ...commands) => !relayState.sent.slice(mark).some(c => commands.includes(c));
const SETUP = path.join(ROOT, 'build/setup/setup.js');
const relay = http.createServer(async (req, res) => {
    if (req.url.split('?')[0] === '/setup.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(SETUP));
        return;
    }
    if (relayState.ap && req.url.split('?')[0] === '/') {
        await qemu('/qemu-ap?page=1').catch(() => {});
    }
    const upstream = http.request({ host: AIRFROG_HOST, port: Number(AIRFROG_PORT), method: req.method, path: req.url,
        headers: req.headers }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
});
relay.on('upgrade', async (req, socket, head) => {
    if (relayState.ap) {
        await qemu('/qemu-ap?session=1').catch(() => {});
    }
    const record = recorder();
    record(head);
    socket.on('data', record);
    const upstream = net.connect(Number(AIRFROG_PORT), AIRFROG_HOST, () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
            lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        }
        upstream.write(lines.join('\r\n') + '\r\n\r\n');
        upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
    });
    const end = () => { upstream.destroy(); socket.destroy(); };
    upstream.on('error', end);
    socket.on('error', end);
});
await new Promise(r => relay.listen(PAGE_PORT, '127.0.0.1', r));

// Chrome
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qemu-security-'));
const files = fs.mkdtempSync(path.join(os.tmpdir(), 'qemu-security-files-'));
const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
let port = null;
for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
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
const click = (label) => `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)}
    && b.offsetParent).click(), true`;
const card = (title) => `[...document.querySelectorAll('section.card')].find(c => c.querySelector('h2')?.textContent
    === ${JSON.stringify(title)})`;
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
const loginCard = `[...document.querySelectorAll('section.card')].find(c => c.querySelector('h2')?.textContent === 'Log in')`;
const apNotice = `(c => c && !c.hidden)(document.getElementById('access-point'))`;
const fileCheck = `document.querySelector('.file-check').textContent`;
/** Sets the file input matching selector to file. */
async function setFile(page, selector, file) {
    const { root } = await page.call('DOM.getDocument', { depth: 0 });
    const { nodeId } = await page.call('DOM.querySelector', { nodeId: root.nodeId, selector });
    await page.call('DOM.setFileInputFiles', { nodeId, files: [file] });
}
const writeFile = (name, data) => {
    const f = path.join(files, name);
    fs.writeFileSync(f, data);
    return f;
};
/** Logs the page in with password, once the login card is displayed. */
async function logIn(page, password) {
    await page.until(`(c => c && !c.hidden)(${loginCard})`, 20000);
    await page.eval(submit({ password }));
}
/** Saves the recovery checkbox ticked or not in the Target settings card. */
async function saveRecovery(page, on) {
    await page.eval(click('Advanced'));
    await page.eval(`(b => { if (b.checked !== ${on}) b.click(); return true; })(document.querySelector('input[name=recovery]'))`);
    await page.until(`!${card(TARGET_SETTINGS.TITLE)}.querySelector('button.primary').disabled`, 10000);
    await page.eval(`${card(TARGET_SETTINGS.TITLE)}.querySelector('button.primary').click(), true`);
    await page.until(`/Saved\\.|failed/.test(${card(TARGET_SETTINGS.TITLE)}.innerText)`, 10000);
    return page.eval(`${card(TARGET_SETTINGS.TITLE)}.querySelector('.msg').textContent`);
}

// The firmware the QEMU build runs, unsigned, and an older version of it,
// whose version only is changed.
const image = fs.readFileSync(RELEASE_BIN);
const older = Buffer.from(image);
older.fill(0, 48, 80);
older.write('0.1.0', 48);
/**
 * image with bytes written at each offset of edits, its checksum and
 * appended SHA-256 made again, so ESP-IDF's checks pass.
 */
function patched(base, edits) {
    const out = Buffer.from(base);
    for (const [offset, bytes] of edits) {
        out.set(bytes, offset);
    }
    let at = 24;
    let checksum = 0xEF;
    for (let i = 0; i < out[1]; i++) {
        const len = out.readUInt32LE(at + 4);
        for (const b of out.subarray(at + 8, at + 8 + len)) {
            checksum ^= b;
        }
        at += 8 + len;
    }
    const end = Math.floor(at / 16) * 16 + 16;
    out[end - 1] = checksum;
    if (out[23] === 1) {
        out.set(crypto.createHash('sha256').update(out.subarray(0, end)).digest(), end);
    }
    return out;
}
/** The file offset of address in base's segments. */
function offsetOf(base, address) {
    let at = 24;
    for (let i = 0; i < base[1]; i++) {
        const load = base.readUInt32LE(at);
        const len = base.readUInt32LE(at + 4);
        if (address >= load && address < load + len) {
            return at + 8 + address - load;
        }
        at += 8 + len;
    }
    throw new Error(`0x${address.toString(16)} isn't in a segment`);
}
/** The address of function name in the ELF file at path. */
function symbol(path, name) {
    const elf = fs.readFileSync(path);
    const sections = Array.from({ length: elf.readUInt16LE(0x30) }, (_, i) => elf.readUInt32LE(0x20) + i * 40);
    const symtab = sections.find(at => elf.readUInt32LE(at + 4) === 2);
    const strings = elf.readUInt32LE(sections[elf.readUInt32LE(symtab + 24)] + 16);
    for (let at = elf.readUInt32LE(symtab + 16), end = at + elf.readUInt32LE(symtab + 20); at < end; at += 16) {
        const start = strings + elf.readUInt32LE(at);
        if (elf.toString('latin1', start, elf.indexOf(0, start)) === name) {
            return elf.readUInt32LE(at + 4);
        }
    }
    throw new Error(`${name} isn't in ${path}`);
}
// The running firmware with another build time in its app description, so
// its SHA-256 differs and it boots. And with its first heap allocation
// overwritten with zeros, an illegal instruction, so it fails at start,
// before its web server starts, and the bootloader goes back to the previous
// firmware. The function is one the bootloader copies to RAM, as QEMU keeps
// the code it translated from flash across a software restart.
const boots = patched(image, [[112, Buffer.from('12:34:56\0')]]);
const failsAtStart = patched(boots, [[offsetOf(boots, symbol(path.join(V2, process.env.QEMU_OUT ?? 'build/qemu',
    'mini/airfrog.elf'), 'heap_caps_malloc_base')), Buffer.alloc(16)]]);
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
/** Installs file from the System tab, logs in again after the reload, and returns the result displayed. */
async function update(page, file) {
    await setFile(page, 'input[type=file][accept=".bin"]', file);
    await page.until(`document.querySelector('.file-check .tick')`, 10000);
    await page.eval(click('Update'));
    await page.until(`(c => c && !c.hidden)(${loginCard}) || /failed|Updated/.test(${text})`, 240000)
        .catch(async (e) => { throw new Error(`${e.message}: ${await page.eval(text)}`); });
    if (await page.eval(`(c => c && !c.hidden)(${loginCard})`)) {
        await logIn(page, password);
    }
    const shown = await page.until(`(t => /Updated to firmware|failed/.test(t) && t)(${text})`, 60000);
    return shown.split('\n').find(l => /Updated|failed/.test(l));
}
// An extension image without a module
function extensionImage(name) {
    const metadata = Buffer.from(JSON.stringify({ name, display_name: name.toUpperCase(), version: '1.0.0',
        description: 'A test extension', author: 'Ada', firmware: [] }));
    const head = encodeExtImage({ magic: 'AFXI', model: 0, wamr: [0, 0, 0], metadataOffset: 0, metadataLen: 0,
        moduleOffset: 0, moduleLen: 0, name }).length;
    return Buffer.concat([Buffer.from(encodeExtImage({ magic: 'AFXI', model: 0, wamr: [0, 0, 0], metadataOffset: head,
        metadataLen: metadata.length, moduleOffset: head + metadata.length, moduleLen: 0, name })), metadata]);
}
/** Whether Airfrog fails OTA_BEGIN with NOT_PERMITTED for data with signature. */
async function otaRefused(airfrog, data, sig) {
    const e = await airfrog.airfrogCmd(Command.OTA_BEGIN, encodeOtaBegin({ size: data.length, sha256: sha256(data),
        signature: sig ?? new Uint8Array(74) }), 5000).then(() => null, (err) => err);
    return e?.code;
}

let password = null;
try {
    admin('-', 'set-aliases', '127.0.0.1');
    // An earlier run's button rights end, and AP mode with them.
    await qemu('/qemu-button?ms=1');
    await sleep(100);
    await qemu('/qemu-ap?mode=0');

    // First setup over the access point
    await qemu('/qemu-ap?mode=1');
    relayState.ap = true;
    const first = await cdp.open(`${PAGE}#local`);
    await first.until(`(c => c && !c.hidden)(document.getElementById('first-setup'))`, 20000);
    check(await first.eval(apNotice), 'first setup: the access point notice');
    check(await first.eval(`document.querySelector('nav.tabs').hidden`), 'first setup: the password screen first');
    let hello = await direct(null, true);
    check(hello.getInterface() === Interface.AP_FIRST_SETUP, `Airfrog reports first setup (${hello.getInterface()})`);
    const wifiSta = await hello.airfrogCmd(Command.SET_WIFI_STA, encodeSetWifiSta({ ssid: 'home', password: 'wifisecret',
        ipv4: null }), 5000).then(() => null, e => e.code);
    check(wifiSta === 'NOT_PERMITTED', `Airfrog refuses a home network before the password (${wifiSta})`);
    hello.close();
    let mark = relayState.sent.length;
    await first.eval(submit({ password: 'frogpond', repeat: 'frogpond' }));
    await first.until(`document.querySelector('#first-setup .rule-intro.bad')?.textContent === ${JSON.stringify(PASSWORD_RULE.NOT_MET)}`);
    check(notSent(mark, Command.SET_PASSWORD) && relayState.sent.length > 0,
        "a password that doesn't follow the rule isn't sent");
    await first.eval(submit({ password: FIRST, repeat: FIRST }));
    await first.until(`document.getElementById('first-setup').hidden && (c => c && !c.hidden)(${loginCard})`, 30000);
    password = FIRST;
    check(await first.eval(`${loginCard}.querySelector('.msg.ok')?.textContent`) === CONNECTION.PASSWORD_SAVED,
        'first setup: the password is set, and the login card asks for it');
    await logIn(first, FIRST);
    await first.until(ready, 30000);
    check(await saveRecovery(first, true) === 'Saved.', 'first setup: Airfrog saves recovery turned on');
    await first.eval(click('Network'));
    // QEMU starts Ethernet in place of WiFi, so GET_WIFI_AP's SSID is empty
    // until SET_WIFI_AP.
    check(await first.eval(`!${card(WIFI_AP.TITLE)}.hidden`), 'first setup: the Access point card');
    await first.eval(submit({ apSsid: 'qemu-ap', apPassword: 'apsecret1' }));
    await first.until(`${text}.includes(${JSON.stringify(WIFI_AP.SAVED)})`, 10000);
    await first.until(`${ready} && document.querySelector('input[name=apSsid]').value === 'qemu-ap'`, 30000);
    check(true, 'SET_WIFI_AP: Airfrog closes the connection, and the next reads the new name');

    // The home network
    relayState.ap = false;
    await qemu('/qemu-ap?mode=0');
    const station = await cdp.open(`${PAGE}#local`);
    await logIn(station, password);
    await station.until(ready, 30000);
    check(await station.eval(`!${text}.includes(${JSON.stringify(CONNECTION.RESET_PASSWORD)})`),
        'over the home network: no new password on the login card');
    check(await station.eval(`!(${apNotice})`), 'over the home network: no access point notice');
    await station.eval(click('Network'));
    check(await station.eval(`${card(WIFI_AP.TITLE)}.hidden`), 'over the home network: no Access point card');
    check(await saveRecovery(station, false) === 'Saved.', 'over the home network: Airfrog saves recovery turned off');
    await station.until(`document.querySelector('input[name=recovery]').disabled`, 10000);
    check(true, 'then turning it on is disabled');
    hello = await direct(password);
    const settings = parseSettings(await hello.airfrogCmd(Command.GET_SETTINGS, new Uint8Array(0), 5000));
    const recovery = await hello.airfrogCmd(Command.SET_SETTINGS, encodeSettings({ ...settings, recovery: true }), 5000)
        .then(() => null, e => e.code);
    check(recovery === 'NOT_PERMITTED', `Airfrog refuses recovery turned on over the home network too (${recovery})`);
    await station.eval(click('System'));
    mark = relayState.sent.length;
    await setFile(station, 'input[type=file][accept=".bin"]', writeFile('unsigned.bin', image));
    await station.until(`document.querySelector('.file-check .cross')`, 10000);
    check(await station.eval(fileCheck) === UPDATE.UNSIGNED_NOT_HERE, 'unsigned firmware: why');
    check(await otaRefused(hello, image, null) === 'NOT_PERMITTED', 'Airfrog refuses unsigned firmware too');
    await setFile(station, 'input[type=file][accept=".bin"]', writeFile('older.bin', signedFile(older)));
    await station.until(`${fileCheck} === ${JSON.stringify(UPDATE.OLDER_NOT_HERE('v0.2.0'))}`, 10000);
    check(true, 'signed older firmware: why');
    const olderRefused = await (async () => {
        await hello.airfrogCmd(Command.OTA_BEGIN, encodeOtaBegin({ size: older.length, sha256: sha256(older),
            signature: signature(older) }), 5000);
        const e = await hello.airfrogCmd(Command.OTA_WRITE, (() => {
            const f = new Uint8Array(4 + 4096);
            f.set(older.subarray(0, 4096), 4);
            return f;
        })(), 5000).then(() => null, err => err);
        return e?.code;
    })();
    check(olderRefused === 'NOT_PERMITTED', `Airfrog refuses older firmware too, at the write of its head (${olderRefused})`);
    hello.close();
    await setFile(station, 'input[type=file][accept=".bin"]', writeFile('other-key.bin', signedFile(image, 'other')));
    await station.until(`${fileCheck} === ${JSON.stringify(UPDATE.UNSIGNED_NOT_HERE)}`, 10000);
    check(true, "firmware signed with a key Airfrog doesn't have: as unsigned, why");
    check(notSent(mark, Command.OTA_BEGIN, Command.OTA_WRITE) && await station.eval(
        `[...document.querySelectorAll('button')].find(b => b.textContent === 'Update').disabled`),
    'none of the three firmware files is sent, and Update is disabled');
    // Firmware that boots: the page reloads, logs in and displays the result.
    mark = relayState.sent.length;
    let shown = await update(station, writeFile('boots.bin', signedFile(boots)));
    hello = await direct(password);
    let fw = parseFwInfo(await hello.airfrogCmd(Command.GET_FW_INFO, new Uint8Array(0), 5000));
    hello.close();
    check(/^Updated to firmware v0\.2\.0/.test(shown) && !notSent(mark, Command.OTA_CONFIRM) && fw.sha256 === sha(boots),
        `signed firmware that boots: GET_FW_INFO's SHA-256 is the image's, and it is confirmed (${shown})`);
    // Firmware that fails at start: the bootloader goes back to the previous firmware.
    mark = relayState.sent.length;
    shown = await update(station, writeFile('fails.bin', signedFile(failsAtStart)));
    hello = await direct(password);
    fw = parseFwInfo(await hello.airfrogCmd(Command.GET_FW_INFO, new Uint8Array(0), 5000));
    hello.close();
    check(/^Update to firmware v0\.2\.0 failed\. Reverted to firmware v0\.2\.0/.test(shown)
        && notSent(mark, Command.OTA_CONFIRM) && fw.sha256 === sha(boots),
    `signed firmware that fails at start: the previous firmware runs, reported as reverted, without OTA_CONFIRM (${shown})`);

    // The full user interface: firmware with another manifest address, then extensions over the home network
    manifestState.ui = 'other';
    const other = await cdp.open(PAGE);
    await other.until(`${text}.includes(${JSON.stringify(CONNECTION.OTHER_FIRMWARE)})`, 30000);
    await sleep(3000);
    check(await other.eval(`${text}.includes(${JSON.stringify(CONNECTION.OTHER_FIRMWARE)}) && !/Reconnecting/.test(${text})`)
        && await other.eval(`(c => !c || c.hidden)(${loginCard})`),
    'a full user interface with other release keys: why, without the login form or a retry');
    await other.close?.();
    manifestState.ui = 'match';
    const ui = await cdp.open(`${PAGE}#extensions`);
    await logIn(ui, password);
    await ui.until(`document.querySelector('input[accept=".afx,.bin"]') && !document.querySelector('.actions button:disabled')`,
        30000);
    const plain = extensionImage('qemu-plain');
    mark = relayState.sent.length;
    await setFile(ui, 'input[accept=".afx,.bin"]', writeFile('qemu-plain.bin', plain));
    await ui.until(`/Install failed/.test(${text})`, 10000);
    check(await ui.eval(`${text}.includes(${JSON.stringify(EXTENSIONS.UNSIGNED_NOT_HERE)})`)
        && notSent(mark, Command.EXT_BEGIN, Command.EXT_WRITE), 'over the home network: an unsigned extension image, why, not sent');
    hello = await direct(password);
    const extRefused = await hello.installExtension(plain, 0, null).then(() => null, e => e.code);
    check(extRefused === 'NOT_PERMITTED', `Airfrog refuses an unsigned extension over the home network too (${extRefused})`);
    hello.close();
    // The unsigned image's failure is cleared first, so this one's is its own.
    await ui.eval(`document.querySelectorAll('.msg').forEach(m => { m.textContent = ''; }), true`);
    mark = relayState.sent.length;
    await setFile(ui, 'input[accept=".afx,.bin"]', writeFile('qemu-other.bin', signedFile(extensionImage('qemu-other'), 'other')));
    await ui.until(`${text}.includes(${JSON.stringify(EXTENSIONS.UNSIGNED_NOT_HERE)})`, 10000);
    check(notSent(mark, Command.EXT_BEGIN, Command.EXT_WRITE),
        "an extension signed with a key Airfrog doesn't have: as unsigned, why, not sent");
    await setFile(ui, 'input[accept=".afx,.bin"]', writeFile('qemu-signed.bin', signedFile(extensionImage('qemu-signed'))));
    // The unsigned image's failure is still displayed until this install's result.
    await ui.until(`/Installed QEMU-SIGNED|Install failed\. (?!Unsigned)/.test(${text})`, 30000)
        .catch(async (e) => { throw new Error(`${e.message}: ${await ui.eval(text)}`); });
    hello = await direct(password);
    let installed = await hello.getExtensions();
    hello.close();
    const signedExt = installed.find(x => x.name === 'qemu-signed');
    check(signedExt && !(signedExt.flags & ExtensionFlag.UNSIGNED)
        && !/unsigned/.test(await ui.eval(`[...document.querySelectorAll('tr.ext-row')].map(r => r.textContent).join()`)),
    'a signed extension image installs over the home network, signed');
    const otherKey = await (async () => {
        const c = await direct(password);
        const e = await c.installExtension(extensionImage('qemu-other'), 0, signature(extensionImage('qemu-other'), 'other'))
            .then(() => null, err => err.code);
        c.close();
        return e;
    })();
    check(otherKey === 'SIGNATURE_INVALID', `Airfrog refuses an extension signed with another key (${otherKey})`);

    // The recovery button's access point
    await qemu('/qemu-button?ms=180000');
    relayState.ap = true;
    const button = await cdp.open(`${PAGE}#local`);
    await button.until(`(c => c && !c.hidden)(${loginCard})`, 20000);
    check(await button.eval(`${text}.includes(${JSON.stringify(CONNECTION.RESET_PASSWORD)})`),
        'over the recovery button access point: the login card offers a new password');
    check(await button.eval(apNotice) && await button.eval(`document.getElementById('access-point').textContent`)
        === `${HOME_PAGE.ACCESS_POINT} ${HOME_PAGE.ACCESS_POINT_BUTTON}`,
    'over the recovery button access point: the notice on the login card, with when the access point stops');
    await button.eval(submit({ repeat: SECOND, password: SECOND }));
    await button.until(`${loginCard}.querySelector('.msg.ok')`, 30000);
    password = SECOND;
    check(await button.eval(`${loginCard}.querySelector('.msg.ok').textContent`) === CONNECTION.PASSWORD_SAVED,
        'the new password is set without logging in, and the login card asks for it');
    await logIn(button, SECOND);
    await button.until(ready, 30000);
    await button.eval(click('System'));
    await setFile(button, 'input[type=file][accept=".bin"]', writeFile('unsigned2.bin', image));
    await button.until(`document.querySelector('.file-check .tick')`, 10000);
    check(await button.eval(fileCheck) === UPDATE.UNSIGNED, 'over the recovery button access point: unsigned firmware is accepted');
    hello = await direct(password, true);
    check(hello.getInterface() === Interface.AP_BUTTON, `Airfrog reports the recovery button access point (${hello.getInterface()})`);
    const beginUnsigned = await otaRefused(hello, image, null);
    check(beginUnsigned === undefined, `Airfrog accepts unsigned firmware there too (${beginUnsigned ?? 'accepted'})`);
    hello.close();
    await sleep(1000);
    // Over the access point the home page opens Airfrog's setup, not the
    // full user interface, and fetches no manifest.
    const fetchedBefore = manifestRequests;
    const buttonUi = await cdp.open(`${PAGE}#extensions`);
    await buttonUi.until(`(c => c && !c.hidden)(${loginCard})`, 20000);
    check(await buttonUi.eval(apNotice) && !await buttonUi.eval(`document.querySelector('input[accept=".afx,.bin"]')`)
        && manifestRequests === fetchedBefore,
    'over the recovery button access point: Airfrog\'s setup with the notice, no manifest fetched');
    // Extensions install over the access point from the airfrog CLI only.
    // Airfrog installs them unsigned there.
    hello = await direct(password, true);
    await hello.installExtension(plain, 0);
    hello.close();
    hello = await direct(password);
    installed = await hello.getExtensions();
    const plainExt = installed.find(x => x.name === 'qemu-plain');
    check(plainExt && (plainExt.flags & ExtensionFlag.UNSIGNED),
        'over the recovery button access point: Airfrog installs an unsigned extension, marked unsigned');
    for (const name of ['qemu-plain', 'qemu-signed', 'qemu-other']) {
        await hello.removeExtension(name).catch(() => {});
    }
    hello.close();

    // Released firmware put back over the recovery button access point: the
    // key 'other' stands in for the release key, which this build doesn't have.
    await button.eval(click('System'));
    await setFile(button, 'input[type=file][accept=".bin"]', writeFile('released.bin', signedFile(image, 'other')));
    await button.until(`document.querySelector('.file-check .tick')`, 10000);
    check(await button.eval(fileCheck) === UPDATE.UNSIGNED,
        "over the recovery button access point: released firmware signed with a key Airfrog doesn't have, as unsigned");
    await button.eval(click('Update'));
    await button.until(`(c => c && !c.hidden)(${loginCard}) || /failed|Updated/.test(${text})`, 240000)
        .catch(async (e) => { throw new Error(`${e.message}: ${await button.eval(text)}`); });
    if (await button.eval(`(c => c && !c.hidden)(${loginCard})`)) {
        await logIn(button, password);
    }
    const putBack = await button.until(`(t => /Updated to firmware|failed/.test(t) && t)(${text})`, 60000);
    check(/Updated to firmware v0\.2\.0/.test(putBack),
        'it installs unsigned, and Airfrog confirms it after the restart');
    // Released firmware put back from Airfrog's setup over the recovery button
    // access point. The setup doesn't check the firmware's keys and address,
    // so the firmware with other keys and another address is confirmed. The
    // result isn't kept, so the page doesn't reload.
    const pages = [first, station, ui, button, buttonUi];
    if (process.env.RELEASED_BIN) {
        const released = fs.readFileSync(process.env.RELEASED_BIN);
        await qemu('/qemu-button?ms=180000');
        relayState.ap = true;
        const putBack = await cdp.open(`${PAGE}#system`);
        pages.push(putBack);
        await logIn(putBack, password);
        await putBack.until(ready, 30000);
        await putBack.eval(`Storage.prototype.setItem = () => { throw new Error('denied'); }, true`);
        await setFile(putBack, 'input[type=file][accept=".bin"]', writeFile('released-keys.bin', signedFile(released, 'other')));
        await putBack.until(`document.querySelector('.file-check .tick')`, 10000);
        check(await putBack.eval(fileCheck) === UPDATE.UNSIGNED, 'released firmware: unsigned for this Airfrog');
        await putBack.eval(click('Update'));
        const msg = `document.getElementById('firmware-msg').textContent`;
        await putBack.until(`/Updated to firmware|failed/.test(${msg})`, 240000);
        check(/^Updated to firmware v0\.2\.0\b/.test(await putBack.eval(msg)),
            `released firmware is confirmed after the restart (${await putBack.eval(msg)})`);
        hello = await direct(password);
        check(hello.getManifestUrl() === 'http://127.0.0.1:18291/manifest.json'
            && Buffer.from(hello.getReleaseKeys()[0]).equals(publicKey('other')), 'Airfrog runs the released firmware');
        hello.close();
    }
    for (const page of pages) {
        const exceptions = page.console.filter(l => l.startsWith('EXCEPTION'));
        check(exceptions.length === 0, `no exceptions ${exceptions.join(' | ')}`);
    }
} catch (e) {
    failures++;
    process.stdout.write(`FAIL ${e.stack}\n`);
} finally {
    relayState.ap = false;
    if (password) {
        try {
            admin(password, 'clear-password');
        } catch (e) {
            process.stdout.write(`FAIL clearing the password: ${e.message}\n`);
        }
    }
    await qemu('/qemu-button?ms=1').catch(() => {});
    await sleep(100);
    await qemu('/qemu-ap?mode=0').catch(() => {});
    cdp.close();
    chrome.kill();
    manifests.close();
    relay.close();
    relay.closeAllConnections?.();
    await sleep(300);
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(files, { recursive: true, force: true });
    fs.rmSync(uiDir, { recursive: true, force: true });
}
process.stdout.write(failures ? `${failures} FAILED\n` : 'all passed\n');
process.exit(failures ? 1 : 0);
