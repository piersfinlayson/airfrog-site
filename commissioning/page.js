// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// airfrog.org/commissioning. esptool-js identifies Airfrog's MCU and installs
// the firmware over Web Serial. Then the page starts the firmware and runs
// Airfrog's internal JS setup module from the release Airfrog runs over serial,
// which reads Airfrog's settings and changes them.

import { ESPLoader, Transport } from './vendor/esptool.js';
import { explainStart, sentence } from './explain.js';
import { md5Hex } from './md5.js';
import { AIRFROG_MANIFEST, RELEASE_KEYS } from './release-keys.js';
import { InstalledError, checkInstalled } from './image.js';
import {
  ReleaseError, boardModels, findRelease, latestRelease, loadFirmware, loadReleases, loadSetup, modelReleases,
} from './release.js';
import { ClosedError, HelloTimeoutError, SerialClient, SerialTransport } from '../js/setup/serial.js';
import { Command, StaState, parseFwInfo } from '../js/setup/protocol.js';
import { versionText } from '../js/setup/format.js';
import { CHIPS } from '../js/schema.js';
import { prompt, tip } from '../js/setup/dom.js';
import * as MESSAGES from '../js/messages.js';
import {
  COMMISSIONING_CONNECT, COMMISSIONING_DONE, COMMISSIONING_FIRMWARE, UPDATE, VALUES,
} from '../js/messages.js';

// The oldest interface of Airfrog's internal JS setup module this page runs with.
const SETUP_API = 3;
const FLASH_SIZE = 4 * 1024 * 1024;
const FLASH_BAUD = 460800;
const SERIAL_BAUD = 115200;
/** Each MCU's name, as esptool reports it, to its chip. */
const CHIP_NAMES = Object.fromEntries(Object.values(CHIPS).map(c => [c.name, c]));
const LOG_LINES = 5000;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The setup module of a published release adds its own stylesheet, written for
// a whole page, unless an element with this id exists. tool.css styles the
// tool and the page text isn't to change.
const setupStyle = document.createElement('style');
setupStyle.id = 'airfrog-setup-style';
document.head.append(setupStyle);

// The verified firmware manifest.
let firmware = null;
// The message and next step of the manifest's failure to load.
let manifestError = null;
// The releases of the chosen model's firmware, highest first.
let releases = [];
let port = null;
// esptool-js's loader, while the port is open to the ROM loader.
let loader = null;
// The MCU found on connecting: { name, description, flash, psram, psramText }.
let chip = null;
// The model selected in Model: its MODELS entry.
let model = null;
// While Airfrog's firmware runs: the serial client.
let serial = null;
let running = false;

// The log: esptool-js's output and every line from Airfrog that isn't a
// message.

let partial = '';

function log(line) {
  const pre = $('log');
  const follow = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  pre.append(line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') + '\n');
  while (pre.childNodes.length > LOG_LINES) pre.firstChild.remove();
  if (follow) pre.scrollTop = pre.scrollHeight;
}

const terminal = {
  clean() {},
  write(s) {
    const lines = (partial + s).split(/\r?\n/);
    partial = lines.pop();
    lines.forEach(log);
  },
  writeLine(s) {
    log(partial + s);
    partial = '';
  },
};

// Each step's card has a message and a progress bar, with ids prefixed by the
// step. A message is the state, then the next step.

function say(step, text = '', { bad = false, ok = false, next = '' } = {}) {
  $(`${step}-msg`).textContent = [text, next].filter((t) => t).join(' ');
  $(`${step}-msg`).className = bad ? 'msg bad' : ok ? 'msg ok' : 'msg';
}

function fail(step, [text, next]) {
  say(step, text, { bad: true, next });
  progress(step);
}

// fraction is null for a bar without a value, and undefined hides the bar.
function progress(step, fraction) {
  const bar = $(`${step}-progress`);
  bar.hidden = fraction === undefined;
  if (fraction === null) bar.removeAttribute('value');
  else if (fraction !== undefined) bar.value = fraction;
}

function pill(step, text) {
  $(`${step}-pill`).textContent = text || '';
  $(`${step}-pill`).className = text ? 'pill ok' : 'pill';
  $(`${step}-pill`).hidden = !text;
}

// Enables each control for the page's state.
function refresh() {
  $('connect').disabled = running || !('serial' in navigator);
  $('model').disabled = running || !chip || !model;
  $('release').disabled = running || !releases.length;
  $('install').disabled = running || !chip || !$('release').value;
  $('keep').disabled = running || !chip || !model;
}

// Install firmware's confirmation.
const confirmInstall = prompt();

function setRunning(on) {
  running = on;
  if (on) confirmInstall.element.hidden = true;
  refresh();
}

window.addEventListener('beforeunload', (e) => {
  if (running) e.preventDefault();
});

// Closes the port, whoever has it open.
async function closePort() {
  if (loader) {
    const transport = loader.transport;
    loader = null;
    try {
      await transport.disconnect();
    } catch {
      // Already closed.
    }
    return;
  }
  if (serial) {
    const client = serial;
    serial = null;
    await client.close();
  }
  try {
    await port?.close();
  } catch {
    // Not open.
  }
}

// Leaves the settings and done steps, as when Airfrog restarts.
function stopFirmware() {
  saved = null;
  joined = false;
  $('setup').replaceChildren();
  $('done-card').hidden = true;
  pill('firmware');
}

// Connecting

class ConnectError extends Error {
  constructor(message, next) {
    super(message);
    this.next = next;
  }
}

// Resets Airfrog into its ROM loader and checks its MCU. Returns { name,
// description, flash, psram, psramText }: psram is whether the board has PSRAM,
// and psramText is the PSRAM row, null for an MCU without PSRAM.
async function openRom() {
  try {
    loader = new ESPLoader({ transport: new Transport(port, false), baudrate: FLASH_BAUD, terminal });
    const name = loader.chip.CHIP_NAME;
    // As Airfrog's About card displays it: ESP32-C3, revision 0.4.
    const main = await loader.main('default_reset');
    const revision = /revision v?(\d+\.\d+)/.exec(main)?.[1];
    const description = revision ? VALUES.MCU_REVISION(name, revision) : name;
    const chip = CHIP_NAMES[name];
    if (!chip) {
      throw new ConnectError(COMMISSIONING_CONNECT.UNSUPPORTED_MCU(name), COMMISSIONING_CONNECT.CHECK_WIRING);
    }
    // esptool-js's size, for example 4MB, as VALUES.MB or VALUES.KB.
    const size = await loader.detectFlashSize();
    const unit = /^(.*\d)([KM]B)$/.exec(size ?? '');
    const flash = unit ? VALUES[unit[2]](unit[1]) : size;
    let psram = false;
    let psramText = null;
    if (chip.psram) {
      const features = await loader.chip.getChipFeatures(loader);
      // esptool-js's feature, for example "Embedded PSRAM 8MB", with the size as VALUES.MB or VALUES.KB.
      const feature = features.find((f) => f.includes('PSRAM'));
      psram = Boolean(feature);
      psramText = feature?.replace(/(\d+)([KM]B)\b/, (_, n, u) => VALUES[u](n)) || COMMISSIONING_CONNECT.NO_PSRAM;
    }
    const found = { name, description, flash, psram, psramText };
    showChip(found);
    if (flash !== VALUES.MB(4)) {
      throw new ConnectError(
        flash ? COMMISSIONING_CONNECT.UNSUPPORTED_FLASH(flash) : COMMISSIONING_CONNECT.FLASH_UNKNOWN,
        COMMISSIONING_CONNECT.CHECK_WIRING);
    }
    return found;
  } catch (err) {
    await closePort();
    if (err instanceof ConnectError) throw err;
    throw new ConnectError(COMMISSIONING_CONNECT.CONNECTION_FAILED(sentence(err)), COMMISSIONING_CONNECT.HOLD_BOOT);
  }
}

function showChip({ description, flash, psramText }) {
  $('chip-name').textContent = description;
  $('chip-flash').textContent = flash || VALUES.UNKNOWN;
  $('chip-psram-label').hidden = psramText === null;
  $('chip-psram').hidden = psramText === null;
  $('chip-psram').textContent = psramText;
  $('chip').hidden = false;
}

async function connect() {
  let chosen;
  try {
    chosen = await navigator.serial.requestPort();
  } catch {
    return;
  }
  await closePort();
  port = chosen;
  chip = null;
  stopFirmware();
  pill('connect');
  say('firmware');
  progress('firmware');
  $('chip').hidden = true;
  setRunning(true);
  say('connect', COMMISSIONING_CONNECT.CONNECTING);
  progress('connect', null);
  try {
    chip = await openRom();
    pill('connect', COMMISSIONING_CONNECT.CONNECTED);
    say('connect');
    progress('connect');
  } catch (err) {
    fail('connect', [err.message, err.next]);
  } finally {
    showModels();
    setRunning(false);
  }
}

// Lists the models whose firmware runs on the connected Airfrog and selects
// the first.
function showModels() {
  const matches = chip ? boardModels(chip) : [];
  $('model').replaceChildren(...matches.map((v) => new Option(v.name, v.key)));
  model = matches[0] ?? null;
  if (chip && !model) {
    fail('firmware', [COMMISSIONING_FIRMWARE.NOT_RECOGNISED]);
  }
  showReleases();
}

// Lists the releases of the selected model's firmware and selects the
// latest. Nothing is selected when the firmware doesn't have a latest release.
function showReleases() {
  releases = model ? modelReleases(firmware, model.key) : [];
  const latest = model ? latestRelease(firmware, model.key) : null;
  $('release').replaceChildren(...releases.map((r, i) => new Option(versionText(r.version, r.commit), i)));
  $('release').selectedIndex = releases.indexOf(latest);
  if (model && firmware && !releases.length) {
    fail('firmware', [COMMISSIONING_FIRMWARE.NO_RELEASES(model.name)]);
  } else if (model && manifestError) {
    fail('firmware', manifestError);
  }
}

function chooseModel() {
  model = boardModels(chip).find((v) => v.key === $('model').value) ?? null;
  confirmInstall.element.hidden = true;
  say('firmware');
  showReleases();
  refresh();
}

// Installing or keeping the firmware

async function flash() {
  const release = releases[$('release').value];
  const named = versionText(release.version, release.commit);

  say('firmware', UPDATE.DOWNLOADING(named));
  const files = await loadFirmware(release, FLASH_SIZE,
    { onProgress: (done, total) => progress('firmware', done / total) });

  say('firmware', COMMISSIONING_FIRMWARE.ERASING);
  progress('firmware', null);
  await loader.eraseFlash();

  say('firmware', COMMISSIONING_FIRMWARE.INSTALLING(named));
  const total = files.reduce((n, f) => n + f.data.length, 0);
  const before = files.map((_, i) => files.slice(0, i).reduce((n, f) => n + f.data.length, 0));
  await loader.writeFlash({
    fileArray: files.map((f) => ({ data: f.data, address: f.offset })),
    flashMode: 'keep',
    flashFreq: 'keep',
    flashSize: 'keep',
    eraseAll: false,
    compress: true,
    reportProgress: (i, written, size) =>
      progress('firmware', (before[i] + files[i].data.length * written / size) / total),
    calculateMD5Hash: md5Hex,
  });
}

// Reads the firmware Airfrog runs over serial with this page's own serial client,
// whose HELLO and GET_FW_INFO every release has.
async function runningFirmware() {
  const probe = new SerialClient({ readable: port.readable, writable: port.writable }, { onLog: log });
  try {
    const transport = new SerialTransport(probe, await probe.hello());
    return parseFwInfo(await transport.command(Command.GET_FW_INFO, new Uint8Array(0), 10000));
  } finally {
    await probe.close();
  }
}

// Opens the port for serial and resets Airfrog into its firmware: RTS holds EN
// low while DTR keeps IO0 high. Then reads the firmware's version and runs
// Airfrog's internal JS setup module from that release over serial, which reads
// Airfrog's settings.
async function startFirmware() {
  if (!firmware) {
    fail('firmware', [COMMISSIONING_FIRMWARE.RELEASE_LIST_NOT_LOADED, COMMISSIONING_FIRMWARE.RELOAD]);
    return;
  }
  say('firmware', COMMISSIONING_FIRMWARE.STARTING);
  progress('firmware', null);
  await closePort();
  let setup = null;
  let fw;
  try {
    await port.open({ baudRate: SERIAL_BAUD });
    await port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await sleep(100);
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    fw = await runningFirmware();
    const release = findRelease(firmware, model.key, fw.version);
    if (!release) {
      await closePort();
      fail('firmware', [COMMISSIONING_FIRMWARE.NOT_RELEASED(versionText(fw.version, fw.commit)),
        COMMISSIONING_FIRMWARE.SELECT_INSTALL]);
      return;
    }
    setup = await loadSetup(release);
    if (!(setup.API >= SETUP_API)) {
      throw new ReleaseError(COMMISSIONING_FIRMWARE.NOT_SUPPORTED(versionText(release.version, release.commit)));
    }
    serial = new setup.SerialClient({ readable: port.readable, writable: port.writable }, { onLog: log });
    const hello = await serial.hello();
    say('firmware', COMMISSIONING_FIRMWARE.READING_SETTINGS);
    await setup.mountSerial($('setup'), new setup.SerialTransport(serial, hello), { onRender: showDone });
  } catch (err) {
    await closePort();
    fail('firmware', err instanceof ReleaseError ? [sentence(err), COMMISSIONING_FIRMWARE.KEEP_TO_RETRY]
      : explainStart(err, { HelloTimeoutError: setup?.HelloTimeoutError ?? HelloTimeoutError,
        ClosedError: setup?.ClosedError ?? ClosedError }));
    return;
  }
  pill('firmware', versionText(fw.version, fw.commit));
  say('firmware');
  progress('firmware');
}

// The network saved on this page, until Airfrog has joined it.
let saved = null;
// Whether Airfrog has joined the network saved on this page.
let joined = false;

// Once Airfrog has joined the network saved on this page: its home page and
// address.
function showDone(state) {
  const sta = state.sta;
  if (state.joining) {
    saved = state.joining;
    joined = false;
  } else if (saved && sta?.state === StaState.CONNECTED && sta.ssid === saved) {
    joined = true;
  }
  const appearing = joined && $('done-card').hidden;
  $('done-card').hidden = !joined;
  if (!joined || !state.hostname) return;
  if (appearing) $('done-card').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  const url = `http://${state.hostname}.local/`;
  $('url').textContent = url;
  $('url').href = url;
  $('wifi').textContent = COMMISSIONING_DONE.JOINED(sta.ssid);
  $('ip').textContent = Array.from(sta.ipv4).join('.');
  say('done', COMMISSIONING_DONE.COMMISSIONED, { ok: true, next: COMMISSIONING_DONE.DISCONNECT_ADAPTER });
}

// Opens the ROM loader again when Connect's was closed, as it is after
// Airfrog's firmware ran, perhaps for another Airfrog. Returns false after
// displaying the models of the board now connected when the selected model
// doesn't run on it.
async function connectAgain() {
  if (loader) return true;
  say('firmware', COMMISSIONING_CONNECT.CONNECTING);
  progress('firmware', null);
  await closePort();
  chip = await openRom();
  if (boardModels(chip).some((v) => v.key === model.key)) return true;
  showModels();
  if (chip && boardModels(chip).length) fail('firmware', [COMMISSIONING_FIRMWARE.BOARD_CHANGED]);
  return false;
}

// Shows a failure of Install firmware or Keep current firmware. retry is the
// next step after a failure that leaves the board connected.
async function failed(err, retry) {
  if (err instanceof ConnectError) {
    chip = null;
    pill('connect');
    fail('firmware', [err.message, err.next]);
  } else if (err instanceof InstalledError) {
    // The next click connects again.
    if (err.unreadable) await closePort();
    fail('firmware', [err.message, err.next]);
  } else if (err instanceof ReleaseError) {
    fail('firmware', [sentence(err), retry]);
  } else {
    await closePort();
    chip = null;
    pill('connect');
    fail('firmware', [COMMISSIONING_FIRMWARE.WRITE_FAILED(sentence(err)),
      COMMISSIONING_FIRMWARE.CONNECT_TO_RESTART]);
  }
}

async function install() {
  stopFirmware();
  setRunning(true);
  try {
    try {
      if (!await connectAgain()) return;
      await flash();
    } catch (err) {
      await failed(err, COMMISSIONING_FIRMWARE.INSTALL_TO_RETRY);
      return;
    }
    await startFirmware();
  } finally {
    setRunning(false);
  }
}

// Install firmware erases the Airfrog settings, so it is confirmed first.
function askInstall() {
  const release = releases[Number($('release').value)];
  confirmInstall.ask(COMMISSIONING_FIRMWARE.CONFIRM_INSTALL(versionText(release.version, release.commit)),
    COMMISSIONING_FIRMWARE.INSTALL, install);
}

// Keep current firmware starts the firmware on the board after checking, over
// the ROM loader and before anything on the board changes, that it is the
// selected model's.
async function keep() {
  stopFirmware();
  setRunning(true);
  try {
    try {
      if (!await connectAgain()) return;
      await checkInstalled(loader, model);
    } catch (err) {
      await failed(err, COMMISSIONING_FIRMWARE.KEEP_TO_RETRY);
      return;
    }
    await startFirmware();
  } finally {
    setRunning(false);
  }
}

// Start

// Sets each static text of index.html from the message its data-text
// identifies, for example COMMISSIONING.LOG.
function showTexts() {
  for (const e of document.querySelectorAll('[data-text]')) {
    const text = e.dataset.text.split('.').reduce((m, key) => m[key], MESSAGES);
    if (e.classList.contains('tip')) e.replaceWith(tip(text));
    else e.textContent = text;
  }
}

async function start() {
  showTexts();
  if (!('serial' in navigator)) $('no-serial').hidden = false;
  $('model').addEventListener('change', chooseModel);
  $('connect').addEventListener('click', connect);
  $('install').addEventListener('click', askInstall);
  // The confirmation is for the release selected when it was asked.
  $('release').addEventListener('change', () => {
    confirmInstall.element.hidden = true;
    refresh();
  });
  $('install-row').after(confirmInstall.element);
  $('keep').addEventListener('click', keep);
  refresh();
  try {
    firmware = await loadReleases(AIRFROG_MANIFEST, RELEASE_KEYS);
  } catch (err) {
    manifestError = [sentence(err), RELEASE_KEYS.length ? COMMISSIONING_FIRMWARE.RELOAD : ''];
    fail('firmware', manifestError);
    return;
  }
  showReleases();
  refresh();
}

start();
