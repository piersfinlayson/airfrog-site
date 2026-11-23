// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// A fake Airfrog on the other end of serial. It answers HELLO and the
// AIRFROG_CMD commands commissioning sends, keeps the settings they set and
// writes log lines between its responses.

import { HEADER_RESPONSE } from '../../js/schema.js';
import { concat } from '../../js/setup/bytes.js';
import { LineDecoder, encodeLine } from '../../js/setup/serial.js';
import { Command } from '../../js/setup/protocol.js';

const HELLO = 0x01;
const ERROR = 0x04;
const AIRFROG_CMD = 0x10;
const {
  GET_HW_INFO, GET_FW_INFO, GET_WIFI_AP, GET_PIN_MAP, GET_HOSTNAME, GET_HOST_ALIASES, GET_SETTINGS, GET_WIFI_STA,
  SET_HOSTNAME, SET_HOST_ALIASES, SET_PASSWORD, SET_SETTINGS, SET_WIFI_STA, WIFI_SCAN, GET_BOARDS,
  GET_AUTHORISED_WEBSITES, SET_AUTHORISED_WEBSITES, ADD_AUTHORISED_WEBSITE, REMOVE_AUTHORISED_WEBSITE,
} = Command;
const KEEP_PASSWORD = 0x0001;
const STA_PASSWORD = 0x0001;
const SCAN_START = 0x0001;

const OUT_OF_RANGE = 7;
const NO_SPACE = 13;
const EXISTS = 18;
const NO_ENTRY = 19;
// A website as Airfrog accepts it, roughly.
const WEBSITE = /^https?:\/\/[^/?#\s]+$/;
const utf8 = new TextEncoder();
const text = new TextDecoder();

// A pair of connected byte streams: the client's end and Airfrog's.
export function pipe() {
  const toAirfrog = new TransformStream();
  const toClient = new TransformStream();
  return [
    { readable: toClient.readable, writable: toAirfrog.writable },
    { readable: toAirfrog.readable, writable: toClient.writable },
  ];
}

function le16(n) {
  return new Uint8Array([n & 0xff, n >> 8]);
}

function le32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function textField(s) {
  const b = utf8.encode(s);
  return concat(le16(b.length), b);
}

// Reads a text field, or returns null if it runs past the end.
function readText(p, o) {
  if (o + 2 > p.length) return null;
  const n = p[o] | p[o + 1] << 8;
  if (o + 2 + n > p.length) return null;
  return { value: text.decode(p.subarray(o + 2, o + 2 + n)), end: o + 2 + n };
}

export const NETWORKS = [
  { rssi: -48, security: 1, channel: 6, ssid: 'bench-net' },
  { rssi: -70, security: 0, channel: 1, ssid: 'open-net' },
  { rssi: -81, security: 2, channel: 11, ssid: 'corp-net' },
];

// Options:
//   ignoreHellos  HELLOs to leave unanswered, as while Airfrog starts
//   errors        { [command]: code } to answer with ERROR
//   silent        commands left unanswered
//   joinAfter     GET_WIFI_STA polls that report connecting before connected,
//                 or Infinity
//   failReason    GET_WIFI_STA's reason, when the polls before connected
//                 after the first report a failed join
//   iterations    HELLO's PBKDF2 iteration count
//   helloDelay    ms before answering each HELLO
//   chunk         bytes per write, to split lines across reads
//   saved         settings Airfrog starts with: { hostname, aliases,
//                 websites, settings, wifi }, wifi as the wifi property below
//   scanPolls     WIFI_SCAN requests without START that report scanning, or
//                 Infinity
//   scanFails     a scan ends with state 3
//   networks      the networks a scan finds
export class FakeAirfrog {
  hellos = 0;
  commands = [];
  hostname = 'airfrog';
  aliases = [];
  websites = [];
  settings = { board: 0, bootWindowMs: 0xffff, changeCheckMs: 1000, flags: 1, wifiRescanS: 3600, wifiRescanDb: 10 };
  password = null;
  // { mode, ipv4, ssid, password }. ipv4 is SET_WIFI_STA's 16 bytes of
  // addresses.
  wifi = null;
  polls = 0;
  scan = { state: 0, polls: 0 };

  constructor({ readable, writable }, {
    ignoreHellos = 0, errors = {}, silent = [], joinAfter = 0, failReason = 0, iterations = 1000, helloDelay = 0,
    chunk = 0, saved = {}, scanPolls = 2, scanFails = false, networks = NETWORKS,
  } = {}) {
    this.options = { ignoreHellos, errors, silent, joinAfter, failReason, iterations, helloDelay, chunk, scanPolls,
                     scanFails, networks };
    Object.assign(this, structuredClone(saved));
    this.writer = writable.getWriter();
    this.running = this.#run(readable.getReader());
  }

  async #run(reader) {
    let queue = Promise.resolve();
    const decoder = new LineDecoder((line) => { queue = queue.then(() => this.#handle(line)); });
    await this.log('ESP-ROM:esp32c3-api1-20210207');
    for (;;) {
      let result;
      try {
        result = await reader.read();
      } catch {
        break;
      }
      if (result.done) break;
      decoder.push(result.value);
    }
    await queue;
  }

  async #write(bytes) {
    const n = this.options.chunk || bytes.length;
    try {
      for (let o = 0; o < bytes.length; o += n) await this.writer.write(bytes.subarray(o, o + n));
    } catch {
      // The client has gone.
    }
  }

  log(s) {
    return this.#write(utf8.encode(`\x1b[0;32mI (100) airfrog: ${s}\x1b[0m\r\n`));
  }

  async #handle(line) {
    if (line.log !== undefined) {
      await this.log(`discarded a line that isn't a message: ${line.log}`);
    } else if (line.type === HELLO) {
      this.hellos++;
      if (this.hellos <= this.options.ignoreHellos) return;
      await new Promise((resolve) => setTimeout(resolve, this.options.helloDelay));
      await this.#send(HELLO, this.#hello());
    } else if (line.type === AIRFROG_CMD && line.payload.length >= 2) {
      const cmd = line.payload[0] | line.payload[1] << 8;
      const fields = line.payload.subarray(2);
      this.commands.push({ cmd, fields });
      await this.log(`command ${cmd}`);
      if (this.options.silent.includes(cmd)) return;
      if (this.options.errors[cmd]) {
        await this.#send(ERROR, le16(this.options.errors[cmd]));
        return;
      }
      const response = this.#command(cmd, fields);
      if (response === null) {
        await this.log(`discarded command ${cmd} with ${fields.length} bytes of fields`);
      } else if (typeof response === 'number') {
        await this.#send(ERROR, le16(response));
      } else {
        await this.#send(AIRFROG_CMD, response);
      }
    }
  }

  #send(type, payload) {
    return this.#write(encodeLine(type, payload, HEADER_RESPONSE));
  }

  #hello() {
    const p = new Uint8Array(44);
    p.set(le16(1), 0);
    p.set(le16(this.password ? 1 : 0), 2);
    p.set(le32(4096), 4);
    if (this.password) p.set(this.password.salt, 24);
    p.set(le32(this.options.iterations), 40);
    return p;
  }

  // Returns the response's fields, an error code, or null for a request
  // Airfrog discards.
  #command(cmd, f) {
    const empty = new Uint8Array(0);
    switch (cmd) {
      case GET_HW_INFO:
        return f.length ? null : concat(le16(5), new Uint8Array([0, 4]), le32(4 << 20), le32(0),
          new Uint8Array([0x24, 0x0a, 0xc4, 1, 2, 3]), le16(1), utf8.encode('4146240AC4010203'));
      case GET_FW_INFO:
        return f.length ? null : concat(new Uint8Array([0, 2, 0, 0]), le16(1), le16(0), new Uint8Array(4), textField(''));
      case GET_WIFI_AP:
        return f.length ? null : concat(le16(0), le16(0), new Uint8Array(20), textField('airfrog-0203'));
      case GET_PIN_MAP:
        return f.length ? null : new Uint8Array(12);
      case GET_BOARDS:
        return f.length ? null : concat(le16(2), le32(1), textField('Pico'), textField(''),
          le32(0x104), textField('One ROM'), textField('fire-24-f'));
      case GET_SETTINGS: {
        if (f.length) return null;
        const s = this.settings;
        return concat(le32(s.board), le16(s.bootWindowMs), le16(s.changeCheckMs),
          le16(s.flags), le16(3000), le32(s.wifiRescanS), le16(s.wifiRescanDb), le16(0));
      }
      case SET_SETTINGS: {
        if (f.length !== 20) return null;
        const v = new DataView(f.buffer, f.byteOffset);
        const flags = v.getUint16(8, true);
        const wifiRescanS = v.getUint32(12, true), wifiRescanDb = v.getUint16(16, true);
        if ((flags & ~3) || (wifiRescanS && wifiRescanS < 60) || wifiRescanDb < 1 || wifiRescanDb > 100
          || v.getUint16(18, true)) return OUT_OF_RANGE;
        this.settings = { board: v.getUint32(0, true), bootWindowMs: v.getUint16(4, true),
                          changeCheckMs: v.getUint16(6, true), flags, wifiRescanS, wifiRescanDb };
        return empty;
      }
      case SET_HOST_ALIASES: {
        if (f.length < 2) return null;
        const count = f[0] | f[1] << 8;
        const aliases = [];
        let o = 2;
        for (let i = 0; i < count; i++) {
          const t = readText(f, o);
          if (!t) return null;
          aliases.push(t.value);
          o = t.end;
        }
        if (o !== f.length) return null;
        if (count > 4) return OUT_OF_RANGE;
        this.aliases = aliases;
        return empty;
      }
      case SET_HOSTNAME: {
        const t = readText(f, 0);
        if (!t || t.end !== f.length) return null;
        if (!/^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(t.value)) return OUT_OF_RANGE;
        this.hostname = t.value;
        return empty;
      }
      case SET_AUTHORISED_WEBSITES: {
        if (f.length < 2) return null;
        const count = f[0] | f[1] << 8;
        const websites = [];
        let o = 2;
        for (let i = 0; i < count; i++) {
          const t = readText(f, o);
          if (!t) return null;
          websites.push(t.value.toLowerCase());
          o = t.end;
        }
        if (o !== f.length) return null;
        if (count > 8 || !websites.every(w => WEBSITE.test(w))) return OUT_OF_RANGE;
        this.websites = websites;
        return empty;
      }
      case ADD_AUTHORISED_WEBSITE:
      case REMOVE_AUTHORISED_WEBSITE: {
        const t = readText(f, 0);
        if (!t || t.end !== f.length) return null;
        const website = t.value.toLowerCase();
        if (!WEBSITE.test(website)) return OUT_OF_RANGE;
        const listed = this.websites.includes(website);
        if (cmd === REMOVE_AUTHORISED_WEBSITE) {
          if (!listed) return NO_ENTRY;
          this.websites = this.websites.filter(w => w !== website);
        } else if (listed) {
          return EXISTS;
        } else if (this.websites.length >= 8) {
          return NO_SPACE;
        } else {
          this.websites.push(website);
        }
        return empty;
      }
      case GET_AUTHORISED_WEBSITES:
        return f.length ? null : concat(le16(this.websites.length), ...this.websites.map(textField));
      case GET_HOSTNAME:
        return f.length ? null : textField(this.hostname);
      case GET_HOST_ALIASES:
        return f.length ? null : concat(le16(this.aliases.length), ...this.aliases.map(textField));
      case SET_PASSWORD:
        if (f.length !== 48) return null;
        this.password = { key: f.slice(0, 32), salt: f.slice(32, 48) };
        return empty;
      case SET_WIFI_STA: {
        const ssid = readText(f, 20);
        const password = ssid && readText(f, ssid.end);
        if (!password || password.end !== f.length) return null;
        const mode = f[0] | f[1] << 8;
        const flags = f[2] | f[3] << 8;
        if (ssid.value.length < 1 || ssid.value.length > 32 || mode > 1 || flags & ~KEEP_PASSWORD
            || (flags & KEEP_PASSWORD && password.value)) {
          return OUT_OF_RANGE;
        }
        const kept = flags & KEEP_PASSWORD ? this.wifi?.password ?? '' : password.value;
        this.wifi = { mode, ipv4: f.slice(4, 20), ssid: ssid.value, password: kept };
        this.polls = 0;
        return empty;
      }
      case GET_WIFI_STA: {
        if (f.length) return null;
        const p = new Uint8Array(42);
        if (this.wifi) {
          this.polls++;
          const joined = this.polls > this.options.joinAfter;
          const failed = !joined && this.polls > 1 && this.options.failReason;
          p.set(le16(joined ? 2 : failed ? 3 : 1), 0);
          p.set(le16(failed ? this.options.failReason : 0), 40);
          if (joined) {
            p[2] = -52 & 0xff;
            p.set([192, 168, 1, 77], 4);
            p.set([255, 255, 255, 0, 192, 168, 1, 1, 192, 168, 1, 1], 28);
          }
          if (this.wifi.mode) {
            p.set(this.wifi.ipv4.subarray(0, 4), 4);
            p.set(this.wifi.ipv4.subarray(4), 28);
          }
          p.set(le16(this.wifi.mode), 24);
          p.set(le16(this.wifi.password ? STA_PASSWORD : 0), 26);
        }
        return concat(p, textField(this.wifi ? this.wifi.ssid : ''));
      }
      case WIFI_SCAN: {
        if (f.length !== 2) return null;
        const flags = f[0] | f[1] << 8;
        if (flags & ~SCAN_START) return OUT_OF_RANGE;
        if (flags & SCAN_START && this.scan.state !== 1) {
          this.scan = { state: 1, polls: 0 };
        } else if (!(flags & SCAN_START) && this.scan.state === 1
            && ++this.scan.polls > this.options.scanPolls) {
          this.scan.state = this.options.scanFails ? 3 : 2;
        }
        const networks = this.scan.state === 2 ? this.options.networks : [];
        return concat(le16(this.scan.state), le16(networks.length), ...networks.map((n) =>
          concat(new Uint8Array([n.rssi & 0xff, n.security, n.channel, 0]), textField(n.ssid))));
      }
      default:
        return null;
    }
  }

  async close() {
    try {
      await this.writer.close();
    } catch {
      // Already closed.
    }
  }
}
