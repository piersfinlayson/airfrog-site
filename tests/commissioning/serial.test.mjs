// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The serial client and transport of Airfrog's internal JS setup module against
// a fake Airfrog, and airfrog.org/commissioning's messages for its errors.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AIRFROG_CMD, HEADER_RESPONSE } from '../../js/schema.js';
import { ClosedError, HelloTimeoutError, SerialClient, SerialTransport, TimeoutError, decodeLine, encodeLine } from '../../js/setup/serial.js';
import { Command, parseHostname, parseWifiScan, encodeHostname } from '../../js/setup/protocol.js';
import { explainStart } from '../../commissioning/explain.js';
import { FakeAirfrog, pipe } from './fake-airfrog.mjs';

const MODULE = { ClosedError, HelloTimeoutError };

// Runs fn with a serial client and a fake Airfrog. Attaches the fake to what fn
// throws.
async function session(fakeOptions, fn) {
  const [client, airfrog] = pipe();
  const fake = new FakeAirfrog(airfrog, fakeOptions);
  const logs = [];
  const serial = new SerialClient(client, { onLog: (line) => logs.push(line) });
  const begun = Date.now();
  try {
    return await fn({ serial, fake, logs });
  } catch (e) {
    e.fake = fake;
    e.elapsed = Date.now() - begun;
    throw e;
  } finally {
    await serial.close();
    await fake.close();
  }
}

const HELLO = { interval: 10, timeout: 500 };

test('repeats HELLO until Airfrog answers, and passes the log on', async () => {
  await session({ ignoreHellos: 5 }, async ({ serial, fake, logs }) => {
    const hello = await serial.hello(HELLO);
    assert.ok(fake.hellos >= 6);
    assert.ok(hello.iterations > 0);
    assert.ok(logs.length > 0);
  });
});

test('commands through the transport, with lines split into single bytes', async () => {
  await session({ chunk: 1, helloDelay: 25 }, async ({ serial }) => {
    const transport = new SerialTransport(serial, await serial.hello(HELLO));
    assert.equal(transport.closes, false);
    await transport.command(Command.SET_HOSTNAME, encodeHostname('bench'), 200);
    assert.equal(parseHostname(await transport.command(Command.GET_HOSTNAME, undefined, 200)), 'bench');
  });
});

test('requests made at once are sent one at a time, each with its own response', async () => {
  await session({ chunk: 3 }, async ({ serial }) => {
    await serial.hello(HELLO);
    const [saved, hostname, failed] = await Promise.allSettled([
      serial.command(Command.SET_HOSTNAME, encodeHostname('bench')),
      serial.command(Command.GET_HOSTNAME),
      serial.command(Command.SET_HOSTNAME, encodeHostname('-')),
    ]);
    assert.equal(saved.status, 'fulfilled');
    assert.equal(parseHostname(hostname.value), 'bench');
    assert.equal(failed.status, 'rejected', 'an invalid hostname fails, not another request');
    assert.equal(parseHostname(await serial.command(Command.GET_HOSTNAME)), 'bench');
  });
});

test('scans over serial', async () => {
  await session({ scanPolls: 1 }, async ({ serial }) => {
    await serial.hello(HELLO);
    assert.equal(parseWifiScan(await serial.command(Command.WIFI_SCAN, new Uint8Array([1, 0]))).state, 1);
    let scan;
    do {
      scan = parseWifiScan(await serial.command(Command.WIFI_SCAN, new Uint8Array([0, 0])));
    } while (scan.state === 1);
    assert.equal(scan.state, 2);
    assert.equal(scan.networks[0].ssid, 'bench-net');
  });
});

test('HELLO unanswered, with the J2 wiring as the next step', async () => {
  await assert.rejects(session({ ignoreHellos: Infinity }, ({ serial }) => serial.hello({ interval: 10, timeout: 100 })),
    (e) => {
      assert.ok(e instanceof HelloTimeoutError && e instanceof TimeoutError);
      assert.equal(e.message, 'No response from Airfrog firmware after 0.1 s.');
      assert.equal(e.fake.commands.length, 0);
      assert.deepEqual(explainStart(e, MODULE), ['No response from Airfrog over serial.',
        'Check adapter TX to J2 RX, then select Keep current firmware.']);
      return true;
    });
});

test('a command unanswered', async () => {
  await assert.rejects(session({ silent: [Command.SET_HOSTNAME] }, async ({ serial }) => {
    await serial.hello(HELLO);
    await serial.command(Command.SET_HOSTNAME, encodeHostname('bench'), { timeout: 100 });
  }), (e) => {
    assert.ok(e instanceof TimeoutError && !(e instanceof HelloTimeoutError));
    assert.equal(e.message, 'No response from Airfrog over serial (hostname save).');
    assert.deepEqual(explainStart(e, MODULE), ['No response from Airfrog over serial (hostname save).',
      'Select Keep current firmware to try again.']);
    return true;
  });
});

test("ERROR is the WebSocket's error, with its text", async () => {
  await assert.rejects(session({ errors: { [Command.SET_HOSTNAME]: 7 } }, async ({ serial }) => {
    await serial.hello(HELLO);
    await serial.command(Command.SET_HOSTNAME, encodeHostname('bench'));
  }), (e) => {
    assert.equal(e.code, 'OUT_OF_RANGE');
    assert.equal(e.message, 'Invalid value.');
    return true;
  });
});

test('fails at once when the connection closes', async () => {
  await assert.rejects(session({ silent: [Command.SET_HOSTNAME] }, async ({ serial, fake }) => {
    await serial.hello(HELLO);
    setTimeout(() => fake.close(), 50);
    await serial.command(Command.SET_HOSTNAME, encodeHostname('bench'), { timeout: 5000 });
  }), (e) => {
    assert.ok(e instanceof ClosedError);
    assert.equal(e.message, 'Serial connection to Airfrog closed.');
    assert.ok(e.elapsed < 1000, String(e.elapsed));
    assert.deepEqual(explainStart(e, MODULE), ['Serial port failed. Serial connection to Airfrog closed.',
      'Check the adapter is plugged in, then select Connect.']);
    return true;
  });
});

test('takes only a message with RESPONSE set as the response', async () => {
  const [client, airfrog] = pipe();
  const serial = new SerialClient(client);
  const writer = airfrog.writable.getWriter();
  const reader = airfrog.readable.getReader();
  const reply = serial.command(Command.GET_HOSTNAME, undefined, { timeout: 1000 });
  const { value } = await reader.read();
  const request = decodeLine(value.subarray(0, -1));
  assert.deepEqual(request, { type: AIRFROG_CMD, flags: 0, payload: new Uint8Array([Command.GET_HOSTNAME, 0]) });
  await writer.write(encodeLine(AIRFROG_CMD, encodeHostname('wrong')));
  await writer.write(encodeLine(AIRFROG_CMD, encodeHostname('right'), HEADER_RESPONSE));
  assert.equal(parseHostname(await reply), 'right');
  await serial.close();
});
