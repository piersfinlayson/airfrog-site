// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The settings forms' checks and the fields they encode.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    checkAliases, checkHostname, checkWebsite, checkNewPassword, checkSettings, checkWifi, contiguous, parseIpv4,
} from '../../js/setup/validate.js';
import { encodeSetWifiSta } from '../../js/setup/protocol.js';

const fieldsOf = (r) => r.errors.map(e => e.field);
const wifi = (f) => checkWifi({ ssid: 'home', password: '', staticIpv4: false, ...f });

test('IPv4 addresses and netmasks', () => {
    assert.deepEqual([...parseIpv4(' 192.168.1.5 ')], [192, 168, 1, 5]);
    assert.equal(parseIpv4('192.168.1.256'), null);
    assert.equal(parseIpv4('192.168.1'), null);
    assert.ok(contiguous(new Uint8Array([255, 255, 255, 0])));
    assert.ok(contiguous(new Uint8Array([255, 255, 255, 255])));
    assert.ok(!contiguous(new Uint8Array([255, 0, 255, 0])));
});

test('WiFi with DHCP', () => {
    const r = wifi({ password: 'password1' });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.fields, encodeSetWifiSta({ ssid: 'home', password: 'password1', ipv4: null }));
    assert.deepEqual(wifi({}).fields, encodeSetWifiSta({ ssid: 'home', password: '', ipv4: null }));
});

test('WiFi limits', () => {
    assert.deepEqual(fieldsOf(wifi({ ssid: '' })), ['ssid']);
    assert.deepEqual(fieldsOf(wifi({ ssid: 'x'.repeat(33) })), ['ssid']);
    assert.deepEqual(fieldsOf(wifi({ ssid: 'é'.repeat(17) })), ['ssid']);
    assert.deepEqual(fieldsOf(wifi({ password: '1234567' })), ['password']);
    assert.deepEqual(fieldsOf(wifi({ password: 'x'.repeat(64) })), ['password']);
    assert.equal(wifi({ password: 'x' }).fields, null);
});

test('WiFi keeping the saved password', () => {
    const r = wifi({ keepPassword: true });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.fields, encodeSetWifiSta({ ssid: 'home', password: '', keepPassword: true, ipv4: null }));
});

test('WiFi with a static IPv4 address', () => {
    const r = wifi({ staticIpv4: true, address: '10.0.0.2', netmask: '255.255.255.0', gateway: '10.0.0.1', dns: '' });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.fields, encodeSetWifiSta({ ssid: 'home', password: '', ipv4: {
        address: new Uint8Array([10, 0, 0, 2]), netmask: new Uint8Array([255, 255, 255, 0]),
        gateway: new Uint8Array([10, 0, 0, 1]), dns: new Uint8Array(4) } }));
    assert.deepEqual(fieldsOf(wifi({ staticIpv4: true, address: '', netmask: '255.0.0.0' })), ['address']);
    assert.deepEqual(fieldsOf(wifi({ staticIpv4: true, address: '0.0.0.0', netmask: '255.0.0.0' })), ['address']);
    assert.deepEqual(fieldsOf(wifi({ staticIpv4: true, address: '10.0.0.2', netmask: '255.0.255.0' })), ['netmask']);
    assert.deepEqual(fieldsOf(wifi({ staticIpv4: true, address: '10.0.0.2', netmask: '0.0.0.0' })), ['netmask']);
    assert.deepEqual(fieldsOf(wifi({ staticIpv4: true, address: '10.0.0.2', netmask: '255.0.0.0', dns: 'x' })), ['dns']);
});

test('hostnames', () => {
    assert.deepEqual([...checkHostname('airfrog-2').fields], [9, 0, ...new TextEncoder().encode('airfrog-2')]);
    assert.ok(checkHostname('a').fields);
    assert.ok(checkHostname('a'.repeat(63)).fields);
    for (const bad of ['', '-a', 'a-', 'a.b', 'a_b', 'a'.repeat(64)]) {
        assert.deepEqual(fieldsOf(checkHostname(bad)), ['hostname'], bad);
    }
});

test('host aliases', () => {
    const r = checkAliases(' airfrog.home.lan  af ');
    assert.deepEqual(r.aliases, ['airfrog.home.lan', 'af']);
    assert.deepEqual([...r.fields], [2, 0, 16, 0, ...new TextEncoder().encode('airfrog.home.lan'), 2, 0, 0x61, 0x66]);
    assert.deepEqual([...checkAliases('').fields], [0, 0]);
    assert.deepEqual(fieldsOf(checkAliases('a b c d e')), ['aliases']);
    assert.deepEqual(fieldsOf(checkAliases('a..b')), ['aliases']);
    assert.deepEqual(fieldsOf(checkAliases('a_b')), ['aliases']);
    assert.deepEqual(fieldsOf(checkAliases(`${'a'.repeat(63)}.`.repeat(4) + 'b')), ['aliases']);
    assert.ok(checkAliases(`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`).fields);
});

test('a website for the authorised websites', () => {
    const website = (t) => checkWebsite(t).website;
    assert.equal(website('onerom.org'), 'https://onerom.org', 'https without a scheme');
    assert.equal(website(' OneROM.org '), 'https://onerom.org', 'lower case');
    assert.equal(website('https://onerom.org/'), 'https://onerom.org');
    assert.equal(website('https://onerom.org:443'), 'https://onerom.org', 'without the default port');
    assert.equal(website('http://127.0.0.1:18091'), 'http://127.0.0.1:18091');
    assert.equal(website('localhost:8080'), 'https://localhost:8080');
    assert.equal(website('http://[0:0::1]'), 'http://[::1]');
    const r = checkWebsite('onerom.org');
    assert.deepEqual([...r.fields], [18, 0, ...new TextEncoder().encode('https://onerom.org')]);
    for (const bad of ['', 'ftp://onerom.org', 'onerom.org/web', 'onerom.org?x', 'one_rom.org', 'a..b',
        'user@onerom.org', `${'a'.repeat(64)}.org`, 'http://256.1.1.1']) {
        const e = checkWebsite(bad);
        assert.equal(e.fields, null, bad);
        assert.deepEqual(e.errors, [{ field: 'website', message: `Invalid website ${bad}. Use a host name or IP `
            + 'address with optional http(s):// and :port.' }]);
    }
});

test("Airfrog's new password, entered twice", () => {
    assert.deepEqual(checkNewPassword('frog pond', 'frog pond'), []);
    assert.deepEqual(checkNewPassword('', '').map(e => e.field), ['password']);
    assert.deepEqual(checkNewPassword('a', 'b').map(e => e.field), ['repeat']);
});

test('target settings', () => {
    const rescan = { wifiRescanS: '3600', wifiRescanDb: '10' };
    const tail = [0x10, 0x0e, 0, 0, 10, 0, 0, 0];
    const r = checkSettings({ board: '258', bootWindowAuto: false, bootWindowMs: '2500', changeCheckMs: '0', recovery: false,
        ...rescan });
    assert.deepEqual([...r.fields], [2, 1, 0, 0, 0xc4, 0x09, 0, 0, 0, 0, 0, 0, ...tail]);
    const auto = checkSettings({ board: '0', bootWindowAuto: true, bootWindowMs: 'ignored', changeCheckMs: '1000', recovery: true,
        ...rescan });
    assert.deepEqual([...auto.fields], [0, 0, 0, 0, 0xff, 0xff, 0xe8, 0x03, 1, 0, 0, 0, ...tail]);
    const save = checkSettings({ board: '0', bootWindowAuto: true, changeCheckMs: '1000', recovery: false, wifiPowerSave: true,
        ...rescan });
    assert.deepEqual([...save.fields.subarray(8, 12)], [2, 0, 0, 0]);
    const f = { board: '0', bootWindowAuto: false, bootWindowMs: '10000', changeCheckMs: '65535', recovery: true, ...rescan };
    assert.ok(checkSettings(f).fields);
    assert.deepEqual(fieldsOf(checkSettings({ ...f, bootWindowMs: '10001' })), ['bootWindowMs']);
    assert.deepEqual(fieldsOf(checkSettings({ ...f, bootWindowMs: '' })), ['bootWindowMs']);
    assert.deepEqual(fieldsOf(checkSettings({ ...f, bootWindowMs: '-1' })), ['bootWindowMs']);
    assert.deepEqual(fieldsOf(checkSettings({ ...f, changeCheckMs: '65536' })), ['changeCheckMs']);
    assert.deepEqual(fieldsOf(checkSettings({ ...f, board: 'x' })), ['board']);
    // The rescan interval is 0, or 60 s or more. The threshold is 1 to 100 dB.
    assert.ok(checkSettings({ ...f, wifiRescanS: '0' }).fields);
    assert.ok(checkSettings({ ...f, wifiRescanS: '60', wifiRescanDb: '100' }).fields);
    assert.ok(checkSettings({ ...f, wifiRescanS: '4294967295', wifiRescanDb: '1' }).fields);
    assert.deepEqual(fieldsOf(checkSettings({ ...f, wifiRescanS: '59' })), ['wifiRescanS']);
    assert.deepEqual(fieldsOf(checkSettings({ ...f, wifiRescanS: '4294967296' })), ['wifiRescanS']);
    assert.deepEqual(fieldsOf(checkSettings({ ...f, wifiRescanS: '' })), ['wifiRescanS']);
    assert.deepEqual(fieldsOf(checkSettings({ ...f, wifiRescanDb: '0' })), ['wifiRescanDb']);
    assert.deepEqual(fieldsOf(checkSettings({ ...f, wifiRescanDb: '101' })), ['wifiRescanDb']);
});
