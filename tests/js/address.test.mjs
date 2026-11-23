// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameable, parseAddress } from '../../web/address.js';

test('a host, with or without a port, is an address in lower case', () => {
    assert.equal(parseAddress('airfrog.local'), 'airfrog.local');
    assert.equal(parseAddress('  Airfrog.LOCAL '), 'airfrog.local');
    assert.equal(parseAddress('192.168.1.5:8080'), '192.168.1.5:8080');
    assert.equal(parseAddress('frog'), 'frog');
    assert.equal(parseAddress('my-frog.example.com'), 'my-frog.example.com');
});

test('a pasted http URL loses its scheme and everything from the first slash', () => {
    assert.equal(parseAddress('http://airfrog.local/'), 'airfrog.local');
    assert.equal(parseAddress('HTTP://airfrog.local:81/a/b?c#d'), 'airfrog.local:81');
    assert.equal(parseAddress('airfrog.local/'), 'airfrog.local');
});

test('anything else is invalid', () => {
    for (const text of ['', ' ', 'https://airfrog.local', 'ftp://airfrog.local', 'user@airfrog.local', 'air frog.local',
        '-a.local', 'a-.local', 'a..local', '.local', 'airfrog.local:', 'airfrog.local:0', 'airfrog.local:65536',
        'airfrog.local:x', 'a:1:2', '[::1]', '[::1]:80', 'airfrog_1.local', '//airfrog.local', '/airfrog.local',
        'http://', '999.1.1.1', '1.2.3', '1', 'a.1', '1.2.3.4.5', '010.0.0.1', '10.0.0.01',
        'airfrog.local?x=1', 'airfrog.local#x']) {
        assert.equal(parseAddress(text), null, JSON.stringify(text));
    }
});

test('a .local name is frameable, with or without a port', () => {
    assert.equal(frameable('airfrog.local'), true);
    assert.equal(frameable('airfrog.local:8080'), true);
    assert.equal(frameable('a.b.local'), true);
    assert.equal(frameable('AIRFROG.LOCAL'), true);
});

test('a private or link-local IPv4 address and 127.0.0.1 are frameable', () => {
    for (const address of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.5',
        '192.168.1.5:8080', '169.254.1.1', '127.0.0.1', '127.0.0.1:18080']) {
        assert.equal(frameable(address), true, address);
    }
});

test('anything else isn\'t frameable', () => {
    for (const address of ['airfrog', 'local', '.local', 'airfrog.local.', 'airfrog.localhost', 'airfrog.example.com',
        'airfrog.local.example.com', 'localhost', '172.15.0.1', '172.32.0.1', '192.169.1.1', '11.0.0.1', '169.253.1.1',
        '8.8.8.8', '127.0.0.2', '127.1', '010.0.0.1', '10.0.0.01', '10.0.0.256', '10.0.0', '10.0.0.1.1', '::1',
        '[::1]', 'fe80::1']) {
        assert.equal(frameable(address), false, address);
    }
});
