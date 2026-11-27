// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// airfrog.org/commissioning in headless Chrome with the test models
// (`ci/schema.py --test`): Mini v2 is released on the C3.
//
// airfrog.org/commissioning's Firmware card runs with a fake
// serial port, a fake esptool-js and signed manifests made with airfrog-v2's
// test key. After Connect the Model select lists the released models whose
// MCU and PSRAM match the board, Release lists the selected model's
// releases and selects the latest, and Keep current firmware checks the model
// of the firmware on the board before anything on the board changes.
//
// Usage: ci/test-commissioning.sh writes build/test-deps/schema. Then
//   node tests/js/chrome/models.test.mjs
//   CHROME  Chrome's path (default: macOS's)

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp } from './harness.mjs';
import { COMMISSIONING_FIRMWARE } from '../../../js/messages.js';
import { TEST_KEY, minisig } from '../../ui/minisign.mjs';
import { ESPTOOL, boardOf, fakeSerial } from './fake-serial.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json' };
const TEST_SCHEMA = path.join(ROOT, 'build/test-deps/schema/js/schema.js');
const RELEASE = path.join(ROOT, 'tests/commissioning/fixtures/releases/v0.2.0/firmware/mini');
const FLASH = 4194304;
// The v0.2.0 setup module staged by an earlier build, which isn't a published release.
const OLD_SETUP = path.join(ROOT, 'tests/fixtures/setup-old-style.js');

let failures = 0;
const check = (ok, what) => {
  if (!ok) failures++;
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${what}\n`);
};

const sha = (data) => createHash('sha256').update(data).digest('hex');

// The server.
let origin = '';
const setup = Buffer.from('export const API = 3;\n');

/** A release of the fixture release's files, as the firmware manifest lists it. */
function release(version) {
  const commission = JSON.parse(fs.readFileSync(path.join(RELEASE, 'commission.json'), 'utf8'));
  const files = commission.files.map((f) => ({ offset: f.offset, url: `${origin}/release/${f.file}`,
    size: f.size, sha256: f.sha256 }));
  const image = files.find((f) => f.url.endsWith('/airfrog.bin'));
  return { version, commit: '1a2b3c4d', image: { url: image.url, size: image.size, sha256: image.sha256 },
    setup: { url: `${origin}/setup.js`, size: setup.length, sha256: sha(setup) }, flash_size: FLASH, files };
}

// The firmware manifest's latest releases.
const LATEST = { 'airfrog-mini': '0.2.0', 'airfrog-mini-v2': '0.3.0' };
let latest = LATEST;

/** Each served path's body: the manifests signed with the test key, as ci/release-firmware.py writes them. */
function served() {
  const firmware = {
    type: 'firmware', version: 1, latest,
    firmware: {
      'airfrog-mini': [release('0.2.0')],
      'airfrog-mini-v2': [release('0.4.0'), release('0.3.0')],
    },
  };
  const airfrog = { type: 'airfrog', version: 1, ui_manifest: { url: `${origin}/ui.json`, key: TEST_KEY },
    firmware_manifest: { url: `${origin}/firmware.json`, key: TEST_KEY }, js_library: `${origin}/js/`,
    full_access_websites: [] };
  const bodies = {};
  for (const [name, manifest] of [['airfrog', airfrog], ['firmware', firmware]]) {
    const body = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    bodies[`/${name}.json`] = body;
    bodies[`/${name}.json.minisig`] = Buffer.from(minisig(body));
  }
  bodies['/setup.js'] = setup;
  return bodies;
}

// Whether the Airfrog manifest answers.
let manifestDown = false;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x').pathname;
  if (manifestDown && url.startsWith('/airfrog.json')) {
    res.writeHead(404).end();
    return;
  }
  const send = (body, type) => res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(body);
  const bodies = served();
  if (url === '/__release/setup.js') return send(fs.readFileSync(OLD_SETUP), 'text/javascript');
  if (url === '/commissioning/vendor/esptool.js') return send(ESPTOOL, 'text/javascript');
  if (url === '/commissioning/release-keys.js') {
    return send(`export const RELEASE_KEYS = ['${TEST_KEY}'];\nexport const AIRFROG_MANIFEST = '${origin}/airfrog.json';\n`,
      'text/javascript');
  }
  if (bodies[url]) return send(bodies[url], 'application/json');
  if (url.startsWith('/release/') && fs.existsSync(path.join(RELEASE, path.basename(url)))) {
    return send(fs.readFileSync(path.join(RELEASE, path.basename(url))), 'application/octet-stream');
  }
  const file = url === '/js/schema.js' ? TEST_SCHEMA : path.join(ROOT, url.endsWith('/') ? `${url}index.html` : url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  return send(fs.readFileSync(file), TYPES[path.extname(file)] ?? 'application/octet-stream');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
origin = `http://127.0.0.1:${server.address().port}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'commissioning-'));
const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
let port = null;
for (let i = 0; i < 100 && !port; i++) {
  await new Promise((r) => setTimeout(r, 100));
  try {
    port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
  } catch (e) {
    // Not written yet
  }
}
const cdp = await Cdp.connect(`ws://127.0.0.1:${port[0]}${port[1]}`);

/** Opens the page with the fake serial port and board, and selects Connect. */
async function connected(board) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const page = await cdp.attach(targetId);
  await page.call('Page.addScriptToEvaluateOnNewDocument', { source: fakeSerial(board) });
  await page.navigate(`${origin}/commissioning/`);
  await page.until(`!document.getElementById('connect').disabled`);
  await page.eval(`document.getElementById('connect').click()`);
  await page.until(`document.getElementById('connect-pill').textContent === 'Connected'`);
  return page;
}

const state = (page) => page.eval(`({
  models: [...document.getElementById('model').options].map((o) => o.textContent),
  model: document.getElementById('model').selectedOptions[0]?.textContent ?? null,
  modelDisabled: document.getElementById('model').disabled,
  releases: [...document.getElementById('release').options].map((o) => o.textContent),
  release: document.getElementById('release').selectedOptions[0]?.textContent ?? null,
  install: !document.getElementById('install').disabled,
  keep: !document.getElementById('keep').disabled,
  message: document.getElementById('firmware-msg').textContent })`);
const calls = (page) => page.eval('window.__calls');
const choose = (page, text) => page.eval(`(() => { const s = document.getElementById('model');
  s.value = [...s.options].find((o) => o.textContent === ${JSON.stringify(text)}).value;
  s.dispatchEvent(new Event('change')); return true; })()`);

const C3 = ['WiFi'];
const S3_PSRAM = ['WiFi', 'Embedded PSRAM 8MB'];

try {
  // Before Connect
  {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const page = await cdp.attach(targetId);
    await page.call('Page.addScriptToEvaluateOnNewDocument', { source: fakeSerial(boardOf('ESP32-C3', C3)) });
    await page.navigate(`${origin}/commissioning/`);
    await page.until(`document.getElementById('release').options.length === 0`);
    const s = await state(page);
    check(s.models.length === 0 && s.modelDisabled && !s.install && !s.keep,
      `before Connect the Model select is empty and disabled, Install and Keep are disabled (${JSON.stringify(s)})`);
  }

  // An ESP32-C3: Mini and Mini v2, lowest number first, Mini selected.
  {
    const page = await connected(boardOf('ESP32-C3', C3, 1));
    let s = await state(page);
    check(s.models.join() === 'Mini,Mini v2' && s.model === 'Mini' && !s.modelDisabled,
      `C3: Model lists Mini then Mini v2 and selects Mini (${JSON.stringify(s)})`);
    check(s.releases.length === 1 && /0\.2\.0/.test(s.releases[0]) && s.install && s.keep && s.message === '',
      `C3: Release lists Mini's release, Install and Keep are enabled (${JSON.stringify(s)})`);

    await choose(page, 'Mini v2');
    s = await state(page);
    check(s.model === 'Mini v2' && s.releases.length === 2 && /0\.4\.0/.test(s.releases[0]) && /0\.3\.0/.test(s.releases[1])
      && /0\.3\.0/.test(s.release) && s.install && s.keep,
      `C3: choosing Mini v2 lists its releases and selects the latest, which isn't the highest (${JSON.stringify(s)})`);

    // Keep with the firmware of Mini v2 chosen and Mini on the board stops before anything changes.
    await page.eval(`document.getElementById('keep').click()`);
    await page.until(`document.getElementById('firmware-msg').textContent !== ''`);
    s = await state(page);
    check(s.message === 'Airfrog firmware is for Mini, not Mini v2.',
      `C3: Keep with Mini v2 chosen and Mini on the board stops (${s.message})`);
    let c = await calls(page);
    check(c.includes('readFlash') && !c.some((x) => /^(eraseFlash|writeFlash|port\.open|port\.close)/.test(x)),
      `C3: it only read the flash (${c.join(', ')})`);
    check(s.keep && s.install, 'C3: Install and Keep are enabled again');

    // Keep with Mini chosen and Mini on the board reads the flash first, then starts the firmware.
    await choose(page, 'Mini');
    await page.eval(`window.__calls.length = 0; document.getElementById('keep').click()`);
    await page.until(`window.__calls.includes('port.open')`);
    c = await calls(page);
    check(c.indexOf('readFlash') >= 0 && c.indexOf('readFlash') < c.indexOf('port.open')
      && !c.some((x) => /^(eraseFlash|writeFlash)/.test(x)),
      `C3: Keep with Mini chosen reads the flash before starting the firmware (${c.join(', ')})`);
    check(page.console.every((l) => !l.startsWith('EXCEPTION')), `C3: no exceptions ${page.console.join(' | ')}`);
  }

  // A firmware without a latest release: none of its releases is selected, and
  // Install is enabled once one is chosen.
  {
    latest = { 'airfrog-mini-v2': '0.3.0' };
    const page = await connected(boardOf('ESP32-C3', C3, 1));
    latest = LATEST;
    let s = await state(page);
    check(s.releases.length === 1 && s.release === null && !s.install && s.keep && s.message === '',
      `without a latest release none is selected and Install is disabled (${JSON.stringify(s)})`);
    await page.eval(`(() => { const r = document.getElementById('release'); r.selectedIndex = 0;
      r.dispatchEvent(new Event('change')); return true; })()`);
    s = await state(page);
    check(/0\.2\.0/.test(s.release) && s.install, `choosing the release enables Install (${JSON.stringify(s)})`);
  }

  // Keep after the firmware ran connects again, perhaps to another board. The fake serial port
  // doesn't answer, so the first Keep ends with the HELLO timeout over serial.
  {
    const page = await connected(boardOf('ESP32-C3', C3, 1));
    await page.eval(`document.getElementById('keep').click()`);
    await page.until(`document.getElementById('firmware-msg').textContent.startsWith(${JSON.stringify(COMMISSIONING_FIRMWARE.NO_SERIAL_RESPONSE)})`, 40000);
    await page.eval(`window.__calls.length = 0; window.__board.name = 'ESP32-S3'; window.__board.features = ['WiFi'];
      document.getElementById('keep').click()`);
    await page.until(`document.getElementById('firmware-msg').textContent === 'Airfrog model not recognised.'`);
    let s = await state(page);
    check(s.models.length === 0 && !s.install && !s.keep, `Keep connects again, to a board that matches no model (${JSON.stringify(s)})`);
    check(!(await calls(page)).includes('port.open'), 'then the firmware isn\'t started');
    await page.eval(`window.__board.name = 'ESP32-C3'; window.__board.features = ['WiFi']; document.getElementById('connect').click()`);
    await page.until(`document.getElementById('model').options.length === 2`);
    await page.eval(`window.__calls.length = 0; document.getElementById('keep').click()`);
    await page.until(`window.__calls.includes('port.open')`);
    check(true, 'Connect again, to a C3 with Mini, lists the models and Keep starts the firmware');
  }

  // Keep connects again to a board that still matches a model, but not the selected one.
  {
    const page = await connected(boardOf('ESP32-S3', S3_PSRAM, 2));
    await page.eval(`document.getElementById('keep').click()`);
    await page.until(`document.getElementById('firmware-msg').textContent.startsWith(${JSON.stringify(COMMISSIONING_FIRMWARE.NO_SERIAL_RESPONSE)})`, 40000);
    await page.eval(`window.__calls.length = 0; window.__board.name = 'ESP32-C3'; window.__board.features = ['WiFi'];
      document.getElementById('keep').click()`);
    await page.until(`document.getElementById('firmware-msg').textContent === 'Airfrog board changed. Check the model.'`);
    const s = await state(page);
    check(s.models.join() === 'Mini,Mini v2' && s.model === 'Mini' && s.keep && !(await calls(page)).includes('port.open'),
      `Keep connects again to a C3 where Pro was selected: the board changed, Model lists the C3's (${JSON.stringify(s)})`);
  }

  // A failed write leaves the board unconnected, so Model can't be chosen.
  {
    const page = await connected({ ...boardOf('ESP32-C3', C3), failWrite: true });
    await page.eval(`document.getElementById('install').click()`);
    await page.until(`[...document.querySelectorAll('button')].some((b) => b.textContent === 'Install')`);
    await page.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Install').click()`);
    await page.until(`document.getElementById('firmware-msg').textContent.startsWith('Firmware write failed.')`, 15000);
    const s = await state(page);
    check(s.modelDisabled && !s.install && !s.keep, `after a failed write Model, Install and Keep are disabled (${JSON.stringify(s)})`);
  }

  // The failure to load the manifest is still displayed after Connect.
  {
    manifestDown = true;
    const page = await connected(boardOf('ESP32-C3', C3, 1));
    manifestDown = false;
    const s = await state(page);
    check(/^Release list download failed/.test(s.message) && !s.install && s.keep,
      `the manifest's failure stays after Connect (${JSON.stringify(s)})`);
  }

  // Keep with a flash that holds a model the schema doesn't name, and with a blank flash.
  {
    const page = await connected(boardOf('ESP32-C3', C3, 7));
    await page.eval(`document.getElementById('keep').click()`);
    await page.until(`document.getElementById('firmware-msg').textContent !== ''`);
    const s = await state(page);
    check(s.message === 'Airfrog firmware is for Model 7, not Mini.', `an unnamed model on the board (${s.message})`);
  }
  {
    const page = await connected(boardOf('ESP32-C3', C3));
    await page.eval(`document.getElementById('keep').click()`);
    await page.until(`document.getElementById('firmware-msg').textContent !== ''`);
    const s = await state(page);
    check(s.message === 'Airfrog firmware not found. Select Install firmware.', `a blank flash (${s.message})`);
    const c = await calls(page);
    check(!c.some((x) => /^(eraseFlash|writeFlash|port\.open)/.test(x)), `a blank flash isn't changed (${c.join(', ')})`);
    // Install firmware is still possible: it erases and writes Mini's release.
    await page.eval(`document.getElementById('install').click()`);
    await page.until(`[...document.querySelectorAll('button')].some((b) => b.textContent === 'Install')`);
    await page.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Install').click()`);
    await page.until(`window.__calls.some((x) => x.startsWith('writeFlash'))`, 15000);
    const written = await calls(page);
    check(written.includes('eraseFlash') && written.some((x) => x === 'writeFlash 0,32768,53248,327680'),
      `Install firmware erases and writes the release's files (${written.join(', ')})`);
  }

  // An ESP32-S3 with PSRAM: Pro, which has no release in the manifest.
  {
    const page = await connected(boardOf('ESP32-S3', S3_PSRAM, 2));
    const s = await state(page);
    check(s.models.join() === 'Pro' && s.model === 'Pro' && s.releases.length === 0 && !s.install && s.keep
      && s.message === 'No Pro firmware released.', `S3 with PSRAM: Pro without releases (${JSON.stringify(s)})`);
    await page.eval(`document.getElementById('keep').click()`);
    await page.until(`window.__calls.includes('readFlash')`);
    const c = await calls(page);
    check(!c.some((x) => /^(eraseFlash|writeFlash)/.test(x)), `S3 with PSRAM: Keep only reads (${c.join(', ')})`);
  }

  // The setup module of a firmware release adds its stylesheet, written for a whole page, unless the
  // page has made #airfrog-setup-style. No release is published, so this runs
  // tests/fixtures/setup-old-style.js, the module with the page-wide rules of the stylesheet before
  // the 2026-11-22 style change.
  {
    const pageText = `(() => { const css = (sel, ...props) => props.map((p) => getComputedStyle(document.querySelector(sel))[p]).join(' ');
      return [css('h3.sub', 'fontSize', 'color', 'marginTop', 'backgroundColor'), css('main', 'maxWidth'),
        css('.steps a', 'color'), css('table th', 'color', 'fontSize')]; })()`;
    const tool = `(() => { const css = (sel, ...props) => props.map((p) => getComputedStyle(document.querySelector(sel))[p]).join(' ');
      return [css('#setup .card', 'width', 'borderRadius'), css('#setup .card h2', 'fontSize'),
        css('#setup button', 'backgroundColor', 'fontWeight')].join(' | '); })()`;
    const mount = `(async () => { const { FakeAirfrog, pipe } = await import('/tests/commissioning/fake-airfrog.mjs');
      const setup = await import('/__release/setup.js');
      const [client, airfrog] = pipe();
      new FakeAirfrog(airfrog, { joinAfter: Infinity, noSha256: true, saved: { hostname: 'bench', wifi: { mode: 0, ssid: 'bench-net',
        password: 'wifi-secret', ipv4: new Uint8Array(16) } } });
      // The release's module is from before the serial names, so its exports are the J2 ones.
      const j2 = new setup.J2(client);
      const hello = await j2.hello({ interval: 10 });
      await setup.mountJ2(document.getElementById('setup'), new setup.J2Transport(j2, hello));
      return true; })()`;
    const open = async (removeStyle) => {
      const page = await connected(boardOf('ESP32-C3', C3, 1));
      await page.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      if (removeStyle) await page.eval(`document.getElementById('airfrog-setup-style').remove(); true`);
      const before = await page.eval(pageText);
      await page.eval(mount);
      return { page, before, after: await page.eval(pageText) };
    };

    // Without the element the old stylesheet changes the page text.
    const control = await open(true);
    const changed = control.after.map((v, i) => v !== control.before[i]);
    check(changed.every(Boolean), `without #airfrog-setup-style the old release's stylesheet changes the page text's `
      + `h3, main width, link colour and table header (${JSON.stringify(control.before)} -> ${JSON.stringify(control.after)})`);

    // With it nothing changes: the page text and the tool are styled by site.css and tool.css.
    const { page, before, after } = await open(false);
    check(await page.eval(`document.getElementById('airfrog-setup-style').textContent === ''`),
      'the old release\'s addStyle adds nothing');
    check(JSON.stringify(after) === JSON.stringify(before) && after[1] === '1080px',
      `the page text is as site.css sets it (${JSON.stringify(after)})`);
    const mounted = await page.eval(tool);
    check(/^720px 10px \| 17px \| rgb\(11, 118, 160\) 600$/.test(mounted), `the tool is as tool.css sets it (${mounted})`);
  }

  // An ESP32-S3 without PSRAM matches no model.
  {
    const page = await connected(boardOf('ESP32-S3', ['WiFi'], 2));
    const s = await state(page);
    check(s.models.length === 0 && s.modelDisabled && !s.install && !s.keep && s.releases.length === 0
      && s.message === 'Airfrog model not recognised.',
      `S3 without PSRAM: model not recognised, Install and Keep disabled (${JSON.stringify(s)})`);
  }

  // The warning card shown for a browser without Web Serial lines up with the cards below it.
  {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const page = await cdp.attach(targetId);
    await page.call('Page.addScriptToEvaluateOnNewDocument', { source: fakeSerial(boardOf('ESP32-C3', C3)) });
    await page.navigate(`${origin}/commissioning/`);
    await page.until(`!document.getElementById('connect').disabled`);
    await page.eval(`document.getElementById('no-serial').hidden = false; true`);
    for (const width of [1200, 400]) {
      await page.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const box = await page.eval(`(() => { const r = (id) => document.getElementById(id).getBoundingClientRect();
        return [r('no-serial'), r('connect-card')].map((b) => [b.left, b.width]); })()`);
      check(box[0][0] === box[1][0] && box[0][1] === box[1][1] && box[0][1] > 0,
        `at ${width} px #no-serial has the left and width of #connect-card (${JSON.stringify(box)})`);
    }
  }
} catch (e) {
  failures++;
  process.stdout.write(`FAIL ${e.message}\n`);
} finally {
  cdp.close();
  chrome.kill();
  server.close();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(profile, { recursive: true, force: true });
}
process.stdout.write(failures ? `${failures} FAILED\n` : 'all passed\n');
process.exit(failures ? 1 : 0);
