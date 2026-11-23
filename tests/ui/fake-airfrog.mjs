// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// A fake Airfrog for the tests of Airfrog's full user interface, in Node.js and in a browser, built
// from airfrog-v2/docs/websocket-protocol.md. It runs AIRFROG_CMD, TARGET,
// CLAIM, RELEASE, IDENTIFY, TARGET_CMD and EXT_CMD, and restarts after OTA_FINISH and RESTART.
// Its extension commands store extension images without a module, as
// M4P1 firmware does. config.modules makes an extension's EXT_CMD reply.
// Its target is a One ROM: PICOBOOT reads its flash from an image, and its
// firmware's PICOBOOT runs One ROM's GET_CAPS and SERVE_SLOT.

import { hmacSha256, pbkdf2HmacSha256, sha256 } from '../../js/sha256.js';
import { IMAGE_MODEL_OFFSET } from '../../js/schema.js';

export const HELLO = 1, LOGIN = 2, TARGET = 3, ERROR = 4, IDENTIFY = 5, AIRFROG_CMD = 0x10,
    CLAIM = 0x20, RELEASE = 0x21, TARGET_CMD = 0x22, EXT_CMD = 0x30, EXT_NOTIFY = 0x31;

/** The header's flag set on every response. */
const RESPONSE = 0x0001;
export const RESET = 1, SWD_MEMORY = 2, PICOBOOT_RP2350_SWD = 3, PICOBOOT_ORICP = 4, RBCP_ORICP = 5, GPIO = 6;

const ONER = 0x52454e4f;
const PICOBOOT_MAGIC = 0x431fd10b;
const FLASH_BASE = 0x10000000;

export const TARGETS = {
    identifying: { state: 0, swd: 0, targetid: 0, firmware: 0, fwFlags: 0, services: [[RESET, 0], [GPIO, 0]] },
    bootloader: {
        state: 1, swd: 0x3f, targetid: 0x00040927, firmware: 1, fwFlags: 0,
        services: [[RESET, 0], [SWD_MEMORY, 0], [PICOBOOT_RP2350_SWD, 0], [GPIO, 0]],
    },
    running: {
        state: 1, swd: 0x3f, targetid: 0x00040927, firmware: 1, fwFlags: 1,
        services: [[RESET, 0], [SWD_MEMORY, 0], [PICOBOOT_ORICP, 0], [RBCP_ORICP, 0], [GPIO, 0]],
    },
    pico: {
        state: 1, swd: 0x3f, targetid: 0x01002927, firmware: 0, fwFlags: 0,
        services: [[RESET, 0], [SWD_MEMORY, 0], [7, 0], [GPIO, 0]],
    },
};

export const ONE_ROM_PIN_MAP = [
    ['SWDIO', 'J1-3', 0, 0], ['SEL_D', 'J1-3', 0, 0], ['RUN', 'J1-4', 1, 1], ['SWCLK', 'J1-5', 0, 0],
    ['SEL_C', 'J1-5', 0, 0], ['BOOTSEL', 'J1-6', 2, 1],
    ['SEL_B', 'J1-8', 0, 0], ['SEL_A', 'J1-10', 0, 0],
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; }
function u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; }
function cat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
}
function text(s) { const b = encoder.encode(s); return cat(u16(b.length), b); }

/** GET_BOARDS's boards: some of the firmware's. */
const BOARDS = [[1, 'Pico', ''], [2, 'Pico 2', ''], [0x100, 'One ROM', 'fire-24-c'], [0x102, 'One ROM', 'fire-24-e'],
    [0x104, 'One ROM', 'fire-24-f']];
function pad8(s) { const b = new Uint8Array(8); b.set(encoder.encode(s)); return b; }
function view(b) { return new DataView(b.buffer, b.byteOffset, b.byteLength); }
function same(a, b) { return a.length === b.length && a.every((x, i) => x === b[i]); }
function readText(p, at) { const n = view(p).getUint16(at, true); return [decoder.decode(p.subarray(at + 2, at + 2 + n)), at + 2 + n]; }

/**
 * An installed extension from its image, as Airfrog records it. Throws for
 * an image that isn't an extension image.
 */
export function extensionRecord(image, flags) {
    const v = view(image);
    if (decoder.decode(image.subarray(0, 4)) !== 'AFXI') throw new Error('not an extension image');
    const [name, end] = readText(image, 28);
    const metadataOffset = v.getUint32(12, true), metadataLen = v.getUint32(16, true);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(name) || metadataLen > 2048
        || metadataOffset + metadataLen > image.length) {
        throw new Error('invalid extension image');
    }
    return { flags, image, name, header: image.slice(0, end), metadata: image.slice(metadataOffset, metadataOffset + metadataLen),
        moduleLen: v.getUint32(24, true) };
}

export function targetPayload(t) {
    return cat(u16(t.state), u16(t.swd), u32(t.targetid), u32(t.firmware), u16(t.fwFlags), u16(t.services.length * 4),
        ...t.services.map(([s, o]) => cat(u16(s), u16(o))));
}

export class FakeAirfrog {
    constructor(config = {}) {
        this.config = {
            password: null, iterations: 64, maxTransfer: 4096, revision: 1, chip: 5, model: 1, otaModel: null, wamr: [0, 0, 0], version: [0, 2, 0],
            hostname: 'airfrog', aliases: [], websites: [], ssid: 'home', rssi: -52, board: 0x102, pinMap: ONE_ROM_PIN_MAP,
            settings: { board: 0, bootWindowMs: 0xFFFF, changeCheckMs: 1000, flags: 1, wifiRescanS: 3600,
                wifiRescanDb: 10 },
            image: new Uint8Array(0), caps: { extMinor: 3, features: 0x7f }, serveStatus: 0, serveMs: 0, resetMs: 0, saveMs: 0,
            restartMs: 30, newVersion: null, corruptOta: false, rollback: false, otaErrors: {}, busyHolder: null, flashSize: 0x400000,
            extensions: [], modules: {}, installMs: 0,
            commit: '1a2b3c4d', newCommit: '5e6f7a8b', wifiPassword: true, staState: 2, staReason: 0, staStatic: null,
            apOn: false,
            networks: [[-48, 1, 6, 'home'], [-63, 1, 11, 'Workshop'], [-71, 0, 1, 'Cafe guest'], [-84, 2, 6, 'Office']],
            scanMs: 50, apIpv4: [192, 168, 4, 1], staIpv4: [192, 168, 1, 50], bootloader: 1, stuck: false,
            ...config,
        };
        this.target = this.config.target ?? TARGETS.running;
        this.version = this.config.version;
        this.commit = this.config.commit;
        this.wifiPassword = this.config.wifiPassword;
        this.ssid = this.config.ssid;
        this.scan = { state: 0, networks: [] };
        this.settings = { ...this.config.settings };
        this.hostname = this.config.hostname;
        this.aliases = [...this.config.aliases];
        this.websites = [...this.config.websites];
        this.served = 0;
        this.sessions = new Set();
        this.received = [];
        this.closes = [];
        this.claimHolder = null;
        this.restarting = false;
        this.ota = null;
        this.waitingConfirm = false;
        this.confirmed = false;
        // RESTART's modes, in order. A graceful restart doesn't wait for the
        // claim.
        this.restarts = [];
        this.wifi = null;
        this.salt = new Uint8Array(16).fill(7);
        // Installed extensions, in list order: { flags, image, name, header, metadata }
        this.extensions = this.config.extensions.map(({ image, flags }) => extensionRecord(image, flags));
        this.install = null;
        this.key = this.config.password
            ? pbkdf2HmacSha256(encoder.encode(this.config.password), this.salt, this.config.iterations) : null;
    }

    /** A new connection, or null while Airfrog restarts. */
    connect(out, close) {
        if (this.restarting) {
            return null;
        }
        const s = new Session(this, out, close);
        this.sessions.add(s);
        s.start();
        return s;
    }

    /** Sends EXT_NOTIFY from extension name to every logged-in connection. */
    notify(name, data) {
        for (const s of this.sessions) {
            if (s.loggedIn) s.send(EXT_NOTIFY, cat(text(name), new Uint8Array(data)));
        }
    }

    setTarget(t) {
        this.target = t;
        for (const s of this.sessions) {
            if (s.loggedIn) s.send(TARGET, targetPayload(t));
        }
    }

    closeAll(code, reason = '') {
        for (const s of [...this.sessions]) s.close(code, reason);
    }

    /** Restarts, into the new firmware after an update. */
    restart(update) {
        this.closeAll(1001);
        this.restarting = true;
        setTimeout(() => {
            this.restarting = false;
            if (update && this.config.newVersion && !this.config.rollback) {
                this.version = this.config.newVersion;
                this.commit = this.config.newCommit;
                this.waitingConfirm = true;
            }
        }, this.config.restartMs);
    }

    pinMap() {
        const board = this.settings.board || (this.target.state === 1 ? this.config.board : 0);
        const entries = board ? this.config.pinMap : [];
        return cat(u32(board), u16(board ? 20 : 0), u16(board ? 10 : 0), u16(board ? 100 : 0), u16(entries.length),
            ...entries.map(([name, pin, role, level]) => cat(pad8(name), pad8(pin), u16(role), u16(level), new Uint8Array(4))));
    }
}

class Session {
    constructor(fake, out, close) {
        this.fake = fake;
        this.out = out;
        this.closeFn = close;
        this.tx = 0;
        this.rx = 0;
        this.key = null;
        this.loggedIn = false;
        this.closed = false;
        this.ns = crypto.getRandomValues(new Uint8Array(16));
    }

    start() {
        const c = this.fake.config;
        const has = Boolean(this.fake.key);
        this.send(HELLO, cat(u16(c.revision), u16(has ? 1 : 0), u32(c.maxTransfer), has ? this.ns : new Uint8Array(16),
            has ? this.fake.salt : new Uint8Array(16), u32(c.iterations)));
        if (!has) {
            this.loggedIn = true;
            this.send(TARGET, targetPayload(this.fake.target));
        }
    }

    respond(type, payload) {
        this.send(type, payload, RESPONSE);
    }

    send(type, payload, flags = 0) {
        if (this.closed) return;
        this.tx += 1;
        const head = new Uint8Array(16);
        view(head).setUint16(0, type, true);
        view(head).setUint16(2, flags, true);
        view(head).setBigUint64(8, BigInt(this.tx), true);
        const mac = this.key ? hmacSha256(this.key, new Uint8Array([1]), head, payload) : new Uint8Array(32);
        this.out(cat(head, mac, payload));
    }

    close(code, reason = '') {
        if (this.closed) return;
        this.closed = true;
        this.fake.closes.push(code);
        this.ended();
        this.closeFn(code, reason);
    }

    ended() {
        this.closed = true;
        this.fake.sessions.delete(this);
        if (this.fake.claimHolder === this) this.fake.claimHolder = null;
        if (this.fake.ota?.session === this) this.fake.ota = null;
    }

    error(code, detail = new Uint8Array(0)) {
        this.respond(ERROR, cat(u16(code), detail));
    }

    receive(bytes) {
        if (this.closed) return;
        if (bytes.length < 48) return this.close(4000);
        const v = view(bytes);
        const type = v.getUint16(0, true);
        const counter = Number(v.getBigUint64(8, true));
        if (counter !== this.rx + 1) return this.close(4001);
        this.rx = counter;
        const payload = bytes.slice(48);
        if (this.key && !same(hmacSha256(this.key, new Uint8Array([0]), bytes.subarray(0, 16), payload), bytes.subarray(16, 48))) {
            return this.close(4001);
        }
        this.fake.received.push({ type, payload });
        this.handle(type, payload);
    }

    handle(type, payload) {
        const fake = this.fake;
        if (!this.loggedIn) {
            if (type !== LOGIN || payload.length !== 48) return this.close(4000);
            if (fake.config.blockSeconds) return this.close(4007, String(fake.config.blockSeconds));
            const nc = payload.subarray(0, 16);
            if (!same(hmacSha256(fake.key, encoder.encode('login'), this.ns, nc), payload.subarray(16))) {
                return this.close(4002);
            }
            this.respond(LOGIN, hmacSha256(fake.key, encoder.encode('airfrog'), this.ns, nc));
            this.key = hmacSha256(fake.key, encoder.encode('session'), this.ns, nc);
            this.loggedIn = true;
            this.send(TARGET, targetPayload(fake.target));
            return;
        }
        switch (type) {
            case TARGET: return this.respond(TARGET, targetPayload(fake.target));
            case CLAIM:
                if (fake.config.busyHolder !== null) {
                    const extension = encoder.encode(fake.config.busyHolder);
                    return this.error(1, cat(u16(extension.length), extension));
                }
                fake.claimHolder = this;
                return this.respond(CLAIM, new Uint8Array(0));
            case RELEASE:
                if (fake.claimHolder === this) fake.claimHolder = null;
                return this.respond(RELEASE, new Uint8Array(0));
            case AIRFROG_CMD: return this.airfrogCmd(view(payload).getUint16(0, true), payload.subarray(2));
            case IDENTIFY: {
                if (fake.claimHolder !== this) return this.error(2);
                const count = view(payload).getUint16(2, true);
                this.send(TARGET, targetPayload(fake.target));
                return this.respond(IDENTIFY, cat(u16(count), ...Array.from({ length: count }, () => u16(1))));
            }
            case TARGET_CMD: return this.targetCmd(payload);
            case EXT_CMD: {
                const [name, at] = readText(payload, 0);
                if (!fake.extensions.some(x => x.name === name)) return this.error(7);
                const module = fake.config.modules[name];
                if (!module) return this.error(5);
                return this.respond(EXT_CMD, new Uint8Array(module(payload.subarray(at), this)));
            }
            default: return this.close(4000);
        }
    }

    reply(fields) {
        this.respond(AIRFROG_CMD, fields);
    }

    airfrogCmd(cmd, f) {
        const fake = this.fake;
        const c = fake.config;
        const failure = c.otaErrors[cmd];
        if (failure) {
            return this.error(failure);
        }
        switch (cmd) {
            case 0x01: return this.reply(cat(u16(c.chip), new Uint8Array([0, 4]), u32(c.flashSize), u32(0),
                new Uint8Array([0x24, 0x0a, 0xc4, 1, 2, 3]), u16(c.model), encoder.encode('4146240AC4010203')));
            case 0x02: return this.reply(cat(new Uint8Array(fake.version), new Uint8Array(1), u16(c.bootloader), u16(0),
                new Uint8Array([...c.wamr, 0]), text(fake.commit)));
            case 0x03: {
                // staStatic: the saved static address, netmask, gateway and
                // DNS server, reported whether connected or not.
                const on = c.staState === 2;
                const st = c.staStatic;
                const ip = (i, a) => new Uint8Array(st ? st[i] : on ? a : 4);
                return this.reply(cat(u16(c.staState), new Uint8Array([on ? c.rssi & 0xff : 0, 0]), ip(0, c.staIpv4),
                    on ? new Uint8Array([0xfe, 0x80, ...new Array(13).fill(0), 1]) : new Uint8Array(16), u16(st ? 1 : 0),
                    u16(fake.wifiPassword ? 1 : 0), ip(1, [255, 255, 255, 0]), ip(2, [192, 168, 1, 1]),
                    ip(3, [192, 168, 1, 1]), u16(c.staState === 3 ? c.staReason : 0), text(fake.ssid)));
            }
            case 0x04: return this.reply(c.apOn && !fake.apStopped
                ? cat(u16(1), u16(1), new Uint8Array(c.apIpv4), new Uint8Array(16), text('airfrog-1a2b'))
                : cat(u16(0), u16(0), new Uint8Array(4), new Uint8Array(16), text('airfrog-1a2b')));
            case 0x05: {
                const flags = view(f).getUint16(2, true);
                const [ssid, at] = readText(f, 20);
                const [password] = readText(f, at);
                if ((flags & ~1) || ((flags & 1) && password)) return this.error(7);
                fake.wifi = { mode: view(f).getUint16(0, true), keepPassword: Boolean(flags & 1),
                    address: f.slice(4, 8), netmask: f.slice(8, 12), ssid, password };
                fake.ssid = ssid;
                if (!(flags & 1)) fake.wifiPassword = Boolean(password);
                this.reply(new Uint8Array(0));
                return fake.closeAll(4006);
            }
            case 0x06: {
                const key = f.slice(0, 32);
                fake.key = key.every(b => b === 0) ? null : key;
                fake.salt = f.slice(32, 48);
                this.reply(new Uint8Array(0));
                return fake.closeAll(4003);
            }
            case 0x07: return this.reply(text(fake.hostname));
            case 0x08:
                fake.hostname = readText(f, 0)[0];
                this.reply(new Uint8Array(0));
                return fake.closeAll(4006);
            case 0x09: return this.reply(cat(u16(fake.aliases.length), ...fake.aliases.map(text)));
            case 0x0A: {
                const count = view(f).getUint16(0, true);
                if (count > 4) return this.error(7);
                const aliases = [];
                for (let i = 0, at = 2; i < count; i++) {
                    let alias;
                    [alias, at] = readText(f, at);
                    aliases.push(alias);
                }
                fake.aliases = aliases;
                return this.reply(new Uint8Array(0));
            }
            case 0x0B: return this.reply(fake.pinMap());
            case 0x0C: {
                const s = fake.settings;
                return this.reply(cat(u32(s.board), u16(s.bootWindowMs), u16(s.changeCheckMs), u16(s.flags), u16(25),
                    u32(s.wifiRescanS), u16(s.wifiRescanDb), u16(0)));
            }
            case 0x0D: {
                if (f.length !== 20) return this.close(4000);
                const v = view(f);
                const board = v.getUint32(0, true);
                const flags = v.getUint16(8, true);
                const wifiRescanS = v.getUint32(12, true), wifiRescanDb = v.getUint16(16, true);
                if ((board !== 0 && board !== c.board) || (flags & ~3) || (wifiRescanS && wifiRescanS < 60)
                    || wifiRescanDb < 1 || wifiRescanDb > 100) return this.error(7);
                fake.settings = { board, bootWindowMs: v.getUint16(4, true), changeCheckMs: v.getUint16(6, true),
                    flags, wifiRescanS, wifiRescanDb };
                // saveMs holds the reply so the page can be read while it saves.
                if (c.saveMs) {
                    return setTimeout(() => this.reply(new Uint8Array(0)), c.saveMs);
                }
                return this.reply(new Uint8Array(0));
            }
            case 0x0E: {
                if (fake.waitingConfirm || (fake.ota && fake.ota.session !== this)) return this.error(9);
                const size = view(f).getUint32(0, true);
                if (size === 0) return this.error(7);
                fake.ota = { session: this, size, sha256: f.slice(4, 36), data: new Uint8Array(size), written: 0 };
                return this.reply(new Uint8Array(0));
            }
            case 0x0F: {
                const ota = fake.ota;
                if (!ota || ota.session !== this) return this.close(4000);
                const offset = view(f).getUint32(0, true);
                const data = f.subarray(4);
                if (offset !== ota.written || offset + data.length > ota.size || data.length > c.maxTransfer) {
                    return this.error(7);
                }
                ota.data.set(data, offset);
                const held = ota.written;
                ota.written += data.length;
                // As the firmware does, nothing is accepted until the image's first IMAGE_MODEL_OFFSET + 2
                // bytes have arrived and the model there is this Airfrog's.
                if (held < IMAGE_MODEL_OFFSET + 2 && ota.written >= IMAGE_MODEL_OFFSET + 2
                    && (ota.data[0] !== 0xE9
                        || view(ota.data).getUint16(IMAGE_MODEL_OFFSET, true) !== (c.otaModel ?? c.model))) {
                    fake.ota = null;
                    return this.error(16);
                }
                if (c.corruptOta && offset === 0) ota.data[1] ^= 0x01;
                return this.reply(new Uint8Array(0));
            }
            case 0x10: {
                const ota = fake.ota;
                if (!ota || ota.session !== this) return this.close(4000);
                fake.ota = null;
                fake.finished = ota;
                if (ota.written !== ota.size || ota.size < IMAGE_MODEL_OFFSET + 2
                    || !same(sha256(ota.data), ota.sha256)) return this.error(16);
                this.reply(new Uint8Array(0));
                return fake.restart(true);
            }
            case 0x11:
                fake.waitingConfirm = false;
                fake.confirmed = true;
                return this.reply(new Uint8Array(0));
            case 0x13:
                if (f.length) return this.close(4000);
                this.reply(new Uint8Array(0));
                fake.apStopped = Boolean(c.apOn);
                if (fake.apStopped) setTimeout(() => fake.closeAll(1006), 20);
                return;
            case 0x14: {
                if (f.length !== 8) return this.close(4000);
                const v = view(f);
                const mode = v.getUint16(0, true);
                if (mode > 1 || v.getUint16(2, true) || v.getUint32(4, true) > 600000) return this.error(7);
                if (mode === 0 && (fake.ota || fake.waitingConfirm)) return this.error(9);
                fake.restarts.push(mode);
                this.reply(new Uint8Array(0));
                return fake.restart(false);
            }
            case 0x15:
                if (f.length) return this.close(4000);
                return this.reply(new Uint8Array(0));
            case 0x17: return this.reply(cat(u16(fake.extensions.length),
                ...fake.extensions.map(x => cat(u16(x.flags), u16(0), u16(0), x.header))));
            case 0x18: {
                if (f.length !== 40) return this.close(4000);
                if (fake.install && fake.install.session !== this && !fake.install.session.closed) return this.error(10);
                const v = view(f);
                fake.install = { session: this, size: v.getUint32(0, true), sha: f.slice(4, 36),
                    flags: v.getUint16(36, true), data: [] , length: 0 };
                return this.reply(new Uint8Array(0));
            }
            case 0x19: {
                const install = fake.install;
                if (install?.session !== this) return this.close(4000);
                const offset = view(f).getUint32(0, true);
                const data = f.slice(4);
                if (offset !== install.length || offset + data.length > install.size) return this.error(7);
                install.data.push(data);
                install.length += data.length;
                return this.reply(new Uint8Array(0));
            }
            case 0x1A: {
                const install = fake.install;
                if (install?.session !== this) return this.close(4000);
                fake.install = null;
                const image = cat(...install.data);
                if (image.length !== install.size || !same(sha256(image), install.sha)) return this.error(11);
                let record;
                try {
                    record = extensionRecord(image, install.flags);
                } catch (e) {
                    return this.error(11);
                }
                if (record.moduleLen && !c.wamr.every((n, i) => n === image[8 + i])) return this.error(12);
                const done = () => {
                    const at = fake.extensions.findIndex(x => x.name === record.name);
                    if (at >= 0) {
                        const old = fake.extensions[at];
                        record.flags = (old.flags & 1) | (install.flags & 2);
                        fake.extensions[at] = record;
                    } else {
                        fake.extensions.push(record);
                    }
                    this.reply(new Uint8Array(0));
                };
                return c.installMs ? setTimeout(done, c.installMs) : done();
            }
            case 0x1B: {
                const [name] = readText(f, 0);
                const at = fake.extensions.findIndex(x => x.name === name);
                if (at < 0) return this.error(7);
                fake.extensions.splice(at, 1);
                return this.reply(new Uint8Array(0));
            }
            case 0x1C: {
                const count = view(f).getUint16(0, true);
                let at = 2;
                const order = [];
                for (let i = 0; i < count; i++) {
                    const flags = view(f).getUint16(at, true);
                    const [name, next] = readText(f, at + 4);
                    at = next;
                    order.push({ name, flags });
                }
                const names = order.map(o => o.name);
                if (order.some(o => o.flags & ~1) || new Set(names).size !== names.length
                    || names.length !== fake.extensions.length || names.some(n => !fake.extensions.some(x => x.name === n))) {
                    return this.error(7);
                }
                fake.extensions = order.map(o => {
                    const x = fake.extensions.find(y => y.name === o.name);
                    x.flags = (x.flags & ~1) | o.flags;
                    return x;
                });
                return this.reply(new Uint8Array(0));
            }
            case 0x1E:
                if (f.length) return this.close(4000);
                return this.reply(cat(u16(fake.websites.length), ...fake.websites.map(text)));
            case 0x20:
            case 0x21: {
                const [typed] = readText(f, 0);
                const website = typed.toLowerCase();
                const listed = fake.websites.includes(website);
                if (!/^https?:\/\/[^/?#\s]+$/.test(website)) return this.error(7);
                if (cmd === 0x21) {
                    if (!listed) return this.error(19);
                    fake.websites = fake.websites.filter(w => w !== website);
                } else if (listed) {
                    return this.error(18);
                } else if (fake.websites.length >= 8) {
                    return this.error(13);
                } else {
                    fake.websites.push(website);
                }
                return this.reply(new Uint8Array(0));
            }
            case 0x1D: {
                const [name] = readText(f, 0);
                const x = fake.extensions.find(y => y.name === name);
                if (!x) return this.error(7);
                return this.reply(x.metadata);
            }
            case 0x16:
                if (f.length) return this.close(4000);
                return this.reply(cat(u16(BOARDS.length),
                    ...BOARDS.map(([board, target, name]) => cat(u32(board), text(target), text(name)))));
            case 0x12: {
                if (f.length !== 2) return this.close(4000);
                if ((view(f).getUint16(0, true) & 1) && fake.scan.state !== 1) {
                    fake.scan = { state: 1, networks: [] };
                    setTimeout(() => { fake.scan = { state: 2, networks: c.networks }; }, c.scanMs);
                }
                const nets = fake.scan.state === 2 ? fake.scan.networks : [];
                return this.reply(cat(u16(fake.scan.state), u16(nets.length), ...nets.map(([rssi, security, channel, ssid]) =>
                    cat(new Uint8Array([rssi & 0xff, security, channel, 0]), text(ssid)))));
            }
            default: return this.close(4000);
        }
    }

    targetCmd(p) {
        const fake = this.fake;
        const v = view(p);
        const service = v.getUint16(0, true), op = v.getUint16(2, true), fields = p.subarray(4);
        const listed = fake.target.services.some(([s, o]) => s === service && (o === 0 || o === op));
        if (!listed) return this.error(3);
        if (fake.claimHolder !== this && !(service === SWD_MEMORY && op === 1)) return this.error(2);
        if (service === SWD_MEMORY) return this.swdMemory(op, fields);
        if (service === RESET) {
            fake.resetLog = [...(fake.resetLog ?? []), op];
            const after = fake.config.stuck ? fake.target : op === 2 || op === 3 ? TARGETS.bootloader : TARGETS.running;
            // resetMs holds the reset before the target is identified again.
            setTimeout(() => {
                fake.setTarget(TARGETS.identifying);
                this.respond(TARGET_CMD, new Uint8Array(0));
                setTimeout(() => fake.setTarget(after), 20);
            }, fake.config.resetMs);
            return;
        }
        if (op === 2) return this.respond(TARGET_CMD, new Uint8Array(0));
        return this.picoboot(service, fields.subarray(4, 36), fields.subarray(36));
    }

    /**
     * SWD_MEMORY's READ (1) and WRITE (2). Memory that isn't written reads as the low byte of its address.
     * fake.memoryFaults lists the 4-byte units that fault. fake.memoryLog records each request.
     */
    swdMemory(op, fields) {
        const fake = this.fake;
        const v = view(fields);
        const write = op === 2;
        const address = v.getUint32(0, true);
        const width = write ? v.getUint16(4, true) : v.getUint16(8, true);
        const data = write ? fields.subarray(8) : null;
        const length = write ? data.length : v.getUint32(4, true);
        fake.memoryLog = fake.memoryLog ?? [];
        fake.memoryLog.push({ op, address, width, length, flags: write ? v.getUint16(6, true) : v.getUint16(10, true) });
        if (![1, 2, 4].includes(width) || address % width || length % width || !length || length > 4096) return this.error(7);
        fake.memory = fake.memory ?? new Map();
        const out = [];
        for (let i = 0; i < length; i++) {
            if ((fake.memoryFaults ?? []).includes((address + i) - ((address + i) % 4))) return this.error(6);
            if (write) fake.memory.set(address + i, data[i]);
            else out.push(fake.memory.get(address + i) ?? ((address + i) & 0xff));
        }
        return this.respond(TARGET_CMD, new Uint8Array(out));
    }

    picoboot(service, packet, out) {
        const fake = this.fake;
        const pv = view(packet);
        const magic = pv.getUint32(0, true), token = pv.getUint32(4, true), id = packet[8];
        const len = pv.getUint32(12, true), addr = pv.getUint32(16, true), size = pv.getUint32(20, true);
        const status = (code) => cat(u32(token), u32(code), new Uint8Array([id, 0]), new Uint8Array(6));
        const ok = (data = new Uint8Array(0)) => this.respond(TARGET_CMD, cat(status(0), data));
        if (magic === ONER) {
            if (service !== PICOBOOT_ORICP) return this.respond(TARGET_CMD, status(1));
            if (id === 0x82) {
                const caps = new Uint8Array(len);
                caps.set(cat(u16(16), new Uint8Array([1, fake.config.caps.extMinor]), u32(fake.config.caps.features),
                    new Uint8Array([30, 0, 0, 0]), u32(5000)).subarray(0, len));
                return ok(caps);
            }
            if (id === 0x07) {
                const flags = packet[17];
                const st = typeof fake.config.serveStatus === 'function'
                    ? fake.config.serveStatus(packet[16], flags) : fake.config.serveStatus;
                fake.serveRequests = [...(fake.serveRequests ?? []), { slot: packet[16], flags, args: packet.slice(16, 32) }];
                if (st === 0) fake.served = packet[16];
                if (fake.config.serveMs) {
                    setTimeout(() => this.respond(TARGET_CMD, status(st)), fake.config.serveMs);
                    return;
                }
                return this.respond(TARGET_CMD, status(st));
            }
            return this.respond(TARGET_CMD, status(1));
        }
        if (magic !== PICOBOOT_MAGIC) return this.respond(TARGET_CMD, status(1));
        fake.flashLog = fake.flashLog ?? [];
        if (id === 0x84 || id === 0x0A) fake.flashLog.push({ id, address: addr, size: id === 0x84 ? len : 0, data: null });
        switch (id) {
            case 0x84: {
                const off = addr - FLASH_BASE;
                if (off >= 0 && off + len <= 0x2000000) {
                    const data = new Uint8Array(len).fill(0xff);
                    const img = fake.config.image;
                    if (off < img.length) data.set(img.subarray(off, Math.min(img.length, off + len)));
                    return ok(data);
                }
                return this.respond(TARGET_CMD, status(4));
            }
            case 0x03:
            case 0x05:
                fake.flashLog.push({ id, address: addr, size: id === 0x03 ? size : len, data: id === 0x05 ? out.slice() : null });
                return ok();
            case 0x8C: return ok(new Uint8Array(len));
            case 0x0A: {
                this.respond(TARGET_CMD, status(0));
                const flags = pv.getUint32(16, true);
                // stuck: One ROM restarts as it was.
                const after = fake.config.stuck ? fake.target : flags & 2 ? TARGETS.bootloader : TARGETS.running;
                fake.setTarget(TARGETS.identifying);
                setTimeout(() => fake.setTarget(after), 20);
                return;
            }
            default: return id & 0x80 ? ok(new Uint8Array(len)) : ok();
        }
    }
}

/**
 * A browser WebSocket connected to fakes by host. Install it as
 * globalThis.WebSocket.
 */
export class FakeWebSocket {
    static hosts = new Map();

    constructor(url, protocol) {
        this.url = url;
        this.protocol = '';
        this.readyState = 0;
        this.binaryType = 'blob';
        this.onopen = this.onmessage = this.onclose = this.onerror = null;
        const fake = FakeWebSocket.hosts.get(new URL(url).host);
        setTimeout(() => {
            this.session = fake?.connect(
                (bytes) => setTimeout(() => this.readyState === 1 && this.onmessage?.({
                    data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
                }), 0),
                (code, reason) => setTimeout(() => this.closed(code, reason), 0));
            if (!this.session) {
                this.readyState = 3;
                this.onerror?.({});
                this.onclose?.({ code: 1006, reason: '' });
                return;
            }
            this.readyState = 1;
            this.protocol = protocol === 'airfrog-v1' ? protocol : '';
            this.onopen?.({});
        }, 0);
    }

    send(data) {
        if (this.readyState !== 1) throw new Error('not open');
        const copy = new Uint8Array(data).slice();
        setTimeout(() => this.session.receive(copy), 0);
    }

    close(code) {
        if (this.readyState > 1) return;
        this.readyState = 2;
        this.session?.ended();
        setTimeout(() => this.closed(code ?? 1005, ''), 0);
    }

    closed(code, reason) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.onclose?.({ code, reason });
    }
}
