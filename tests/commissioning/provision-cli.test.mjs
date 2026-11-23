// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// provision.mjs over TCP, against the fake Airfrog on a local socket.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import net from 'node:net';
import { Duplex } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Command } from '../../js/setup/protocol.js';

const { SET_HOSTNAME, SET_HOST_ALIASES } = Command;
import { FakeAirfrog } from './fake-airfrog.mjs';

const SCRIPT = fileURLToPath(new URL('provision.mjs', import.meta.url));

function runScript(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

// Runs provision.mjs against a fake Airfrog listening on a local port.
async function withFake(fakeOptions, args) {
  const fakes = [];
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    fakes.push(new FakeAirfrog(Duplex.toWeb(socket), fakeOptions));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const out = await runScript(['127.0.0.1', String(server.address().port), ...args]);
    return { ...out, fake: fakes[0] };
  } finally {
    await Promise.all(fakes.map((f) => f.running));
    await new Promise((resolve) => server.close(resolve));
  }
}

test('sends the settings and prints the result', async () => {
  const { code, stdout, stderr, fake } = await withFake({ joinAfter: 1 }, [
    '--ssid', 'bench-net', '--wifi-password', 'wifi-secret', '--address', '10.0.0.9',
    '--netmask', '255.255.255.0', '--password', 'frog', '--hostname', 'bench',
    '--aliases', 'bench.lan', '--recovery-off', '--wifi-power-save', '--wifi-poll', '5', '--log',
  ]);
  assert.equal(code, 0, stderr);
  assert.equal(stdout, 'Hostname: bench\nURL: http://bench.local/\nWiFi: joined bench-net\n'
    + 'IP address: 10.0.0.9\n');
  assert.match(stderr, /Waiting for Airfrog to start/);
  assert.match(stderr, /airfrog: .*ESP-ROM:esp32c3/);
  assert.equal(fake.hostname, 'bench');
  assert.deepEqual(fake.aliases, ['bench.lan']);
  assert.equal(fake.settings.flags, 2);
  assert.equal(fake.wifi.ssid, 'bench-net');
  assert.ok(fake.password);
});

test('without settings prints the default hostname', async () => {
  const { code, stdout } = await withFake({}, []);
  assert.equal(code, 0);
  assert.equal(stdout, 'Hostname: airfrog\nURL: http://airfrog.local/\nWiFi: not set\n');
});

test('exits with 1 on ERROR', async () => {
  const { code, stderr } = await withFake({ errors: { [SET_HOSTNAME]: 7 } }, ['--hostname', 'bench']);
  assert.equal(code, 1);
  assert.match(stderr, /Hostname save failed\. Invalid value\./);
});

test('changes only the settings its options set', async () => {
  const saved = { hostname: 'bench', aliases: ['a.lan'] };
  const { code, stdout, fake } = await withFake({ saved }, ['--aliases', 'b.lan']);
  assert.equal(code, 0);
  assert.equal(stdout, 'Hostname: bench\nURL: http://bench.local/\nWiFi: not set\n');
  assert.deepEqual(fake.aliases, ['b.lan']);
  const sets = [Command.SET_WIFI_STA, Command.SET_PASSWORD, Command.SET_HOSTNAME, SET_HOST_ALIASES, Command.SET_SETTINGS];
  assert.deepEqual(fake.commands.map((c) => c.cmd).filter((c) => sets.includes(c)), [SET_HOST_ALIASES]);
});

test('exits with 1 when WiFi isn\'t joined', async () => {
  const { code, stdout } = await withFake({ joinAfter: Infinity },
    ['--ssid', 'far-net', '--wifi-poll', '5', '--wifi-timeout', '30']);
  assert.equal(code, 1);
  assert.match(stdout, /WiFi: not joined far-net/);
});

test('exits with 2 on bad arguments', async () => {
  for (const args of [['--timeout', 'x'], ['--nope'], []]) {
    const { code } = await runScript(args.length ? ['127.0.0.1', '1', ...args] : ['127.0.0.1']);
    assert.equal(code, 2, args.join(' '));
  }
});

test('exits with 2 on bad settings, having sent none', async () => {
  for (const args of [['--hostname=-x'], ['--address', '10.0.0.9']]) {
    const { code, fake } = await withFake({}, args);
    assert.equal(code, 2, args.join(' '));
    assert.equal(fake.commands.length, 4, args.join(' '));
  }
});

test('exits with 1 when nothing is listening', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const { code, stderr } = await runScript(['127.0.0.1', String(port)]);
  assert.equal(code, 1);
  assert.match(stderr, /Couldn't connect/);
});
