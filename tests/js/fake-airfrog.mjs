// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// A fake Airfrog for the JS module tests, built from
// airfrog-v2/docs/websocket-protocol.md. Its HMAC and PBKDF2 are node:crypto's,
// so the client's own are checked against them.
//
// The target is a PICOBOOT device with flash that executes READ, WRITE,
// FLASH_ERASE, GET_INFO and REBOOT2. Any other IN command returns zeros and
// any other command succeeds.

import crypto from 'node:crypto';

export const HELLO = 1, LOGIN = 2, TARGET = 3, ERROR = 4, IDENTIFY = 5, AIRFROG_CMD = 0x10,
    CLAIM = 0x20, RELEASE = 0x21, TARGET_CMD = 0x22, EXT_CMD = 0x30, EXT_NOTIFY = 0x31;

/** The header's flag set on every response. */
export const RESPONSE = 0x0001;

export const RESET = 1, SWD_MEMORY = 2, PICOBOOT_RP2350_SWD = 3, PICOBOOT_ORICP = 4, GPIO = 6;

export const TARGETS = {
    identifying: { state: 0, swd: 0, targetid: 0, firmware: 0, fwFlags: 0, services: [[RESET, 0], [GPIO, 0]] },
    bootRom: {
        state: 1, swd: 0x3f, targetid: 0x00040927, firmware: 1, fwFlags: 0,
        services: [[RESET, 0], [SWD_MEMORY, 0], [PICOBOOT_RP2350_SWD, 0], [GPIO, 0]],
    },
    running: {
        state: 1, swd: 0x3f, targetid: 0x00040927, firmware: 1, fwFlags: 1,
        services: [[RESET, 0], [SWD_MEMORY, 0], [PICOBOOT_ORICP, 0], [5, 0], [GPIO, 0]],
    },
    two: {
        state: 1, swd: 0x3f, targetid: 0x00040927, firmware: 1, fwFlags: 1,
        services: [[RESET, 0], [PICOBOOT_RP2350_SWD, 0], [PICOBOOT_ORICP, 0]],
    },
};

function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; }

export function targetPayload(t) {
    return Buffer.concat([u16(t.state), u16(t.swd), u32(t.targetid), u32(t.firmware), u16(t.fwFlags),
        u16(t.services.length * 4), ...t.services.map(([s, o]) => Buffer.concat([u16(s), u16(o)]))]);
}

const hmac = (key, ...parts) => {
    const h = crypto.createHmac('sha256', key);
    parts.forEach(p => h.update(p));
    return h.digest();
};

export class FakeAirfrog {
    constructor(config = {}) {
        this.config = {
            password: null, iterations: 1000, maxTransfer: 4096, revision: 1,
            target: TARGETS.bootRom, busyClaims: 0, busyHolder: '',
            websites: ['https://onerom.org'],
            ...config,
        };
        /** The authorised websites. */
        this.websites = [...this.config.websites];
        /** ERROR codes for the next AIRFROG_CMD commands, by command number. */
        this.cmdErrors = {};
        this.target = this.config.target;
        this.flash = new Map();
        this.memory = new Map();   // SWD_MEMORY's written bytes
        this.memoryFaultFrom = undefined; // SWD_MEMORY faults from this address
        this.received = [];
        this.closes = [];
        this.claimHolder = null;
        this.busyClaims = this.config.busyClaims;
        this.faults = [];         // statuses for the next COMMANDs
        this.dropNext = false;    // the next request isn't answered
        this.delayNext = 0;       // ms before the next request is handled
        this.corruptNext = false; // the next message sent has a bad hmac
        this.endClaimBeforeNext = false;
        this.beforeNext = null;   // {type, payload} sent unsolicited before the next response
        this.extErrors = {};      // ERROR codes for EXT_CMD, by extension name
        this.sessions = new Set();
        this.salt = crypto.randomBytes(16);
        this.key = this.config.password
            ? crypto.pbkdf2Sync(Buffer.from(this.config.password), this.salt, this.config.iterations, 32, 'sha256')
            : null;
    }

    flashAt(addr, len) {
        return Buffer.from(Array.from({ length: len }, (_, i) => this.flash.get(addr + i) ?? 0xff));
    }

    /**
     * A new connection.
     * @param {boolean} framed - false for a bridge, which is logged in and
     *        sends payloads without counter and hmac
     * @param {function(Buffer|{type,payload})} out
     * @param {function(number, string)} close - closes the connection
     */
    connect(framed, out, close) {
        const s = new Session(this, framed, out, close);
        this.sessions.add(s);
        s.start();
        return s;
    }

    /** Sends EXT_NOTIFY from extension name to every logged-in connection. */
    notify(name, data) {
        const n = Buffer.from(name);
        for (const s of this.sessions) {
            if (s.loggedIn) s.send(EXT_NOTIFY, Buffer.concat([u16(n.length), n, Buffer.from(data)]));
        }
    }

    /** Sends TARGET to every logged-in connection. */
    setTarget(t) {
        this.target = t;
        for (const s of this.sessions) {
            if (s.loggedIn) s.send(TARGET, targetPayload(t));
        }
    }
}

class Session {
    constructor(fake, framed, out, close) {
        this.fake = fake;
        this.framed = framed;
        this.out = out;
        this.closeFn = close;
        this.tx = 0;
        this.rx = 0;
        this.key = null;
        this.loggedIn = false;
        this.closed = false;
        this.ns = crypto.randomBytes(16);
    }

    start() {
        const c = this.fake.config;
        if (!this.framed) {
            this.loggedIn = true;
            return;
        }
        const hello = Buffer.concat([u16(c.revision), u16(c.password ? 1 : 0), u32(c.maxTransfer),
            c.password ? this.ns : Buffer.alloc(16), c.password ? this.fake.salt : Buffer.alloc(16), u32(c.iterations)]);
        this.send(HELLO, hello);
        if (!c.password) {
            this.loggedIn = true;
            this.send(TARGET, targetPayload(this.fake.target));
        }
    }

    respond(type, payload) {
        this.waiting = false;
        if (this.fake.beforeNext) {
            const { type: t, payload: p } = this.fake.beforeNext;
            this.fake.beforeNext = null;
            this.send(t, p);
        }
        this.send(type, payload, RESPONSE);
    }

    send(type, payload, flags = 0) {
        if (this.closed) return;
        if (!this.framed) {
            this.out({ type, flags, payload: new Uint8Array(payload) });
            return;
        }
        this.tx += 1;
        const head = Buffer.alloc(16);
        head.writeUInt16LE(type, 0);
        head.writeUInt16LE(flags, 2);
        head.writeBigUInt64LE(BigInt(this.tx), 8);
        const mac = this.key ? hmac(this.key, Buffer.from([1]), head, payload) : Buffer.alloc(32);
        if (this.fake.corruptNext) {
            this.fake.corruptNext = false;
            mac[0] ^= 1;
        }
        this.out(Buffer.concat([head, mac, payload]));
    }

    close(code, reason = '') {
        if (this.closed) return;
        this.closed = true;
        this.fake.closes.push(code);
        this.fake.sessions.delete(this);
        if (this.fake.claimHolder === this) this.fake.claimHolder = null;
        this.closeFn(code, reason);
    }

    /** The peer closed the connection. */
    ended() {
        this.closed = true;
        this.fake.sessions.delete(this);
        if (this.fake.claimHolder === this) this.fake.claimHolder = null;
    }

    error(code, detail = Buffer.alloc(0)) {
        this.respond(ERROR, Buffer.concat([u16(code), detail]));
    }

    /** A message from the client: a framed Buffer, or {type, payload} from a bridge. */
    receive(message) {
        if (this.closed) return;
        let type, payload;
        if (this.framed) {
            const b = Buffer.from(message);
            if (b.length < 48) return this.close(4000);
            type = b.readUInt16LE(0);
            const counter = Number(b.readBigUInt64LE(8));
            if (counter !== this.rx + 1) return this.close(4001);
            this.rx = counter;
            payload = b.subarray(48);
            if (this.key && !hmac(this.key, Buffer.from([0]), b.subarray(0, 16), payload).equals(b.subarray(16, 48))) {
                return this.close(4001);
            }
        } else {
            ({ type } = message);
            payload = Buffer.from(message.payload);
        }
        this.fake.received.push({ type, payload });
        if (this.loggedIn && this.fake.config.oneRequest) {
            // A second request before the response closes the connection.
            if (this.waiting) return this.close(4000);
            this.waiting = true;
        }
        if (this.loggedIn && this.fake.delayNext) {
            const ms = this.fake.delayNext;
            this.fake.delayNext = 0;
            setTimeout(() => this.handle(type, payload), ms);
            return;
        }
        this.handle(type, payload);
    }

    handle(type, payload) {
        const fake = this.fake;
        if (!this.loggedIn) {
            if (type !== LOGIN || payload.length !== 48) return this.close(4000);
            if (fake.config.blockSeconds) return this.close(4007, String(fake.config.blockSeconds));
            const nc = payload.subarray(0, 16);
            if (!hmac(fake.key, Buffer.from('login'), this.ns, nc).equals(payload.subarray(16))) {
                return this.close(4002);
            }
            const proof = hmac(fake.key, Buffer.from('airfrog'), this.ns, nc);
            // With fake.config.badProof, a proof the client fails
            if (fake.config.badProof) proof[0] ^= 1;
            this.respond(LOGIN, proof);
            this.key = hmac(fake.key, Buffer.from('session'), this.ns, nc);
            this.loggedIn = true;
            this.send(TARGET, targetPayload(fake.target));
            return;
        }
        if (fake.dropNext) {
            fake.dropNext = false;
            return;
        }
        switch (type) {
            case TARGET: return this.respond(TARGET, targetPayload(fake.target));
            case CLAIM:
                if (fake.busyClaims > 0) {
                    fake.busyClaims -= 1;
                    const extension = Buffer.from(fake.config.busyHolder);
                    return this.error(1, Buffer.concat([u16(extension.length), extension]));
                }
                if (fake.claimHolder && fake.claimHolder !== this) return this.error(1, u16(0));
                fake.claimHolder = this;
                return this.respond(CLAIM, Buffer.alloc(0));
            case RELEASE:
                if (fake.claimHolder === this) fake.claimHolder = null;
                return this.respond(RELEASE, Buffer.alloc(0));
            case AIRFROG_CMD:
                if (fake.cmdErrors[payload.readUInt16LE(0)]) {
                    const code = fake.cmdErrors[payload.readUInt16LE(0)];
                    delete fake.cmdErrors[payload.readUInt16LE(0)];
                    return this.error(code);
                }
                if (payload.readUInt16LE(0) >= 0x1E && payload.readUInt16LE(0) <= 0x21) {
                    return this.websitesCmd(payload.readUInt16LE(0), payload.subarray(2));
                }
                if (fake.config.airfrogCmdError) return this.error(fake.config.airfrogCmdError);
                if (payload.readUInt16LE(0) === 0x06) return this.setPassword(payload.subarray(2));
                // GET_EXTENSIONS, with fake.config.extensions its response
                if (payload.readUInt16LE(0) === 0x17 && fake.config.extensions) {
                    return this.respond(AIRFROG_CMD, fake.config.extensions);
                }
                // GET_EXTENSION_METADATA, with fake.config.metadata its response
                if (payload.readUInt16LE(0) === 0x1D && fake.config.metadata) {
                    return this.respond(AIRFROG_CMD, fake.config.metadata);
                }
                return this.respond(AIRFROG_CMD, Buffer.concat([Buffer.from('cmd'), payload]));
            case IDENTIFY: {
                if (fake.claimHolder !== this) return this.error(2);
                const count = payload.readUInt16LE(2);
                this.send(TARGET, targetPayload(fake.target));
                return this.respond(IDENTIFY, Buffer.concat([u16(count), ...Array.from({ length: count }, (_, i) => u16(i === 0 ? 1 : 0))]));
            }
            case TARGET_CMD: return this.targetCmd(payload);
            case EXT_CMD: {
                // The reply is the extension name, then the data.
                const name = payload.subarray(2, 2 + payload.readUInt16LE(0));
                if (payload.length - 2 - name.length > 4096) return this.close(4000);
                const code = fake.extErrors[name.toString()];
                if (code) return this.error(code);
                return this.respond(EXT_CMD, payload.subarray(2));
            }
            default: return this.close(4000);
        }
    }

    /** GET, SET, ADD and REMOVE of the authorised websites. */
    websitesCmd(cmd, f) {
        const fake = this.fake;
        const list = () => Buffer.concat([u16(fake.websites.length),
            ...fake.websites.map(w => Buffer.concat([u16(Buffer.byteLength(w)), Buffer.from(w)]))]);
        if (cmd === 0x1E) return f.length ? this.close(4000) : this.respond(AIRFROG_CMD, list());
        if (cmd === 0x1F) return this.close(4000);
        if (f.length < 2 || f.readUInt16LE(0) !== f.length - 2) return this.close(4000);
        const website = f.subarray(2).toString().toLowerCase();
        const listed = fake.websites.includes(website);
        if (cmd === 0x20) {
            if (listed) return this.error(18);
            if (fake.websites.length >= 8) return this.error(13);
            fake.websites.push(website);
        } else {
            if (!listed) return this.error(19);
            fake.websites = fake.websites.filter(w => w !== website);
        }
        return this.respond(AIRFROG_CMD, Buffer.alloc(0));
    }

    /** SET_PASSWORD: K and its salt, or zeros to remove the password. */
    setPassword(fields) {
        const fake = this.fake;
        if (fields.length !== 48) return this.close(4000);
        const removed = fields.every(b => b === 0);
        fake.config.password = removed ? null : 'set';
        fake.key = removed ? null : Buffer.from(fields.subarray(0, 32));
        fake.salt = removed ? crypto.randomBytes(16) : Buffer.from(fields.subarray(32));
        this.respond(AIRFROG_CMD, Buffer.alloc(0));
        for (const s of [...fake.sessions]) s.close(4003);
    }

    /** SWD_MEMORY's READ (1) and WRITE (2). Memory that isn't written reads as the low byte of its address. */
    swdMemory(op, fields) {
        const fake = this.fake;
        const address = fields.readUInt32LE(0);
        const write = op === 2;
        const width = write ? fields.readUInt16LE(4) : fields.readUInt16LE(8);
        const data = write ? fields.subarray(8) : null;
        const length = write ? data.length : fields.readUInt32LE(4);
        if (![1, 2, 4].includes(width) || address % width || length % width || !length ||
            length > fake.config.maxTransfer) return this.error(7);
        const out = [];
        for (let i = 0; i < length; i++) {
            if (fake.memoryFaultFrom !== undefined && address + i >= fake.memoryFaultFrom) return this.error(6);
            if (write) fake.memory.set(address + i, data[i]);
            else out.push(fake.memory.get(address + i) ?? ((address + i) & 0xff));
        }
        this.respond(TARGET_CMD, Buffer.from(out));
    }

    targetCmd(p) {
        const fake = this.fake;
        const service = p.readUInt16LE(0), op = p.readUInt16LE(2), fields = p.subarray(4);
        const listed = fake.target.services.some(([s, o]) => s === service && (o === 0 || o === op));
        if (!listed) return this.error(3);
        if (fake.endClaimBeforeNext) {
            fake.endClaimBeforeNext = false;
            fake.claimHolder = null;
        }
        if (fake.claimHolder !== this && !(service === SWD_MEMORY && op === 1)) return this.error(2);
        if (service === SWD_MEMORY) return this.swdMemory(op, fields);
        if (service === RESET) {
            this.fake.setTarget(TARGETS.identifying);
            this.respond(TARGET_CMD, Buffer.alloc(0));
            setTimeout(() => fake.setTarget(op === 2 ? TARGETS.bootRom : TARGETS.running), 20);
            return;
        }
        if (op === 2) return this.respond(TARGET_CMD, Buffer.alloc(0));  // INTERFACE_RESET
        // COMMAND
        const packet = fields.subarray(4, 36), out = fields.subarray(36);
        const token = packet.readUInt32LE(4), id = packet.readUInt8(8), len = packet.readUInt32LE(12);
        const addr = packet.readUInt32LE(16), size = packet.readUInt32LE(20);
        if (len > fake.config.maxTransfer) return this.close(4000);
        const status = (code) => Buffer.concat([u32(token), u32(code), Buffer.from([id, 0]), Buffer.alloc(6)]);
        const fault = fake.faults.shift();
        if (fault !== undefined) return this.respond(TARGET_CMD, status(fault));
        let data = Buffer.alloc(0);
        if (id === 0x84) {
            data = fake.flashAt(addr, len);
        } else if (id === 0x05) {
            out.forEach((b, i) => fake.flash.set(addr + i, b));
        } else if (id === 0x03) {
            for (let i = 0; i < size; i++) fake.flash.set(addr + i, 0xff);
        } else if (id === 0x8B) {
            data = Buffer.concat([u32(3), u32(0), u32(0x12345678), u32(0x9abcdef0), Buffer.alloc(len - 16)]);
        } else if (id === 0x0A) {
            this.respond(TARGET_CMD, status(0));
            fake.setTarget(TARGETS.identifying);
            const flags = packet.readUInt32LE(16);
            setTimeout(() => fake.setTarget(flags & 2 ? TARGETS.bootRom : TARGETS.running), 20);
            return;
        } else if (id & 0x80) {
            data = Buffer.alloc(len);
        }
        this.respond(TARGET_CMD, Buffer.concat([status(0), data]));
    }
}

/**
 * A browser WebSocket connected to fakes by host. Install it as
 * globalThis.WebSocket.
 */
export class FakeWebSocket {
    static hosts = new Map();
    static opened = [];

    constructor(url, protocol) {
        this.url = url;
        this.protocol = '';
        this.readyState = 0;
        this.binaryType = 'blob';
        this.onopen = this.onmessage = this.onclose = this.onerror = null;
        FakeWebSocket.opened.push(this);
        const host = new URL(url).host;
        const fake = FakeWebSocket.hosts.get(host);
        setTimeout(() => {
            if (!fake) {
                this.readyState = 3;
                this.onerror?.({});
                this.onclose?.({ code: 1006, reason: '' });
                return;
            }
            this.readyState = 1;
            this.protocol = protocol === 'airfrog-v1' ? protocol : '';
            this.onopen?.({});
            // With fake.config.burst, messages sent together arrive in one
            // task, as a browser can deliver them.
            const burst = [];
            const deliver = (bytes) => this.readyState === 1 && this.onmessage?.({
                data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
            });
            this.session = fake.connect(true,
                (bytes) => {
                    if (!fake.config.burst) {
                        setTimeout(() => deliver(bytes), 0);
                        return;
                    }
                    if (burst.push(bytes) === 1) {
                        setTimeout(() => burst.splice(0).forEach(deliver), 0);
                    }
                },
                (code, reason) => setTimeout(() => this.closed(code, reason), 0));
        }, 0);
    }

    send(data) {
        if (this.readyState !== 1) throw new Error('not open');
        const copy = Buffer.from(data);
        setTimeout(() => this.session.receive(copy), 0);
    }

    close(code) {
        if (this.readyState > 1) return;
        this.readyState = 2;
        this.closeCode = code;
        this.session?.ended();
        setTimeout(() => this.closed(code ?? 1005, ''), 0);
    }

    closed(code, reason) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.onclose?.({ code, reason });
    }
}
