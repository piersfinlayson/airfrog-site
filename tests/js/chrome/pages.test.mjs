// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Airfrog's home page in headless Chrome: Airfrog's full user interface
// (build/test-deps/ui/ui.js) and Airfrog's setup, with Airfrog's internal JS setup
// module (build/test-deps/setup/setup.js), against tests/ui's fake Airfrog. Checks the
// tabs, the Target card, Reset target, the pin tables' width, the engineering
// detail on Advanced, the connector drawings' labels, the recovery setting,
// the firmware manifest's offer, the check of a chosen firmware file, the reason Airfrog's setup displays, the tooltips,
// the System tab's order and Model, the header's model, the browser tab
// title, the header pill, Restart, the rescan settings, a failed join's status
// and the saved static settings while Airfrog isn't connected.
//
// Run ci/test-deps.sh first.
//
// Usage: node tests/js/chrome/pages.test.mjs
//   CHROME  Chrome's path (default: macOS's)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp } from './harness.mjs';
import { IMAGE_MODEL_OFFSET, MODELS, Model } from '../../../build/test-deps/schema/js/schema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 18767;
const PAGE = `http://127.0.0.1:${PORT}/tests/ui/browser/`;
/** The test model that isn't released (ci/schema.py --test). */
const UNRELEASED = Number(Object.keys(MODELS).find(n => MODELS[n].key === null));

let failures = 0;
const check = (ok, what) => {
    if (!ok) failures++;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${what}\n`);
};

const server = spawn(process.execPath, [path.join(ROOT, 'tests/ui/browser/serve.mjs'), String(PORT)],
    { stdio: 'ignore' });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
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
const tabs = `[...document.querySelectorAll('nav button')].map(b => b.textContent).join()`;
const visible = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})]
    .filter(e => e.offsetParent).map(e => e.textContent.trim())`;
const click = (label) => `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)}
    && b.offsetParent).click(), true`;

try {
    const ui = await cdp.open(PAGE);
    await ui.until(ready, 15000);
    check(await ui.eval(tabs) === 'Target,Network,System,Advanced,Extensions',
        'tabs Target, Network, System, Advanced, Extensions: the Target tab is titled Target');
    const header = await ui.eval(`document.querySelector('.bar .sub').textContent`);
    check(/ · Airfrog Mini · firmware v0\.2\.0/.test(header), `Airfrog Mini in the header (${header})`);
    const targetTab = await ui.eval(visible('section h2'));
    check(targetTab.join() === 'Target', `the Target tab holds the Target card (${targetTab})`);
    check(await ui.eval(`document.querySelector('dl.kv dt').textContent + ':' + document.querySelector('dl.kv dd').textContent`)
        === 'Connected:One ROM', 'the Target card identifies the firmware');
    // The fake holds the reset so its progress can be read.
    await ui.eval('window.fake.config.resetMs = 1500');
    await ui.eval(click('Reset target'));
    await ui.until(`/Resetting/.test(${text})`, 5000);
    await ui.eval('window.fake.config.resetMs = 0');
    await ui.until(`!/Resetting/.test(${text}) && document.querySelector('dl.kv dd').textContent === 'One ROM'`, 10000);
    check(true, 'Reset target resets the target and Airfrog identifies it again');
    await ui.eval(click('Advanced'));
    const advanced = await ui.eval(visible('section h2'));
    check(advanced.join() === 'Target,Airfrog pins,Target settings', `Advanced holds the engineering detail (${advanced})`);
    const clipped = await ui.eval(`[...document.querySelectorAll('svg.connector')].flatMap(svg => {
        const box = svg.getBoundingClientRect();
        return [...svg.querySelectorAll('text')].map(t => t.getBoundingClientRect())
            .filter(r => r.left < box.left || r.right > box.right || r.top < box.top || r.bottom > box.bottom)
            .map(r => svg.getAttribute('aria-label'));
    })`);
    check(clipped.length === 0, `each connector drawing contains its labels (${clipped})`);
    const board = await ui.eval(`[...document.querySelectorAll('dt')].find(d => d.textContent === 'Board' && d.offsetParent)
        ?.nextElementSibling.firstChild.textContent`);
    check(/^One ROM fire-/.test(board), `the Board row is named from GET_BOARDS (${board})`);
    const option = await ui.eval(`document.getElementById('board').options[0].textContent`);
    check(/^Automatic( \(One ROM fire-24-[a-z]\))?$/.test(option), `Board type's Automatic (${option})`);
    const services = await ui.eval(`[...document.querySelectorAll('ul.plain li')].filter(l => l.offsetParent)
        .map(l => l.firstChild.textContent + '|' + (l.querySelector('.tip-box')?.textContent ?? '')).join('/')`);
    check(services.includes("RESET|Resets the target using Airfrog's GPIOs."),
        `each service with a description has it as a tooltip (${services})`);
    check(await ui.eval(`document.querySelectorAll('.connector-row table').length`) === 2,
        'one table per connector');
    check(await ui.eval(`[...document.querySelectorAll('.connector-row th')].map(t => t.textContent).join()`)
        === 'Pin,Name,Pin,Name', 'the tables have Pin and Name');
    const pinWidths = await ui.eval(`[...document.querySelectorAll('.connector-row table')].map(t => {
        const width = t.getBoundingClientRect().width;
        t.style.width = 'max-content';
        const content = t.getBoundingClientRect().width;
        t.style.width = '';
        return Math.abs(width - content) < 1;
    })`);
    check(pinWidths.every(Boolean), `each pin table is as wide as its contents (${pinWidths})`);
    check(await ui.eval(`/Airfrog recovery/.test(${text})`), 'bootloader 1: the recovery setting');
    await ui.eval(click('System'));
    await ui.until(`document.getElementById('firmware-offer').offsetParent !== null`, 5000);
    check(await ui.eval(`document.getElementById('firmware-offer').textContent`) === 'Update to v0.2.1 (5e6f7a8b)',
        "the firmware manifest's latest release is offered");
    check(await ui.eval(`[...document.querySelectorAll('dt')].find(d => d.textContent === 'Model')
        ?.nextElementSibling.textContent`) === 'Mini', "the System tab's Model is Mini");
    // A chosen firmware file is checked at once.
    const choose = (project, model = Model.MINI) => `(() => {
        const image = new Uint8Array(2000);
        image[0] = 0xE9;
        new DataView(image.buffer).setUint16(${IMAGE_MODEL_OFFSET}, ${model}, true);
        new DataView(image.buffer).setUint32(32, 0xABCD5432, true);
        image.set(new TextEncoder().encode('0.2.9'), 48);
        image.set(new TextEncoder().encode(${JSON.stringify(project)}), 80);
        const files = new DataTransfer();
        files.items.add(new File([image], 'airfrog-mini.bin'));
        const input = document.querySelector('input[type=file]');
        input.files = files.files;
        input.dispatchEvent(new Event('change'));
        return true;
    })()`;
    const updateButton = `[...document.querySelectorAll('button')].find(b => b.textContent === 'Update').disabled`;
    await ui.eval(choose('other'));
    await ui.until(`document.querySelector('.file-check .cross') !== null`, 5000);
    check(await ui.eval(`document.querySelector('.file-check').textContent`) === 'Invalid firmware file.'
        && await ui.eval(updateButton), 'another project\'s file: a cross, Invalid firmware file., and Update disabled');
    await ui.eval(choose('airfrog', Model.PRO));
    await ui.until(`/model/.test(document.querySelector('.file-check').textContent)`, 5000);
    check(await ui.eval(`document.querySelector('.file-check').textContent`)
        === 'Invalid firmware file (incorrect Airfrog model).' && await ui.eval(updateButton),
    'Pro firmware on a Mini: a cross, the model message, and Update disabled');
    await ui.eval(choose('airfrog'));
    await ui.until(`document.querySelector('.file-check .tick') !== null`, 5000);
    check(await ui.eval(`document.querySelector('.file-check').textContent`) === 'Unsigned firmware.'
        && !await ui.eval(updateButton), 'Airfrog firmware not in the firmware manifest: a tick, Unsigned firmware., '
        + 'and Update enabled');
    const fileHelp = await ui.eval(`[...document.querySelectorAll('label')].find(l => /New firmware file/.test(l.textContent))
        .querySelector('.tip-box').textContent`);
    check(fileHelp === 'Airfrog firmware image airfrog-mini.bin from airfrog.org.', `the file tooltip (${fileHelp})`);
    const system = await ui.eval(visible('section h2'));
    check(system.join() === 'About,Firmware,Password,Authorised websites',
        `System: About, Firmware, Password, Authorised websites (${system})`);
    check(await ui.eval('document.title') === 'airfrog.local', 'the browser tab title is the header title');
    check(await ui.eval(`document.querySelector('.bar .pill').textContent`) === 'One ROM: Running',
        'the header target state is a pill');
    check(await ui.eval(`[...document.querySelectorAll('dt')].some(d => d.textContent === 'Airfrog UI' && d.offsetParent)`),
        'the About card has the Airfrog UI row');

    await ui.eval(click('Restart'));
    check(await ui.eval(`document.activeElement.textContent === 'Cancel' && document.activeElement.className === 'cancel'`)
        && await ui.eval(`/Are you sure you want to restart Airfrog\\?/.test(${text})`),
    'Restart is confirmed, with Cancel focused');
    await ui.eval(`[...document.querySelectorAll('.prompt button')].find(b => b.textContent === 'Restart').click(), true`);
    await ui.until(`/Airfrog restarting\\. Reconnecting/.test(${text})`, 5000);
    check(await ui.eval(`[...document.querySelectorAll('.msg')].filter(m => /Airfrog restarting/.test(m.textContent))
        .every(m => !m.classList.contains('bad'))`), 'the restart is displayed as progress, not as a failure');
    await ui.until(ready, 15000);
    check(await ui.eval('window.fake.restarts.join()') === '0', 'Restart sends a graceful RESTART and reconnects');

    await ui.eval(click('Network'));
    const rescan = await ui.eval(`[...document.querySelectorAll('input[name^=wifiRescan]')].map(i => i.value).join()`);
    check(rescan === '3600,10', `the WiFi card displays the rescan settings (${rescan})`);
    await ui.eval(`(() => { const i = document.querySelector('input[name=wifiRescanS]'); i.value = '600';
        i.dispatchEvent(new Event('input', { bubbles: true })); i.form.requestSubmit(); return true; })()`);
    await ui.until(`window.fake.settings.wifiRescanS === 600`, 5000);
    check(await ui.until(`/Saved\\./.test(${text})`, 5000) !== false, 'the rescan interval is saved');
    const saveAndConnect = await ui.eval(`(() => { const box = document.querySelector('input[name=staticIpv4]');
        box.click(); box.click();
        return [...document.querySelectorAll('button')].find(b => b.textContent === 'Save and connect').disabled; })()`);
    check(saveAndConnect, 'Save and connect stays disabled after Static IP address is ticked and unticked');

    const wifiPill = `[...document.querySelectorAll('section')].find(s => s.querySelector('h2')?.textContent === 'WiFi')
        .querySelector('.pill')`;
    for (const [reason, pill] of [[1, 'Network not found'], [2, 'Wrong password'], [3, 'Connection failed']]) {
        const failed = await cdp.open(`${PAGE}?sta=3&reason=${reason}#network`);
        await failed.until(ready, 15000);
        const shown = await failed.eval(`(p => [p.textContent, p.className])(${wifiPill})`);
        check(shown[0] === pill && shown[1] === 'pill bad', `a failed join, reason ${reason}: ${shown.join(', ')}`);
    }
    const saved = await cdp.open(`${PAGE}?sta=1&static#network`);
    await saved.until(ready, 15000);
    const form = await saved.eval(`(f => [f.staticIpv4.checked, f.address.value, f.netmask.value, f.gateway.value,
        f.dns.value].join())(document.querySelector('input[name=address]').form.elements)`);
    check(form === 'true,192.168.1.60,255.255.255.0,192.168.1.254,',
        `connecting: the form displays the saved static settings (${form})`);

    const tip = await cdp.open(`${PAGE}#advanced`);
    await tip.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
    await tip.until(ready, 15000);
    const box = await tip.eval(`(() => { const t = [...document.querySelectorAll('.tip')].filter(t => t.offsetParent).at(-1);
        t.scrollIntoView({ block: 'center' }); t.click(); const r = t.querySelector('.tip-box').getBoundingClientRect();
        return [r.width > 0, r.left >= 0, r.right <= innerWidth]; })()`);
    check(box.every(v => v), `a tapped tooltip opens inside the window (${box})`);
    const closed = await tip.eval(`(() => { const t = [...document.querySelectorAll('.tip.open')][0];
        t.click(); return !t.classList.contains('open') && getComputedStyle(t.querySelector('.tip-box')).display === 'none'; })()`);
    check(closed, 'a second tap closes it');

    // A file the page's own check accepts, because the device reports its model, which the device's firmware
    // refuses: the device's failure is displayed after Update.
    const refusing = await cdp.open(`${PAGE}?chip=9&model=${Model.PRO}&otamodel=${Model.MINI}#advanced`);
    await refusing.until(ready, 15000);
    await refusing.eval(click('System'));
    await refusing.eval(`(() => {
        const image = new Uint8Array(5000);
        image[0] = 0xE9;
        new DataView(image.buffer).setUint16(${IMAGE_MODEL_OFFSET}, ${Model.PRO}, true);
        new DataView(image.buffer).setUint32(32, 0xABCD5432, true);
        image.set(new TextEncoder().encode('0.2.9'), 48);
        image.set(new TextEncoder().encode('airfrog'), 80);
        const files = new DataTransfer();
        files.items.add(new File([image], 'airfrog-pro.bin'));
        const input = document.querySelector('input[type=file]');
        input.files = files.files;
        input.dispatchEvent(new Event('change'));
        return true;
    })()`);
    await refusing.until(`document.querySelector('.file-check .tick') !== null`, 5000);
    check(await refusing.eval(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Update').disabled`)
        === false, "Pro firmware on a Pro: the page's own check accepts it");
    await refusing.eval(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Update').click(), true`);
    await refusing.until(`/Firmware update failed/.test(document.querySelector('main').innerText)`, 5000);
    const failure = await refusing.eval(`[...document.querySelectorAll('.msg')].map(m => m.textContent)
        .find(t => /Firmware update failed/.test(t))`);
    check(failure === 'Firmware update failed. Invalid firmware file.',
        `the device refusing the image displays its failure (${failure})`);

    const recovery = await cdp.open(`${PAGE}?bootloader=2#advanced`);
    await recovery.until(ready, 15000);
    check(await recovery.eval(`/Airfrog recovery/.test(${text})`),
        'bootloader 2: the recovery setting');

    // The header, the board render, About's Model and the file tooltip of
    // each other model: Pro, a test model whose name has a space, and a
    // test model not released.
    const model = async (chip, number) => {
        const page = await cdp.open(`${PAGE}?chip=${chip}&model=${number}#advanced`);
        await page.until(ready, 15000);
        const header = await page.eval(`document.querySelector('.bar .sub').textContent`);
        const render = await page.eval(`document.querySelector('.board-render').children.length > 0`);
        await page.eval(click('System'));
        const about = await page.eval(`[...document.querySelectorAll('dt')].find(d => d.textContent === 'Model')
            ?.nextElementSibling.textContent`);
        const tip = await page.eval(`(t => (t.hidden ? null : t.querySelector('.tip-box').textContent))(
            [...document.querySelectorAll('label')].find(l => /New firmware file/.test(l.textContent)).querySelector('.tip'))`);
        return { header, render, about, tip };
    };
    const pro = await model(9, Model.PRO);
    check(pro.header.includes('Airfrog Pro') && pro.render && pro.about === 'Pro'
        && pro.tip === 'Airfrog firmware image airfrog-pro.bin from airfrog.org.',
    `Pro: Airfrog Pro in the header, its board render, Pro in About and its file in the tooltip (${JSON.stringify(pro)})`);
    const spaced = await model(5, Model.MINI_V2);
    check(spaced.header.includes('Airfrog Mini v2') && spaced.about === 'Mini v2'
        && spaced.tip === 'Airfrog firmware image airfrog-mini-v2.bin from airfrog.org.',
    `a name with a space: Airfrog Mini v2 in the header, Mini v2 in About, airfrog-mini-v2.bin in the tooltip (${
        JSON.stringify(spaced)})`);
    const other = await model(9, UNRELEASED);
    check(other.header.includes(`Airfrog Model ${UNRELEASED}`) && !other.render
        && other.about === `Model ${UNRELEASED}` && other.tip === null,
    `a model not released: Airfrog Model ${UNRELEASED} in the header, no board render, Model ${UNRELEASED} in `
        + `About and no file tooltip (${JSON.stringify(other)})`);

    const fwInvalid = await cdp.open(`${PAGE}?fwinvalid#system`);
    await fwInvalid.until(ready, 15000);
    check(await fwInvalid.eval(`/Latest release unknown\\. Invalid release list\\./.test(${text})`)
        && !await fwInvalid.eval(`document.getElementById('firmware-offer').offsetParent`),
    'a signed firmware manifest that breaks its rules: Invalid release list. under Version');
    // A chosen file is checked without the invalid firmware manifest, so
    // Airfrog firmware that isn't a release's image isn't marked unsigned.
    await fwInvalid.eval(choose('airfrog'), true);
    await fwInvalid.until(`document.querySelector('.file-check .tick, .file-check .cross') !== null`, 5000);
    const signed = await fwInvalid.eval(`document.querySelector('.file-check .tick') !== null
        ? document.querySelector('.file-check').textContent : 'cross: ' + document.querySelector('.file-check').textContent`);
    check(signed === '', `with an invalid firmware manifest a chosen file isn't marked unsigned (${signed})`);

    const saving = await cdp.open(`${PAGE}#network`);
    await saving.until(ready, 15000);
    const powerSave = `document.querySelector('input[name=wifiPowerSave]')`;
    await saving.eval(`(() => { ${powerSave}.click(); return true; })()`);
    await saving.eval('window.fake.config.saveMs = 1500');
    await saving.eval(`(() => { ${powerSave}.form.querySelector('button').click(); return true; })()`);
    await saving.until(`/Saving/.test(${text})`, 5000);
    check(await saving.eval(`${powerSave}.form.querySelector('button').disabled`), 'Save is disabled while it saves');
    await saving.until(`!/Saving/.test(${text})`, 10000);

    const fwError = await cdp.open(`${PAGE}?fwerror#system`);
    await fwError.until(ready, 15000);
    check(await fwError.eval(`/Latest release unknown\\. Release list signature invalid\\./.test(${text})`),
        "the firmware manifest's failure under Version");

    const reason = 'Download failed. Check internet access.';
    const fallback = await cdp.open(`${PAGE}?fallback=${encodeURIComponent(reason)}`);
    await fallback.until(ready, 15000);
    check(await fallback.eval(tabs) === 'Network,System,Advanced', "Airfrog's setup: Network, System, Advanced");
    check(await fallback.eval(`document.getElementById('reason').hidden === false
        && document.getElementById('reason').textContent`) === `Full Airfrog UI not loaded. ${reason}`,
    'on a network: the reason');
    check(await fallback.eval(`document.getElementById('reason').getAttribute('role')`) === 'status',
        'the reason is a status line');
    check(await fallback.eval(`[...document.querySelectorAll('section.card.warn')].find(s => s.id !== 'reason'
        && s.textContent.startsWith('No password set')).getAttribute('role')`) === 'status',
        'the no-password notice is a status line');

    await fallback.eval(click('System'));
    await fallback.eval(choose('airfrog'));
    await fallback.until(`document.querySelector('.file-check .tick') !== null`, 5000);
    check(await fallback.eval(`document.querySelector('.file-check').textContent`) === 'Unsigned firmware.'
        && await fallback.eval('window.firmwareLoads') === 1,
    'without the firmware manifest, a chosen file loads it once and is marked Unsigned firmware.');

    const ap = await cdp.open(`${PAGE}?fallback=${encodeURIComponent(reason)}&sta=0&ap&open&ssid=`);
    await ap.until(ready, 15000);
    check(await ap.eval(`document.getElementById('reason').hidden`), 'in AP mode: no reason');

    const newer = await cdp.open(`${PAGE}?fallback=Newer%20firmware%20required.%20Update%20firmware.&tab=system`);
    await newer.until(ready, 15000);
    check(await newer.eval(`[...document.querySelectorAll('nav button')].find(b => b.getAttribute('aria-selected') === 'true')
        .textContent`) === 'System', 'newer firmware required: opens on System with the offer');
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
