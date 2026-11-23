#!/usr/bin/env node
// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Sends settings to Airfrog over a TCP connection to its serial UART, for
// example QEMU's serial port, with Airfrog's internal JS setup module's serial client, codecs and
// checks. It reads Airfrog's settings and sends those the options change.
// It doesn't reset Airfrog.
//
// Usage: provision.mjs HOST PORT [options]
//
// Prints Airfrog's hostname, URL and WiFi state. Exits with 1 on a failure,
// including WiFi set and not joined, and 2 on bad arguments or settings.

import net from 'node:net';
import { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';
import { concat, utf8 } from '../../js/setup/bytes.js';
import { SerialClient } from '../../js/setup/serial.js';
import {
  Command, StaState, encodeSettings, parseHostAliases, parseHostname, parseSettings, parseWifiSta,
} from '../../js/setup/protocol.js';
import { checkAliases, checkHostname, checkWifi } from '../../js/setup/validate.js';
import { pbkdf2HmacSha256 } from '../../js/sha256.js';

const USAGE = `Usage: provision.mjs HOST PORT [options]

  --ssid NAME            WiFi network
  --wifi-password PW     WiFi password
  --address A            Static IPv4 address
  --netmask M            Static IPv4 subnet mask (default 255.255.255.0)
  --gateway G            Static IPv4 gateway
  --dns D                Static IPv4 DNS server
  --password PW          Airfrog's password
  --hostname NAME        Airfrog's hostname
  --aliases "A B"        Host aliases, separated by spaces
  --recovery-off         Turn recovery off
  --wifi-power-save      Turn WiFi power save on
  --timeout MS           Wait for each response (default 5000)
  --hello-timeout MS     Wait for HELLO's response (default 20000)
  --wifi-timeout MS      Wait for Airfrog to join the network (default 60000)
  --wifi-poll MS         Interval between WiFi state requests (default 2000)
  --log                  Write Airfrog's log to stderr`;

function usage(message) {
  process.stderr.write(`${message ? message + '\n\n' : ''}${USAGE}\n`);
  process.exit(2);
}

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      ssid: { type: 'string' },
      'wifi-password': { type: 'string' },
      address: { type: 'string' },
      netmask: { type: 'string' },
      gateway: { type: 'string' },
      dns: { type: 'string' },
      password: { type: 'string' },
      hostname: { type: 'string' },
      aliases: { type: 'string' },
      'recovery-off': { type: 'boolean' },
      'wifi-power-save': { type: 'boolean' },
      timeout: { type: 'string' },
      'hello-timeout': { type: 'string' },
      'wifi-timeout': { type: 'string' },
      'wifi-poll': { type: 'string' },
      log: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
} catch (e) {
  usage(e.message);
}
const { values: o, positionals } = args;
if (o.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (positionals.length !== 2) usage('HOST and PORT are required.');
const [host, port] = positionals;

function ms(name, fallback) {
  if (o[name] === undefined) return fallback;
  const n = Number(o[name]);
  if (!Number.isInteger(n) || n <= 0) usage(`--${name} is a whole number of milliseconds.`);
  return n;
}

const timing = {
  timeout: ms('timeout', 5000),
  helloTimeout: ms('hello-timeout', 20000),
  wifiTimeout: ms('wifi-timeout', 60000),
  wifiPoll: ms('wifi-poll', 2000),
};

const socket = net.connect({ host, port: Number(port) });
try {
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
} catch (e) {
  process.stderr.write(`Couldn't connect to ${host}:${port}: ${e.message}\n`);
  process.exit(1);
}

const serial = new SerialClient(Duplex.toWeb(socket), {
  onLog: (line) => { if (o.log) process.stderr.write(`airfrog: ${line}\n`); },
});
const onStep = (step) => process.stderr.write(`${step}\n`);
const send = (cmd, fields) => serial.command(cmd, fields, { timeout: timing.timeout });
const WHAT = {
  [Command.SET_SETTINGS]: 'Settings save', [Command.SET_HOST_ALIASES]: 'Host aliases save',
  [Command.SET_HOSTNAME]: 'Hostname save', [Command.SET_PASSWORD]: 'Password save', [Command.SET_WIFI_STA]: 'WiFi network save',
};
const failed = (message) => {
  process.stderr.write(`${message}\n`);
  return 2;
};

// The commands the options require, after Airfrog's settings are read, or
// the errors the checks find.
function changes({ aliases, sta, settings }) {
  const out = [];
  const errors = [];
  if (o['recovery-off'] || o['wifi-power-save']) {
    out.push([Command.SET_SETTINGS, encodeSettings({ ...settings, recovery: o['recovery-off'] ? false : settings.recovery,
      wifiPowerSave: o['wifi-power-save'] || settings.wifiPowerSave })]);
  }
  if (o.aliases !== undefined && o.aliases !== aliases.join(' ')) {
    const r = checkAliases(o.aliases);
    errors.push(...r.errors);
    out.push([Command.SET_HOST_ALIASES, r.fields]);
  }
  if (o.hostname !== undefined) {
    const r = checkHostname(o.hostname);
    errors.push(...r.errors);
    out.push([Command.SET_HOSTNAME, r.fields]);
  }
  if (o.password !== undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    out.push([Command.SET_PASSWORD, concat(pbkdf2HmacSha256(utf8(o.password), salt, hello.iterations), salt)]);
  }
  const fixed = o.address !== undefined || o.netmask !== undefined;
  if (o.ssid !== undefined || o['wifi-password'] !== undefined || fixed) {
    const ssid = o.ssid ?? sta.ssid;
    const keepPassword = o['wifi-password'] === undefined && ssid === sta.ssid && sta.password;
    const r = checkWifi({ ssid, password: o['wifi-password'] ?? '', keepPassword, staticIpv4: fixed,
      address: o.address ?? '', netmask: o.netmask ?? '255.255.255.0', gateway: o.gateway ?? '', dns: o.dns ?? '' });
    errors.push(...r.errors);
    out.push([Command.SET_WIFI_STA, r.fields, ssid]);
  }
  return { commands: out, errors };
}

let hello;
let code = 0;
try {
  onStep('Waiting for Airfrog to start');
  hello = await serial.hello({ timeout: timing.helloTimeout });
  onStep("Reading Airfrog's settings");
  const current = {
    hostname: parseHostname(await send(Command.GET_HOSTNAME)),
    aliases: parseHostAliases(await send(Command.GET_HOST_ALIASES)),
    sta: parseWifiSta(await send(Command.GET_WIFI_STA)),
    settings: parseSettings(await send(Command.GET_SETTINGS)),
  };
  const { commands, errors } = changes(current);
  if (errors.length) {
    code = failed(errors.map((e) => e.message).join('\n'));
  } else {
    let ssid = null;
    for (const [cmd, fields, network] of commands) {
      onStep(`${WHAT[cmd]}`);
      try {
        await send(cmd, fields);
      } catch (e) {
        throw new Error(`${WHAT[cmd]} failed. ${e.message}`);
      }
      ssid = network ?? ssid;
    }
    const hostname = parseHostname(await send(Command.GET_HOSTNAME));
    process.stdout.write(`Hostname: ${hostname}\nURL: http://${hostname}.local/\n`);
    let sta = parseWifiSta(await send(Command.GET_WIFI_STA));
    if (ssid) {
      onStep(`Waiting for Airfrog to join ${ssid}`);
      const deadline = Date.now() + timing.wifiTimeout;
      while (sta.state !== StaState.CONNECTED && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, timing.wifiPoll));
        sta = parseWifiSta(await send(Command.GET_WIFI_STA));
      }
    }
    if (!sta.ssid) {
      process.stdout.write('WiFi: not set\n');
    } else if (sta.state === StaState.CONNECTED) {
      process.stdout.write(`WiFi: joined ${sta.ssid}\nIP address: ${Array.from(sta.ipv4).join('.')}\n`);
    } else {
      process.stdout.write(`WiFi: not joined ${sta.ssid}\n`);
      code = 1;
    }
  }
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  code = 1;
} finally {
  await serial.close();
  socket.destroy();
}
process.exit(code);
