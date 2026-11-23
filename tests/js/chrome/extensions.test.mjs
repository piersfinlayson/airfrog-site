// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Extensions in Airfrog's full user interface in headless Chrome, against
// tests/ui's fake Airfrog and the test extension repository
// (airfrog-v2/rust/airfrog-ext/test/repository.py). local-test's UI is
// replaced with a page that connects with Airfrog.connectExtension() and
// displays what it receives. hello's UI is on example.com, which Chrome maps
// to a closed port, so it doesn't load.
//
// Checks the extension UI tabs, Loading and the load failure, Update with
// the UI reloaded, Install extensions' filters and search, Install, the extension
// UI's connection and its limits, the reload when Airfrog reconnects,
// reordering, the Tab checkbox, Install from file with its confirmation,
// Remove, a local UI's tab after a page load, the extensions manifest fetched
// when the Extensions tab is displayed and not on a page load or a reconnect,
// and no extension UI login after the password changes. Full-page screenshots go to SHOTS.
//
// Run ci/test-deps.sh first.
//
// Usage: node tests/js/chrome/extensions.test.mjs
//   CHROME  Chrome's path (default: macOS's)
//   SHOTS   the screenshot directory (default: build/shots/extensions)
//   PYTHON  the Python that runs repository.py (default: ci/install-python.sh's)

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REPOSITORY_PY = path.resolve(ROOT, '../airfrog-v2/rust/airfrog-ext/test/repository.py');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.env.SHOTS ?? path.join(ROOT, 'build/shots/extensions');
const PORT = 18768;
const REPO_PORT = 18197;
const REPO = `http://127.0.0.1:${REPO_PORT}`;
const PAGE = `http://127.0.0.1:${PORT}/tests/ui/browser/`;

let failures = 0;
const check = (ok, what) => {
    if (!ok) failures++;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${what}\n`);
};

const python = process.env.PYTHON
    ?? path.join(execFileSync(path.join(ROOT, 'ci/install-python.sh'), { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim(), 'python3');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'airfrog-ext-repo-'));
execFileSync(python, ['-I', REPOSITORY_PY, 'build', out, '--port', String(REPO_PORT)], { stdio: 'ignore' });
// local-test's UI, with the client library beside it.
fs.mkdirSync(path.join(out, 'ui', 'js'));
for (const f of ['airfrog.js', 'awp.js', 'schema.js', 'messages.js', 'sha256.js', 'target-state.js']) {
    fs.copyFileSync(path.join(ROOT, 'js', f), path.join(out, 'ui', 'js', f));
}
fs.writeFileSync(path.join(out, 'ui', 'local-test', 'index.html'), `<!doctype html>
<title>Local Test</title>
<style>body { font: 15px system-ui, sans-serif; margin: 16px; } p { margin: 4px 0; }</style>
<h1>Local Test UI</h1>
<div id="log"></div>
<script type="module">
import { Airfrog } from '../js/airfrog.js';
const log = (t) => { const p = document.createElement('p'); p.textContent = t; document.getElementById('log').append(p); };
try {
    const airfrog = await Airfrog.connectExtension();
    log('Connected. Target firmware ' + airfrog.getTarget().firmware + '.');
    airfrog.extension().addEventListener('notify', e => log('Notify ' + [...e.detail] + '.'));
    const reply = await airfrog.extension().command(new Uint8Array([1, 2, 3]), 2000);
    log('Reply ' + [...reply] + '.');
    for (const attempt of [() => airfrog.setExtensions([]), () => airfrog.extension('hello').command(new Uint8Array(0), 2000)]) {
        try { await attempt(); log('Allowed.'); } catch (e) { log(e.code + ': ' + e.message); }
    }
} catch (e) {
    log('Failed: ' + e.message);
}
</script>
`);

const repository = spawn(python, ['-I', REPOSITORY_PY, 'serve', out, '--port', String(REPO_PORT)], { stdio: 'ignore' });
const server = spawn(process.execPath, [path.join(ROOT, 'tests/ui/browser/serve.mjs'), String(PORT)], { stdio: 'ignore' });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'extensions-'));
const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check',
    '--host-resolver-rules=MAP example.com 127.0.0.1:9,MAP example.org 127.0.0.1:9', 'about:blank'], { stdio: 'ignore' });
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
fs.mkdirSync(SHOTS, { recursive: true });

const tabs = `[...document.querySelectorAll('nav button')].filter(b => !b.hidden).map(b => b.textContent).join()`;
const click = (label, within = 'document') => `(() => { const b = [...${within}.querySelectorAll('button')]
    .find(b => b.textContent === ${JSON.stringify(label)} && b.offsetParent && !b.disabled); b.click(); return true; })()`;
const rowClick = (name, label) => click(label, `[...document.querySelectorAll('tr.ext-row')].find(r =>
    r.children[1].textContent === ${JSON.stringify(name)})`);
const rows = `[...document.querySelectorAll('tr.ext-row')].map(r => [...r.children].slice(1, 4).map(c => c.textContent)
    .join('|') + '|' + (r.querySelector('input[type=checkbox]')?.checked ?? '-') + '|'
    + [...r.querySelectorAll('button')].map(b => b.textContent).join('+'))`;
const prompt = `[...document.querySelectorAll('.prompt')].find(p => !p.hidden)`;
const msg = `[...document.querySelectorAll('.msg')].filter(m => m.offsetParent).map(m => m.textContent).join(' / ')`;
const fakeList = `window.fake.extensions.map(x => x.name + ':' + x.flags + ':'
    + JSON.parse(new TextDecoder().decode(x.metadata)).version).join()`;

/** Saves a full-page screenshot. */
async function shot(page, name) {
    await new Promise(r => setTimeout(r, 300));
    const { data } = await page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
}

/** Evaluates expression in the frame whose URL starts with prefix. */
async function inFrame(page, prefix, expression) {
    const { frameTree } = await page.call('Page.getFrameTree');
    const find = (t) => (t.frame.url.startsWith(prefix) ? t.frame : (t.childFrames ?? []).map(find).find(Boolean));
    const frame = find(frameTree);
    if (!frame) {
        return null;
    }
    const { executionContextId } = await page.call('Page.createIsolatedWorld', { frameId: frame.id });
    const r = await page.call('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true });
    return r.result.value;
}

async function frameUntil(page, prefix, expression, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const v = await inFrame(page, prefix, expression).catch(() => null);
        if (v) return v;
        if (Date.now() > deadline) throw new Error(`timed out waiting in ${prefix} for ${expression}`);
        await new Promise(r => setTimeout(r, 100));
    }
}

const LOCAL_UI = `${REPO}/ui/local-test/`;
const frameText = `document.getElementById('log').innerText`;

try {
    const params = new URLSearchParams({ extensions: `${REPO}/extensions/manifest.json`,
        installed: `${REPO}/extensions/hello/0.1.0/wamr-0.0.0/model-0.bin`, module: 'local-test' });
    const ui = await cdp.open(`${PAGE}?${params}`);
    await ui.call('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
    await ui.until(`(c => c && !c.hidden && !c.inert)(document.querySelector('.content'))
        && document.querySelector('nav button')?.textContent === 'Hello'`, 15000);
    check(await ui.eval(tabs) === 'Hello,Target,Network,System,Advanced,Extensions',
        `an extension with its Tab checkbox ticked has a tab left of Target, which is titled Target (${await ui.eval(tabs)})`);

    // Loading and the load failure
    await ui.eval(click('Hello'));
    await ui.until(`/Loading Hello UI…/.test(${msg})`, 2000);
    const loadingAt = Date.now();
    check(await ui.eval(`document.querySelector('iframe[title="Hello"]').hidden`), 'the frame is hidden while it loads');
    await shot(ui, 'extension-ui-loading');
    await ui.until(`/Hello UI failed to load\\. Reload the page\\./.test(${msg})`, 13000);
    const failedAfter = Date.now() - loadingAt;
    check(failedAfter >= 9800, `Hello UI failed to load. Reload the page. after 10 s (${failedAfter} ms)`);
    await shot(ui, 'extension-ui-failed');
    await ui.eval(`window.helloFrame = document.querySelector('iframe[title="Hello"]'), true`);

    // The installed list, and Update
    await ui.eval(click('Extensions'));
    await ui.until(`/latest/.test(document.querySelector('tr.ext-row')?.textContent ?? '')`, 10000);
    check(await ui.eval(rows) + '' === 'Hello|v0.1.0 latest v0.2.0|UI only|true|Open+Update+Remove',
        `Hello: version, latest version, UI only, Tab ticked, Open, Update, Remove (${await ui.eval(rows)})`);
    await shot(ui, 'extensions-installed');
    check(await ui.eval(`[...document.querySelectorAll('.card-head h2')].find(h => h.offsetParent).textContent`) === 'Extensions',
        "the installed list's card title is Extensions");
    await ui.eval(click('Install extensions'));
    const addRows = `[...document.querySelectorAll('ul.avail li')].map(l => l.querySelector('.name').textContent + '|'
        + [...l.querySelectorAll('button')].map(b => b.textContent).join('+'))`;
    await ui.until(`document.querySelectorAll('ul.avail li').length > 0`, 5000);
    const otherTargets = `(b => { b.click(); return true; })(document.querySelector('input[name=other]'))`;
    await ui.eval(otherTargets);
    check((await ui.eval(addRows)).includes('Hello|Open+Update+Remove'),
        `an installed extension in Install extensions has Open, Update and Remove (${await ui.eval(addRows)})`);
    await ui.eval(`[...document.querySelectorAll('ul.avail li')].find(l => /Hello/.test(l.textContent)).querySelector('button.danger').click()`);
    check(await ui.eval(`[...document.querySelectorAll('.prompt')].find(p => !p.hidden)?.innerText`)
        === 'Are you sure you want to remove Hello?\nRemove\nCancel', 'Remove in Install extensions is confirmed');
    await ui.eval(click('Cancel', `[...document.querySelectorAll('.prompt')].find(p => !p.hidden)`));
    await ui.eval(otherTargets);
    await ui.eval(click('Back'));
    await ui.eval(rowClick('Hello', 'Update'));
    await ui.until(`/Updated Hello to v0\\.2\\.0\\./.test(${msg})`, 10000);
    check(await ui.eval(fakeList) === 'hello:1:0.2.0', `Update installed hello 0.2.0 and kept the Tab checkbox (${await ui.eval(fakeList)})`);
    check(await ui.eval(rows) + '' === 'Hello|v0.2.0 latest v0.2.0|UI only|true|Open+Remove', 'no Update once up to date');
    check(await ui.eval(`document.querySelector('iframe[title="Hello"]') !== window.helloFrame
        && document.querySelector('iframe[title="Hello"]') !== null`), 'a loaded extension UI reloads when its extension is updated');
    await shot(ui, 'extensions-updated');

    // Install extensions
    await ui.eval(click('Install extensions'));
    const avail = `[...document.querySelectorAll('ul.avail li')].map(l => l.querySelector('.top').innerText.replace(/\\n/g, ' ')).join(' / ')`;
    await ui.until(`document.querySelectorAll('ul.avail li').length > 0`, 5000);
    check(await ui.eval(`document.querySelector('.count').textContent`) === '3 of 4 available extensions',
        `Any target and One ROM ticked: 3 of 4 (${await ui.eval(`document.querySelector('.count').textContent`)})`);
    check(await ui.eval(`[...document.querySelectorAll('.filters label')].filter(l => !l.hidden).map(l => l.textContent).join()`)
        === 'Any target,One ROM,Other targets', 'the checkboxes: Any target, the firmware found, Other targets');
    check(await ui.eval(avail) === 'Hello v0.2.0 Any target / Local Test v1.0.0 Any target / One Rom Test v1.0.0 One ROM',
        `every extension sorted by name, with version and target (${await ui.eval(avail)})`);
    check(await ui.eval(`[...document.querySelectorAll('ul.avail a.name')].find(a => a.textContent === 'Local Test').href`) === 'https://example.com/local-test',
        'the name links to the source repository');
    await shot(ui, 'add-extensions');
    await ui.eval(`(b => { b.click(); return true; })(document.querySelector('input[name=other]'))`);
    check(await ui.eval(`document.querySelector('.count').textContent`) === '4 of 4 available extensions',
        'Other targets adds One Rom Lab Test');
    await ui.eval(`(s => { s.value = 'babbage'; s.dispatchEvent(new Event('input')); return true; })(document.querySelector('input[name=search]'))`);
    check(await ui.eval(avail) === 'Lab Test v1.0.0 One ROM Lab', `search by author (${await ui.eval(avail)})`);
    await ui.eval(`(s => { s.value = ''; s.dispatchEvent(new Event('input')); return true; })(document.querySelector('input[name=search]'))`);
    // Installing one extension installs only it and no row moves.
    const layout = `[...document.querySelectorAll('ul.avail li')].map(l => l.querySelector('.name').textContent + '@'
        + Math.round(l.getBoundingClientRect().top)).join()`;
    const localTest = `[...document.querySelectorAll('ul.avail li')].find(l => /Local Test/.test(l.textContent))`;
    const layoutBefore = await ui.eval(layout);
    await ui.eval(`${localTest}.querySelector('button').dispatchEvent(new MouseEvent('click', { detail: 2, bubbles: true }))`);
    await new Promise(r => setTimeout(r, 300));
    check(await ui.eval(fakeList) === 'hello:1:0.2.0', 'the second click of a double click installs nothing');
    await shot(ui, 'add-extensions-before-install');
    await ui.eval(click('Install', localTest));
    await ui.until(`/Installed Local Test v1\\.0\\.0\\./.test(${msg})`, 10000);
    check(await ui.eval(fakeList) === 'hello:1:0.2.0,local-test:1:1.0.0',
        `installing Local Test installed only it (${await ui.eval(fakeList)})`);
    check(await ui.eval(layout) === layoutBefore,
        `no row moved (${layoutBefore} then ${await ui.eval(layout)})`);
    check((await ui.eval(addRows)).includes('Local Test|Open+Remove') && (await ui.eval(addRows)).includes('Hello|Open+Remove'),
        `Local Test now has Open and Remove (${await ui.eval(addRows)})`);
    await shot(ui, 'add-extensions-after-install');

    // Remove in Install extensions: the confirmation and the removal move no row.
    await ui.eval(`${localTest}.querySelector('button.danger').click()`);
    check(await ui.eval(layout) === layoutBefore, 'the Remove confirmation moves no row');
    await ui.eval(click('Remove', `[...document.querySelectorAll('.prompt')].find(p => !p.hidden)`));
    await ui.until(`/Removed Local Test\\./.test(${msg})`, 10000);
    check(await ui.eval(fakeList) === 'hello:1:0.2.0' && await ui.eval(layout) === layoutBefore
        && (await ui.eval(addRows)).includes('Local Test|Install'),
        `Remove leaves the row in place with Install (${await ui.eval(layout)}, ${await ui.eval(addRows)})`);
    await ui.eval(click('Install', localTest));
    await ui.until(`/Installed Local Test v1\\.0\\.0\\./.test(${msg})`, 10000);
    check(await ui.eval(tabs) === 'Hello,Local Test,Target,Network,System,Advanced,Extensions',
        `Install adds its tab, ticked as one of the first 3 with a UI (${await ui.eval(tabs)})`);

    // The extension UI and its connection
    await ui.eval(click('Local Test'));
    await frameUntil(ui, LOCAL_UI, `/Allowed|not installed/.test(${frameText})`);
    const log = await inFrame(ui, LOCAL_UI, frameText);
    check(/Connected\. Target firmware 1\./.test(log), 'the extension UI connects with connectExtension() and receives TARGET');
    check(/Reply 3,2,1\./.test(log), "EXT_CMD reaches the extension's own module");
    check(/NOT_PERMITTED: AIRFROG_CMD SET_EXTENSIONS not available to an extension UI\./.test(log),
        'a set command fails without being sent');
    check(/OUT_OF_RANGE: Extension hello not installed\./.test(log), 'EXT_CMD to another extension: not installed');
    check(await ui.eval(`!document.querySelector('iframe[title="Local Test"]').hidden && !/Loading/.test(${msg})`),
        'the frame is displayed once connected');
    await ui.eval(`window.fake.notify('local-test', [9]); window.fake.notify('hello', [8]); true`);
    await frameUntil(ui, LOCAL_UI, `/Notify 9\\./.test(${frameText})`);
    await new Promise(r => setTimeout(r, 300));
    check(!/Notify 8/.test(await inFrame(ui, LOCAL_UI, frameText)), "only the extension's own EXT_NOTIFY is passed on");
    await shot(ui, 'extension-ui-loaded');

    // Airfrog reconnects: the loaded extension UIs reload.
    const commands = `window.fake.received.filter(r => r.type === 0x30).length`;
    const before = await ui.eval(commands);
    await ui.eval('window.fake.closeAll(1001), true');
    await ui.until(`${commands} > ${before}`, 15000);
    check(true, 'the extension UI reloads and connects again when Airfrog reconnects');

    // Reorder by dragging, and the Tab checkbox
    await ui.eval(click('Extensions'));
    await ui.eval(click('Back'));
    await ui.until(`document.querySelectorAll('tr.ext-row').length === 2 && !document.querySelector('tr.ext-row button:disabled')`, 5000);
    await ui.eval(`(() => {
        const [first, second] = document.querySelectorAll('tr.ext-row');
        const dt = new DataTransfer();
        second.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
        first.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
        first.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        second.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
        return true;
    })()`);
    await ui.until(`/Saved\\./.test(${msg})`, 5000);
    await ui.until(`${tabs} === 'Local Test,Hello,Target,Network,System,Advanced,Extensions'`, 5000);
    check(true, 'dragging reorders the tabs');
    check(await ui.eval(fakeList) === 'local-test:1:1.0.0,hello:1:0.2.0', 'the order is saved with SET_EXTENSIONS');
    await ui.until(`!document.querySelector('tr.ext-row button:disabled')`, 5000);
    await ui.eval(`(b => { b.click(); return true; })(document.querySelectorAll('tr.ext-row input[type=checkbox]')[1])`);
    await ui.until(`window.fake.extensions[1].flags === 0`, 5000);
    check(await ui.eval(tabs) === 'Local Test,Target,Network,System,Advanced,Extensions',
        'unticking Tab removes the tab and saves it');
    await ui.until(`!document.querySelector('tr.ext-row button:disabled')`, 5000);
    await ui.eval(rowClick('Hello', 'Open'));
    check(await ui.eval(`!document.querySelector('iframe[title="Hello"]').closest('.ext-pane').hidden`),
        'Open displays an extension UI without a tab');
    await ui.eval(click('Extensions'));
    await shot(ui, 'extensions-reordered');

    // Install from file
    const { root } = await ui.call('DOM.getDocument', { depth: 0 });
    const { nodeId } = await ui.call('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[accept=".afx"]' });
    await ui.call('DOM.setFileInputFiles', { nodeId, files: [path.join(out, 'packages', 'one-rom-test-1.0.0.afx')] });
    await ui.until(`${prompt}`, 5000);
    check(await ui.eval(`${prompt}.innerText`)
        === 'Extensions added from a file have full access to Airfrog.\nInstall\nCancel',
    `the side-load confirmation (${JSON.stringify(await ui.eval(`${prompt}.innerText`))})`);
    check(await ui.eval(`document.activeElement.textContent`) === 'Cancel', 'Cancel has the focus');
    await shot(ui, 'side-load-confirm');
    await ui.eval(click('Install', prompt));
    await ui.until(`/Installed One Rom Test v1\\.0\\.0\\./.test(${msg})`, 10000);
    check((await ui.eval(rows)).includes('One Rom Test|v1.0.0 from file|UI only|true|Open+Remove'),
        `an extension installed from a file is marked from file, without Update (${await ui.eval(rows)})`);
    check(/one-rom-test:3:1\.0\.0/.test(await ui.eval(fakeList)), 'installed with SIDE_LOADED and TAB');
    await shot(ui, 'extensions-side-loaded');

    // Remove
    await ui.eval(rowClick('Local Test', 'Remove'));
    check(await ui.eval(`${prompt}.innerText`)
        === 'Are you sure you want to remove Local Test?\nRemove\nCancel', 'Remove is confirmed');
    await shot(ui, 'remove-confirm');
    await ui.eval(click('Remove', prompt));
    await ui.until(`/Removed Local Test\\./.test(${msg})`, 10000);
    check(await ui.eval(tabs) === 'One Rom Test,Target,Network,System,Advanced,Extensions',
        `Remove closes its tab (${await ui.eval(tabs)})`);
    check(!/local-test/.test(await ui.eval(fakeList)) && await ui.eval(`!document.querySelector('iframe[title="Local Test"]')`),
        'Remove removes the extension and its frame');
    await shot(ui, 'extensions-removed');

    // A failed install
    await ui.eval(click('Install extensions'));
    await ui.eval(`window.fake.config.otaErrors[0x18] = 13, true`);
    await ui.eval(click('Install', `[...document.querySelectorAll('ul.avail li')].find(l => /Local Test/.test(l.textContent))`));
    await ui.until(`/Install failed\\./.test(${msg})`, 10000);
    check(await ui.eval(msg) === 'Install failed. No room for the extension. Remove an extension, then try again.',
        `a failed install (${await ui.eval(msg)})`);
    await shot(ui, 'add-extensions-failed');

    // A page load with a repository extension whose UI is local (D1a): its
    // tab, and the URL hash's, before the Extensions tab is displayed.
    const reloadParams = new URLSearchParams({ extensions: `${REPO}/extensions/manifest.json`,
        installed: `${REPO}/extensions/local-test/1.0.0/wamr-0.0.0/model-0.bin`, module: 'local-test' });
    const again = await cdp.open(`${PAGE}?${reloadParams}#ext-local-test`);
    await again.until(`${tabs} === 'Local Test,Target,Network,System,Advanced,Extensions'`, 15000);
    check(true, "a local UI from a local repository has its tab after a page load");
    await frameUntil(again, LOCAL_UI, `/Reply 3,2,1\\./.test(${frameText})`);
    check(await again.eval(`[...document.querySelectorAll('nav button')].find(b => b.getAttribute('aria-selected') === 'true')
        .textContent`) === 'Local Test', 'the URL hash opens the extension UI tab');

    // The extensions manifest is fetched when the Extensions tab is
    // displayed, not on a page load or when Airfrog reconnects.
    const listFetches = `window.fetched.filter(a => a === '${REPO}/extensions/manifest.json').length`;
    check(await again.eval(listFetches) === 0, "the extensions manifest isn't fetched on a page load");
    const commandsBefore = await again.eval(commands);
    await again.eval('window.fake.closeAll(1001), true');
    await again.until(`${commands} > ${commandsBefore}`, 15000);
    check(await again.eval(listFetches) === 0, "nor when Airfrog reconnects");
    await again.eval(click('Extensions'));
    await again.until(`/latest/.test(document.querySelector('tr.ext-row')?.textContent ?? '')`, 10000);
    check(await again.eval(listFetches) === 1, 'it is fetched when the Extensions tab is displayed');

    // Install from file with the packages airfrog-ext writes: hello has no
    // module, watchdog has images for models 1 and 2.
    const files = await cdp.open(`${PAGE}?${new URLSearchParams({ extensions: `${REPO}/extensions/manifest.json` })}`);
    await files.until(`document.querySelector('nav button')`, 15000);
    await files.eval(`window.fake.config.wamr = [2, 4, 5]; delete ReadableStream.prototype[Symbol.asyncIterator]; true`);
    await files.eval(click('Extensions'));
    await files.until(`document.querySelector('input[accept=".afx"]')`, 5000);
    for (const [file, installedAs] of [['hello-0.3.0.afx', 'hello:3:0.3.0'], ['watchdog-1.0.0.afx', 'watchdog:3:1.0.0']]) {
        const doc = await files.call('DOM.getDocument', { depth: 0 });
        const input = await files.call('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[accept=".afx"]' });
        await files.until(`!document.querySelector('.actions button:disabled')`, 5000);
        await files.call('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [path.join(ROOT, 'tests/ui/fixtures', file)] });
        await files.until(`${prompt} || /failed/.test(${msg})`, 5000);
        check(await files.eval(`!!${prompt}`), `${file} is read (${await files.eval(msg)})`);
        await files.eval(click('Install', prompt));
        await files.until(`/Installed|failed/.test(${msg})`, 10000);
        check(/Installed/.test(await files.eval(msg)) && (await files.eval(fakeList)).includes(installedAs),
            `Install from file installs ${file} (${await files.eval(msg)}, ${await files.eval(fakeList)})`);
    }

    // A status line is 10 px below the buttons above it.
    await files.until(`document.querySelector('.msg:not(:empty)')`, 5000);
    const gap = await files.eval(`(m => Math.round(m.getBoundingClientRect().top
        - m.previousElementSibling.getBoundingClientRect().bottom))([...document.querySelectorAll('.actions + .msg')].find(m => m.offsetParent))`);
    check(gap === 10, `the status line is 10 px below the buttons (${gap})`);
    await shot(files, 'extensions-install-from-file');

    // The password changed from elsewhere: no extension UI login until the
    // user logs in again.
    const locked = await cdp.open(`${PAGE}?password=frog&${reloadParams}`);
    await locked.until(`document.querySelector('input[name=password]')?.offsetParent`, 15000);
    await locked.eval(`(i => { i.value = 'frog'; i.dispatchEvent(new Event('input')); i.form.requestSubmit(); return true; })(
        document.querySelector('input[name=password]'))`);
    await locked.until(`${tabs} === 'Local Test,Target,Network,System,Advanced,Extensions'`, 15000);
    await locked.eval(`window.fake.key = new Uint8Array(32).fill(7); window.fake.closeAll(4003); true`);
    await locked.until(`document.querySelector('input[name=password]')?.offsetParent`, 10000);
    const logins = `window.fake.received.filter(r => r.type === 2).length`;
    const loginsBefore = await locked.eval(logins);
    await locked.eval(click('Local Test'));
    await frameUntil(locked, LOCAL_UI, `/Failed/.test(${frameText})`);
    await new Promise(r => setTimeout(r, 500));
    check(await locked.eval(logins) === loginsBefore,
        `no extension UI login with the old password (${await locked.eval(logins) - loginsBefore} sent)`);
    for (const p of [ui, again, locked]) {
        const errors = p.console.filter(l => l.startsWith('EXCEPTION'));
        check(errors.length === 0, `no exceptions (${errors.join(' | ')})`);
    }
} catch (e) {
    failures++;
    process.stdout.write(`FAIL ${e.message}\n`);
} finally {
    cdp.close();
    chrome.kill();
    server.kill();
    repository.kill();
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
}
process.stdout.write(failures ? `${failures} FAILED\n` : 'all passed\n');
process.exit(failures ? 1 : 0);
