// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// AIRFROG_CMD's parsers and encoders, against byte layouts from
// websocket-protocol.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    Command, RestartMode, encodeAuthorisedWebsite, encodeHostAliases, encodeHostname, encodeOtaBegin, encodeOtaWrite,
    encodeRestart, encodeSetWifiSta, encodeSettings, encodeWifiScan, errorText, parseAuthorisedWebsites, parseBoards,
    parseFwInfo, parseHostAliases, parseHostname, parseHwInfo, parsePinMap, parseSettings, parseWifiAp, parseWifiScan, parseWifiSta,
} from '../../js/setup/protocol.js';
import { FieldError } from '../../js/setup/bytes.js';
import { AirfrogError } from '../../js/airfrog.js';

const b = (...bytes) => new Uint8Array(bytes);
const ascii = (s) => [...s].map(c => c.charCodeAt(0));

test('command IDs', () => {
    assert.deepEqual(Object.values(Command), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
        29, 30, 31, 32, 33, 34, 35, 36]);
});

test('GET_BOARDS', () => {
    const text = (t) => [t.length, 0, ...new TextEncoder().encode(t)];
    assert.deepEqual(parseBoards(b(2, 0, 1, 0, 0, 0, ...text('Pico'), ...text(''),
        4, 1, 0, 0, ...text('One ROM'), ...text('fire-24-f'))),
    [{ board: 1, target: 'Pico', name: '' }, { board: 0x104, target: 'One ROM', name: 'fire-24-f' }]);
    assert.deepEqual(parseBoards(b(0, 0)), []);
    assert.throws(() => parseBoards(b(1, 0, 1, 0, 0, 0)), FieldError);
});

test('GET_HW_INFO', () => {
    const hw = parseHwInfo(b(9, 0, 0, 2, 0, 0, 0x80, 0, 0, 0, 0x80, 0, 1, 2, 3, 4, 5, 6, 0, 0));
    assert.equal(hw.chip, 9);
    assert.deepEqual(hw.chipRev, { major: 0, minor: 2 });
    assert.equal(hw.flash, 0x800000);
    assert.equal(hw.psram, 0x800000);
    assert.deepEqual([...hw.mac], [1, 2, 3, 4, 5, 6]);
    assert.equal(hw.serial, null, 'without the serial number');
    const serial = parseHwInfo(b(9, 0, 0, 2, 0, 0, 0x80, 0, 0, 0, 0x80, 0, 1, 2, 3, 4, 5, 6, 0, 0,
        ...new TextEncoder().encode('4146010203040506')));
    assert.equal(serial.serial, '4146010203040506');
    assert.throws(() => parseHwInfo(b(9, 0)), (e) => /2-byte GET_HW_INFO response/.test(e.detail));
});

test('GET_FW_INFO, with and without the commit', () => {
    const sha = Array.from({ length: 32 }, (_, i) => i);
    const shaHex = sha.map(x => x.toString(16).padStart(2, '0')).join('');
    assert.deepEqual(parseFwInfo(b(0, 2, 13, 0, 3, 0, 0, 0, 0, 0, 0, 0, ...sha)),
        { version: '0.2.13', bootloader: 3, wamr: '0.0.0', sha256: shaHex, commit: '' });
    assert.deepEqual(parseFwInfo(b(0, 2, 13, 0, 3, 0, 0, 0, 2, 4, 5, 0, ...sha, 8, 0, ...new TextEncoder().encode('1a2b3c4d'), 99)),
        { version: '0.2.13', bootloader: 3, wamr: '2.4.5', sha256: shaHex, commit: '1a2b3c4d' });
    assert.throws(() => parseFwInfo(b(0, 2, 13)), (e) => /3-byte GET_FW_INFO response/.test(e.detail));
    assert.throws(() => parseFwInfo(b(0, 2, 13, 0, 3, 0, 0, 0, 0, 0, 0, 0, ...sha.slice(1))),
        (e) => /43-byte GET_FW_INFO response/.test(e.detail), 'a SHA-256 a byte short');
});

test('GET_WIFI_STA', () => {
    const p = b(2, 0, 0xc6, 0, 192, 168, 1, 50, 0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
        1, 0, 0, 0, 255, 255, 255, 0, 192, 168, 1, 1, 8, 8, 8, 8, 0, 0, 4, 0, ...ascii('home'));
    const sta = parseWifiSta(p);
    assert.equal(sta.state, 2);
    assert.equal(sta.rssi, -58);
    assert.deepEqual([...sta.ipv4], [192, 168, 1, 50]);
    assert.equal(sta.ipv6[15], 1);
    assert.equal(sta.ipv4Mode, 1);
    assert.deepEqual([...sta.netmask, ...sta.gateway, ...sta.dns], [255, 255, 255, 0, 192, 168, 1, 1, 8, 8, 8, 8]);
    assert.equal(sta.ssid, 'home');
    assert.equal(sta.password, false);
    const saved = p.slice();
    saved[26] = 1;
    assert.equal(parseWifiSta(saved).password, true);
    const failed = p.slice();
    failed[0] = 3;
    failed[40] = 2;
    assert.deepEqual([parseWifiSta(failed).state, parseWifiSta(failed).reason, parseWifiSta(failed).ssid],
        [3, 2, 'home']);
    assert.throws(() => parseWifiSta(p.subarray(0, 46)), (e) => /GET_WIFI_STA/.test(e.detail));
});

test('GET_WIFI_AP', () => {
    const ap = parseWifiAp(b(1, 0, 2, 0, 192, 168, 4, 1, ...new Array(16).fill(0), 3, 0, ...ascii('afs')));
    assert.deepEqual({ on: ap.on, stations: ap.stations, ssid: ap.ssid }, { on: true, stations: 2, ssid: 'afs' });
    assert.deepEqual([...ap.ipv4], [192, 168, 4, 1]);
});

test('SET_WIFI_STA, DHCP and static', () => {
    assert.deepEqual([...encodeSetWifiSta({ ssid: 'ab', password: '', ipv4: null })],
        [0, 0, 0, 0, ...new Array(16).fill(0), 2, 0, 0x61, 0x62, 0, 0]);
    const fields = encodeSetWifiSta({ ssid: 'n', password: '12345678', ipv4: {
        address: b(10, 0, 0, 2), netmask: b(255, 255, 0, 0), gateway: b(10, 0, 0, 1), dns: b(0, 0, 0, 0) } });
    assert.deepEqual([...fields], [1, 0, 0, 0, 10, 0, 0, 2, 255, 255, 0, 0, 10, 0, 0, 1, 0, 0, 0, 0,
        1, 0, 0x6e, 8, 0, ...ascii('12345678')]);
});

test('SET_WIFI_STA keeping the saved password', () => {
    const fields = encodeSetWifiSta({ ssid: 'ab', password: '', keepPassword: true, ipv4: null });
    assert.deepEqual([...fields.subarray(0, 4)], [0, 0, 1, 0]);
});

test('WIFI_SCAN', () => {
    assert.deepEqual([...encodeWifiScan(true)], [1, 0]);
    assert.deepEqual([...encodeWifiScan(false)], [0, 0]);
    assert.deepEqual(parseWifiScan(b(1, 0, 0, 0)), { state: 1, networks: [] });
    const p = b(2, 0, 2, 0, 0xd8, 1, 6, 0, 4, 0, ...ascii('home'), 0xb0, 2, 11, 0, 2, 0, ...ascii('ab'));
    assert.deepEqual(parseWifiScan(p), { state: 2, networks: [
        { rssi: -40, security: 1, channel: 6, ssid: 'home' }, { rssi: -80, security: 2, channel: 11, ssid: 'ab' }] });
    assert.throws(() => parseWifiScan(p.subarray(0, 12)), (e) => /WIFI_SCAN/.test(e.detail));
});

test('hostname and host aliases', () => {
    assert.equal(parseHostname(b(3, 0, ...ascii('frg'))), 'frg');
    assert.deepEqual([...encodeHostname('frg')], [3, 0, ...ascii('frg')]);
    const aliases = b(2, 0, 1, 0, 0x61, 3, 0, ...ascii('b.c'));
    assert.deepEqual(parseHostAliases(aliases), ['a', 'b.c']);
    assert.deepEqual([...encodeHostAliases(['a', 'b.c'])], [...aliases]);
    assert.deepEqual([...encodeHostAliases([])], [0, 0]);
    assert.throws(() => parseHostAliases(b(2, 0, 1, 0, 0x61)), (e) => /GET_HOST_ALIASES/.test(e.detail));
});

test('authorised websites', () => {
    const list = b(2, 0, 18, 0, ...ascii('https://onerom.org'), 8, 0, ...ascii('http://a'));
    assert.deepEqual(parseAuthorisedWebsites(list), ['https://onerom.org', 'http://a']);
    assert.deepEqual(parseAuthorisedWebsites(b(0, 0)), []);
    assert.throws(() => parseAuthorisedWebsites(b(1, 0, 5, 0)), (e) => /GET_AUTHORISED_WEBSITES/.test(e.detail));
    assert.deepEqual([...encodeAuthorisedWebsite('http://a')], [8, 0, ...ascii('http://a')]);
});

test('GET_PIN_MAP', () => {
    const entry = (name, pin, role, level) => {
        const e = new Uint8Array(24);
        e.set(ascii(name), 0);
        e.set(ascii(pin), 8);
        e[16] = role;
        e[18] = level;
        return [...e];
    };
    const p = b(0x00, 0x01, 0, 0, 20, 0, 10, 0, 100, 0, 2, 0,
        ...entry('RUN', 'J1-4', 1, 1), ...entry('BOOTSEL', 'J1-6', 2, 1));
    assert.deepEqual(parsePinMap(p), { board: 0x100, resetMs: 20, bootDelayMs: 10, bootHoldMs: 100, entries: [
        { name: 'RUN', pin: 'J1-4', role: 1, activeLevel: 1 },
        { name: 'BOOTSEL', pin: 'J1-6', role: 2, activeLevel: 1 }] });
    assert.deepEqual(parsePinMap(b(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)).entries, []);
    assert.throws(() => parsePinMap(p.subarray(0, 40)), (e) => /GET_PIN_MAP/.test(e.detail));
});

test('GET_SETTINGS and SET_SETTINGS', () => {
    const p = b(3, 0, 0, 0, 0xff, 0xff, 0xe8, 0x03, 1, 0, 25, 0, 0x10, 0x0e, 0, 0, 10, 0, 0, 0);
    const s = parseSettings(p);
    assert.deepEqual(s, { board: 3, bootWindowMs: 0xFFFF, changeCheckMs: 1000, bootWindowAutoMs: 25, flags: 1,
        recovery: true, wifiPowerSave: false, wifiRescanS: 3600, wifiRescanDb: 10 });
    assert.deepEqual([...encodeSettings(s)], [...p.subarray(0, 10), 0, 0, ...p.subarray(12)],
        'the automatic boot window isn\'t sent');
    const zero = new Array(20).fill(0);
    const ps = parseSettings(b(0, 0, 0, 0, 0, 0, 0, 0, 2, ...zero.slice(9)));
    assert.equal(ps.recovery, false);
    assert.equal(ps.wifiPowerSave, true);
    const off = { board: 0, bootWindowMs: 0, changeCheckMs: 0, wifiRescanS: 0, wifiRescanDb: 0 };
    assert.deepEqual([...encodeSettings({ ...off, recovery: true, wifiPowerSave: true })],
        [0, 0, 0, 0, 0, 0, 0, 0, 3, ...zero.slice(9)]);
    assert.deepEqual([...encodeSettings({ ...off, recovery: false })], zero);
    // Flags other than recovery and WiFi power save are sent as read.
    assert.deepEqual([...encodeSettings({ ...off, flags: 0x8001, recovery: false, wifiPowerSave: true })],
        [0, 0, 0, 0, 0, 0, 0, 0, 2, 0x80, ...zero.slice(10)]);
    assert.throws(() => parseSettings(p.subarray(0, 16)), (e) => /GET_SETTINGS/.test(e.detail));
});

test('RESTART', () => {
    assert.equal(Command.RESTART, 0x14);
    assert.deepEqual([...encodeRestart(RestartMode.GRACEFUL)], [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual([...encodeRestart(RestartMode.IMMEDIATE, 600000)], [1, 0, 0, 0, 0xc0, 0x27, 0x09, 0]);
});

test('OTA_BEGIN and OTA_WRITE', () => {
    const sha = new Uint8Array(32).fill(0xab);
    assert.deepEqual([...encodeOtaBegin(0x123456, sha, null)], [0x56, 0x34, 0x12, 0, ...sha, ...new Array(74).fill(0)]);
    const signature = Uint8Array.from({ length: 74 }, (_, i) => i);
    assert.deepEqual([...encodeOtaBegin(0x123456, sha, signature)], [0x56, 0x34, 0x12, 0, ...sha, ...signature]);
    assert.deepEqual([...encodeOtaWrite(4096, b(1, 2))], [0, 0x10, 0, 0, 1, 2]);
});

test('error text for ERROR codes airfrog.js reports as CODE', () => {
    assert.match(errorText(new AirfrogError('CODE', 9)), /Update already in progress/);
    assert.match(errorText(new AirfrogError('IMAGE_INVALID')), /Invalid firmware file/);
    assert.match(errorText(new AirfrogError('CODE', 8)), /Internal error/);
    // Other errors keep airfrog.js's message.
    for (const e of [new AirfrogError('CODE', 99), new AirfrogError('OUT_OF_RANGE')]) {
        assert.equal(errorText(e), e.message);
    }
});
