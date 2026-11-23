// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Tests airfrog.js against a fake Airfrog, directly and through a fake bridge
// window.
//
// Usage: node tests/js/airfrog.test.mjs

import {
    FakeAirfrog, FakeWebSocket, TARGETS, AIRFROG_CMD, CLAIM, RELEASE, TARGET_CMD, IDENTIFY, EXT_CMD, EXT_NOTIFY,
    RESPONSE, PICOBOOT_RP2350_SWD,
} from './fake-airfrog.mjs';

import crypto from 'node:crypto';

globalThis.WebSocket = FakeWebSocket;

const { Airfrog, AirfrogError, Service, Operation, Firmware, IdentifyFlag, IdentifyResult, PinLevel, ExtensionFlag } =
    await import('../../js/airfrog.js');
const schema = await import('../../js/schema.js');

console.log = () => {};
console.debug = () => {};
console.warn = () => {};

let failures = 0;
const check = (ok, what) => {
    if (!ok) failures++;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${what}\n`);
};
const rejects = async (promise) => {
    try { await promise; } catch (e) { return e; }
    return null;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const throwsType = (fn) => {
    try { fn(); } catch (e) { return e instanceof TypeError; }
    return false;
};

let hosts = 0;
function serve(config) {
    const fake = new FakeAirfrog(config);
    const host = `airfrog${++hosts}.test`;
    FakeWebSocket.hosts.set(host, fake);
    return { fake, host };
}

// Connect and HELLO
{
    const { fake, host } = serve();
    const airfrog = await Airfrog.connect(host);
    check(airfrog.getRevision() === 1 && airfrog.getMaxTransfer() === 4096, 'connect reads HELLO');
    check(airfrog.getHost() === host, 'getHost()');
    const t = airfrog.getTarget();
    check(t.identified() && !t.running() && t.offers(Service.PICOBOOT_RP2350_SWD)
        && t.supports(Service.RESET, Operation.RESET_RESET_BOOT) && t.firmware === Firmware.ONE_ROM
        && t.targetid === 0x00040927, 'connect reads the first TARGET');
    check(FakeWebSocket.opened.at(-1).url === `ws://${host}/api/ws`, 'endpoint is ws://HOST/api/ws');
    airfrog.close();
    check(airfrog.isClosed(), 'close() closes');
    check(fake.closes.length === 0, 'fake saw no protocol errors');
}

// An unknown message type before the LOGIN response
{
    const { fake, host } = serve({ password: 'frog', iterations: 1000 });
    fake.beforeNext = { type: 0x0042, payload: Buffer.alloc(3) };
    const airfrog = await Airfrog.connect(host, 'frog').catch(e => e);
    check(airfrog instanceof Airfrog && fake.closes.length === 0, 'an unknown type during login is ignored');
    airfrog.close?.();
}

// HELLO and TARGET in one task
{
    const { host } = serve({ burst: true });
    const airfrog = await Airfrog.connect(host);
    check(airfrog.getTarget().identified(), 'a TARGET that arrives with HELLO is the first TARGET');
    airfrog.close();
}

// Login
{
    const { fake, host } = serve({ password: 'frog', iterations: 2000 });
    const airfrog = await Airfrog.connect(host, 'frog');
    await airfrog.claim(1000);
    const r = await airfrog.targetCmd(Service.PICOBOOT_RP2350_SWD, Operation.PICOBOOT_RP2350_SWD_INTERFACE_RESET,
        new Uint8Array(0), 1000);
    airfrog.release();
    await sleep(20);
    check(r.length === 0 && fake.closes.length === 0, 'login signs every message and checks Airfrog\'s');
    check(fake.received.map(m => m.type).join() === [2, CLAIM, TARGET_CMD, RELEASE].join(), 'LOGIN, CLAIM, TARGET_CMD, RELEASE');
    airfrog.close();

    let e = await rejects(Airfrog.connect(host));
    check(e instanceof AirfrogError && e.code === 'PASSWORD_REQUIRED', `no password: PASSWORD_REQUIRED (${e?.code})`);
    e = await rejects(Airfrog.connect(host, 'toad'));
    check(e?.code === 'LOGIN_FAILED' && e.message === 'Incorrect password.', `wrong password: LOGIN_FAILED (${e?.code})`);
}
{
    const { host } = serve({ password: 'frog', blockSeconds: 30 });
    const e = await rejects(Airfrog.connect(host, 'frog'));
    check(e?.code === 'LOGIN_BLOCKED' && e.detail === 30
        && e.message === 'Too many failed login attempts. Retry in 30 seconds.', `4007: ${e?.message}`);
}
{
    const e = await rejects(Airfrog.connect('nowhere.test'));
    check(e?.code === 'CONNECT', `unreachable host: CONNECT (${e?.code})`);
}

// BUSY while an extension holds the claim
{
    const { host } = serve({ busyClaims: 1, busyHolder: 'watchdog' });
    const airfrog = await Airfrog.connect(host);
    const e = await rejects(airfrog.claim(1000));
    check(e?.code === 'BUSY' && e.detail === 'watchdog' &&
        e.message === 'Target in use by extension "watchdog". Try again later.', `BUSY for an extension (${e?.message})`);
    airfrog.close();
}

// SWD_MEMORY
{
    const { fake, host } = serve({ target: TARGETS.running });
    const airfrog = await Airfrog.connect(host);
    const write = (address, width, data, flags = 0) =>
        airfrog.targetCmd(Service.SWD_MEMORY, Operation.SWD_MEMORY_WRITE,
            schema.encodeSwdWrite({ address, width, flags, data: Uint8Array.from(data) }), 1000);
    const read = (address, length, width) =>
        airfrog.targetCmd(Service.SWD_MEMORY, Operation.SWD_MEMORY_READ,
            schema.encodeSwdRead({ address, length, width, flags: 0 }), 1000);
    check(schema.SWD_WRITE_HEAD === 8 && schema.encodeSwdWrite({ address: 0x20000000, width: 4, flags: 1,
        data: Uint8Array.of(1, 2, 3, 4) }).join() === [0, 0, 0, 0x20, 4, 0, 1, 0, 1, 2, 3, 4].join(),
        'SWD_MEMORY WRITE\'s fields');
    check(schema.decodeSwdWrite(schema.encodeSwdWrite({ address: 8, width: 2, flags: 0,
        data: Uint8Array.of(9, 9) })).data.join() === '9,9', 'WRITE decodes');

    check((await read(0x20000000, 4, 4)).join() === '0,1,2,3', 'READ needs no claim');
    let e = await rejects(write(0x20000000, 4, [1, 2, 3, 4]));
    check(e?.code === 'NOT_CLAIMED', 'WRITE needs the claim');

    await airfrog.claim(1000);
    const r = await write(0x20000000, 4, [0xde, 0xad, 0xbe, 0xef]);
    check(r.length === 0 && (await read(0x20000000, 4, 1)).join() === '222,173,190,239', 'WRITE writes');
    e = await rejects(write(0x20000001, 4, [1, 2, 3, 4]));
    check(e?.code === 'OUT_OF_RANGE', 'a misaligned WRITE is OUT_OF_RANGE');
    e = await rejects(write(0x20000000, 2, [1]));
    check(e?.code === 'OUT_OF_RANGE', 'a WRITE of a partial width is OUT_OF_RANGE');
    fake.memoryFaultFrom = 0x20000004;
    e = await rejects(write(0x20000000, 1, [1, 2, 3, 4, 5, 6]));
    check(e?.code === 'MEMORY_FAULT' && fake.memory.get(0x20000003) === 4 && !fake.memory.has(0x20000004),
        'a faulting WRITE is MEMORY_FAULT, with the bytes before it written');
    airfrog.release();
    airfrog.close();
}

// Requests and errors
{
    const { fake, host } = serve({ busyClaims: 1 });
    const airfrog = await Airfrog.connect(host);
    let e = await rejects(airfrog.claim(1000));
    check(e?.code === 'BUSY' && e.detail === '' && e.message === 'Target in use. Try again later.',
        `BUSY for a client (${e?.message})`);
    e = await rejects(airfrog.targetCmd(Service.PICOBOOT_ORICP, Operation.PICOBOOT_ORICP_COMMAND,
        new Uint8Array(0), 1000));
    check(e?.code === 'NOT_OFFERED', 'NOT_OFFERED');
    e = await rejects(airfrog.targetCmd(Service.PICOBOOT_RP2350_SWD, Operation.PICOBOOT_RP2350_SWD_INTERFACE_RESET,
        new Uint8Array(0), 1000));
    check(e?.code === 'NOT_CLAIMED', 'NOT_CLAIMED without a claim');

    await airfrog.claim(1000);
    fake.endClaimBeforeNext = true;
    fake.received = [];
    await airfrog.targetCmd(Service.PICOBOOT_RP2350_SWD, Operation.PICOBOOT_RP2350_SWD_INTERFACE_RESET,
        new Uint8Array(0), 1000);
    check(fake.received.map(m => m.type).join() === [TARGET_CMD, CLAIM, TARGET_CMD].join(),
        'a claim Airfrog ended is claimed again and the command sent again');

    fake.received = [];
    const both = await Promise.all([
        airfrog.targetCmd(Service.PICOBOOT_RP2350_SWD, Operation.PICOBOOT_RP2350_SWD_INTERFACE_RESET,
            new Uint8Array(0), 1000),
        airfrog.airfrogCmd(7, new Uint8Array([1, 2]), 1000),
    ]);
    check(new TextDecoder().decode(both[1].subarray(0, 3)) === 'cmd' && both[1][3] === 7 && both[1][5] === 1,
        'airfrogCmd() returns the response fields');
    check(fake.received.length === 2, 'requests made together are sent one at a time');
    airfrog.release();

    const targets = [];
    airfrog.addEventListener('target', ev => targets.push(ev.detail));
    await airfrog.resetBoot();
    check(!airfrog.getTarget().identified(), 'resetBoot(): TARGET IDENTIFYING before the response');
    const found = await airfrog.waitForTarget(2000, t => t.identified());
    check(found?.offers(Service.PICOBOOT_RP2350_SWD) && targets.length === 2, 'waitForTarget() and the target event');
    check(await airfrog.waitForTarget(50, t => t.offers(Service.PICOBOOT_ORICP)) === null, 'waitForTarget() times out with null');

    const results = await airfrog.identify(IdentifyFlag.NO_SWD, [Firmware.ONE_ROM, Firmware.ONE_ROM_LAB]);
    check(results.join() === [IdentifyResult.MATCHED, IdentifyResult.NOT_CHECKED].join(), 'identify() results');
    const id = fake.received.find(m => m.type === IDENTIFY).payload;
    check(id.length === 12 && id.readUInt16LE(0) === 1 && id.readUInt32LE(8) === 2, 'IDENTIFY request fields');

    fake.received = [];
    e = await rejects(airfrog.resetPins({
        resetPin: 'J1-4-TOOLONG', resetLevel: PinLevel.LOW, resetMs: 20, bootPin: null,
    }));
    check(e?.code === 'PIN_NAME' && fake.received.length === 0, 'a long pin name fails without sending');
    await airfrog.resetPins({ resetPin: 'J1-4', resetLevel: PinLevel.LOW, resetMs: 20, bootPin: 'J1-6',
        bootLevel: PinLevel.LOW, bootDelayMs: 10, bootHoldMs: 100 });
    const pins = fake.received.find(m => m.type === TARGET_CMD).payload.subarray(4);
    check(pins.length === 28 && pins.subarray(0, 4).toString() === 'J1-4' && pins.readUInt16LE(10) === 20
        && pins.subarray(12, 16).toString() === 'J1-6' && pins.readUInt16LE(24) === 100, 'RESET_PINS fields');

    let closed = null;
    airfrog.addEventListener('close', ev => { closed = ev.detail; });
    fake.dropNext = true;
    e = await rejects(airfrog.airfrogCmd(1, new Uint8Array(0), 100));
    check(e?.code === 'TIMEOUT' && airfrog.isClosed() && closed === e, 'a timeout closes the connection');
    e = await rejects(airfrog.airfrogCmd(1, new Uint8Array(0), 100));
    check(e === closed, 'a request after close fails with the reason');
}
{
    const { fake, host } = serve({ password: 'frog' });
    const airfrog = await Airfrog.connect(host, 'frog');
    fake.corruptNext = true;
    const e = await rejects(airfrog.airfrogCmd(1, new Uint8Array(0), 1000));
    await sleep(10);
    check(e?.code === 'INVALID_MESSAGE' && FakeWebSocket.opened.at(-1).closeCode === 4001,
        `a bad hmac closes with 4001 (${e?.message})`);
}
{
    const { fake, host } = serve();
    const airfrog = await Airfrog.connect(host);
    let closed = null;
    airfrog.addEventListener('close', ev => { closed = ev.detail; });
    fake.sessions.values().next().value.close(4003);
    await sleep(10);
    check(closed?.code === 'PASSWORD_CHANGED', 'Airfrog\'s close code reaches the close event');
}

// setPassword()
{
    const { fake, host } = serve({ iterations: 1500 });
    let airfrog = await Airfrog.connect(host);
    let closed = null;
    airfrog.addEventListener('close', ev => { closed = ev.detail; });
    await airfrog.setPassword('newfrog');
    await sleep(10);
    const fields = fake.received.at(-1).payload.subarray(2);
    const salt = fields.subarray(32);
    check(fields.length === 48 && salt.some(b => b !== 0)
        && fields.subarray(0, 32).equals(crypto.pbkdf2Sync('newfrog', salt, 1500, 32, 'sha256')),
        'setPassword() sends K from a random salt and HELLO\'s iterations');
    check(closed?.code === 'PASSWORD_CHANGED' && airfrog.isClosed(), 'the close event reports PASSWORD_CHANGED');
    let e = await rejects(Airfrog.connect(host));
    check(e?.code === 'PASSWORD_REQUIRED', 'the new password is required');
    airfrog = await Airfrog.connect(host, 'newfrog');
    await airfrog.setPassword('');
    await sleep(10);
    check(fake.received.at(-1).payload.subarray(2).every(b => b === 0), 'an empty password sends zeros');
    airfrog = await Airfrog.connect(host);
    check(!airfrog.isClosed(), 'an empty password removes it');
    airfrog.close();
}

// ERROR codes this client names, and one it doesn't
for (const [code, name, message] of [
    [16, 'IMAGE_INVALID', 'Invalid firmware file.'],
    [17, 'RESTARTING', 'Airfrog restarting.'],
    [8, 'CODE', 'Internal error.'],
]) {
    const { host } = serve({ airfrogCmdError: code });
    const airfrog = await Airfrog.connect(host);
    const e = await rejects(airfrog.airfrogCmd(0x10, new Uint8Array(0), 1000));
    check(e?.code === name && e.message === message && !airfrog.isClosed(), `ERROR ${code} is ${name} (${e?.message})`);
    airfrog.close();
}

// Extension errors and their texts
for (const [code, name, message] of [
    [10, 'INSTALL_IN_PROGRESS', 'Extension install already in progress.'],
    [11, 'EXTENSION_INVALID', 'Invalid extension.'],
    [12, 'EXTENSION_UNSUPPORTED', 'Extension not supported by this Airfrog.'],
    [13, 'NO_SPACE', 'No room for the extension. Remove an extension, then try again.'],
]) {
    const { host } = serve({ airfrogCmdError: code });
    const airfrog = await Airfrog.connect(host);
    const e = await rejects(airfrog.installExtension(new Uint8Array(8), 0));
    check(e?.code === name && e.message === message && !airfrog.isClosed(), `ERROR ${code} is ${name} (${e?.message})`);
    airfrog.close();
}
check(new AirfrogError('NOT_OFFERED').message === 'Target state changed. Try again.'
    && new AirfrogError('NOT_RUNNING').message === 'Extension not running.', 'NOT_OFFERED and NOT_RUNNING without a name');

// Responses are matched by RESPONSE
{
    const { fake, host } = serve();
    const airfrog = await Airfrog.connect(host);
    fake.beforeNext = { type: EXT_NOTIFY, payload: Buffer.from([3, 0, 0x61, 0x62, 0x63, 9]) };
    const r = await airfrog.airfrogCmd(7, new Uint8Array(0), 1000);
    check(r.length === 5 && !airfrog.isClosed(), 'EXT_NOTIFY before a response doesn\'t close the connection');

    await airfrog.claim(1000);
    fake.beforeNext = { type: TARGET_CMD, payload: Buffer.alloc(0) };
    const e = await rejects(airfrog.targetCmd(Service.PICOBOOT_RP2350_SWD, Operation.PICOBOOT_RP2350_SWD_INTERFACE_RESET,
        new Uint8Array(0), 1000));
    await sleep(10);
    check(e?.code === 'INVALID_MESSAGE' && FakeWebSocket.opened.at(-1).closeCode === 4000,
        `a message of the request's type without RESPONSE closes with 4000 (${e?.detail})`);
}
{
    const { fake, host } = serve();
    const airfrog = await Airfrog.connect(host);
    fake.beforeNext = { type: 0x0042, payload: Buffer.alloc(2) };
    await airfrog.claim(1000);
    airfrog.release();
    await sleep(10);
    check(!airfrog.isClosed(), 'an unknown type is ignored');
    airfrog.close();
}

// Extension commands
{
    // GET_EXTENSIONS's response as websocket-protocol.md lays it out: one
    // entry with TAB, state stopped, reason crashed, and its image header.
    const header = Buffer.concat([Buffer.from('AFXI'), Buffer.from([1, 0, 0, 0, 2, 4, 5, 0]),
        Buffer.from([40, 0, 0, 0, 10, 0, 0, 0, 50, 0, 0, 0, 0, 1, 0, 0]), Buffer.from([8, 0]), Buffer.from('watchdog')]);
    const extensions = Buffer.concat([Buffer.from([1, 0, 1, 0, 2, 0, 2, 0]), header]);
    const { fake, host } = serve({ extensions, metadata: Buffer.from('{"name":"watchdog"}') });
    const live = await Airfrog.connect(host);
    const fields = () => new Uint8Array(fake.received.at(-1).payload.subarray(2));
    const command = () => fake.received.at(-1).payload.readUInt16LE(0);

    const list = await live.getExtensions();
    check(command() === schema.Command.GET_EXTENSIONS && JSON.stringify(list) === JSON.stringify([{ name: 'watchdog',
        flags: ExtensionFlag.TAB, wasmState: 2, wasmReason: 2, model: 1, wamr: '2.4.5' }]),
    'getExtensions() decodes the entries');

    fake.received = [];
    const image = Uint8Array.from({ length: 9000 }, (_, i) => i & 0xff);
    await live.installExtension(image, ExtensionFlag.TAB | ExtensionFlag.SIDE_LOADED);
    const install = fake.received.map(m => m.payload.readUInt16LE(0));
    check(install.join() === [schema.Command.EXT_BEGIN, schema.Command.EXT_WRITE, schema.Command.EXT_WRITE, schema.Command.EXT_WRITE,
        schema.Command.EXT_FINISH].join(), 'install: EXT_BEGIN, EXT_WRITE per max_transfer, EXT_FINISH');
    const begin = fake.received[0].payload.subarray(2);
    check(begin.length === schema.EXT_BEGIN_LEN && begin.readUInt32LE(schema.EXT_BEGIN_SIZE_OFFSET) === 9000
        && begin.subarray(schema.EXT_BEGIN_SHA256_OFFSET, schema.EXT_BEGIN_SHA256_OFFSET + 32)
            .equals(crypto.createHash('sha256').update(image).digest())
        && begin.readUInt16LE(schema.EXT_BEGIN_FLAGS_OFFSET) === 3 && begin.readUInt16LE(38) === 0,
        'EXT_BEGIN: size, SHA-256, flags');
    const writes = fake.received.slice(1, 4).map(m => m.payload.subarray(2));
    check(writes.map(w => w.readUInt32LE(schema.OTA_WRITE_OFFSET_OFFSET)).join() === '0,4096,8192'
        && Buffer.concat(writes.map(w => w.subarray(schema.OTA_WRITE_HEAD))).equals(Buffer.from(image)),
        'EXT_WRITE: offset and data');
    check(fake.received[4].payload.length === 2, 'EXT_FINISH has no fields');
    fake.received = [];
    const installing = live.installExtension(image, 0);
    const other = live.airfrogCmd(schema.Command.GET_HW_INFO, new Uint8Array(0), 1000);
    await Promise.all([installing, other]);
    check(fake.received.map(m => m.payload.readUInt16LE(0)).join() === [schema.Command.EXT_BEGIN, schema.Command.EXT_WRITE,
        schema.Command.EXT_WRITE, schema.Command.EXT_WRITE, schema.Command.EXT_FINISH, schema.Command.GET_HW_INFO].join(),
    'a request made during an install is sent after EXT_FINISH');

    await live.removeExtension('watchdog');
    check(command() === schema.Command.EXT_REMOVE && Buffer.from(fields()).equals(Buffer.from([8, 0, ...Buffer.from('watchdog')])),
        'EXT_REMOVE: the name');
    const meta = await live.getExtensionMetadata('watchdog');
    check(command() === schema.Command.GET_EXTENSION_METADATA && schema.decodeExtensionName(fields())?.name === 'watchdog'
        && meta.name === 'watchdog', 'GET_EXTENSION_METADATA: the name, and the metadata parsed');
    fake.config.metadata = Buffer.from('{');
    const notJson = await rejects(live.getExtensionMetadata('watchdog'));
    check(notJson.code === 'INVALID_MESSAGE' && !live.isClosed(),
        "metadata that isn't JSON fails with INVALID_MESSAGE and the connection stays open");
    await live.setExtensions([{ name: 'b', flags: ExtensionFlag.TAB }, { name: 'aa', flags: 0 }]);
    check(command() === schema.Command.SET_EXTENSIONS
        && Buffer.from(fields()).equals(Buffer.from([2, 0, 1, 0, 0, 0, 1, 0, 0x62, 0, 0, 0, 0, 2, 0, 0x61, 0x61])),
        'SET_EXTENSIONS: count, then flags, reserved and name per entry');

    // EXT_CMD and EXT_NOTIFY
    const watchdog = live.extension('watchdog');
    check(live.extension('watchdog') === watchdog, 'extension() returns the same Extension for a name');
    const reply = await watchdog.command(new Uint8Array([1, 2, 3]), 1000);
    const sent = fake.received.at(-1);
    check(sent.type === EXT_CMD && sent.payload.equals(Buffer.from([8, 0, ...Buffer.from('watchdog'), 1, 2, 3]))
        && Buffer.from(reply).equals(Buffer.from([...Buffer.from('watchdog'), 1, 2, 3])),
        'command() sends the name and data and returns the reply');
    fake.received = [];
    let e = await rejects(watchdog.command(new Uint8Array(4097), 1000));
    check(e?.code === 'TRANSFER_TOO_LARGE' && fake.received.length === 0 && !live.isClosed(),
        `data over 4,096 bytes isn't sent (${e?.message})`);

    const notes = [], others = [];
    watchdog.addEventListener('notify', ev => notes.push(ev.detail));
    live.extension('other').addEventListener('notify', ev => others.push(ev.detail));
    fake.notify('watchdog', [7, 8]);
    fake.notify('unknown', [1]);
    fake.notify('other', []);
    await sleep(10);
    check(notes.length === 1 && notes[0] instanceof Uint8Array && notes[0].join() === '7,8'
        && others.length === 1 && others[0].length === 0 && !live.isClosed(),
        'EXT_NOTIFY reaches its Extension only, and one for no Extension is dropped');

    fake.extErrors = { watchdog: 5, other: 3, gone: 7 };
    e = await rejects(watchdog.command(new Uint8Array(0), 1000));
    check(e?.code === 'NOT_RUNNING' && e.detail === 'watchdog' && e.message === 'Extension watchdog not running.',
        `NOT_RUNNING (${e?.message})`);
    e = await rejects(live.extension('other').command(new Uint8Array(0), 1000));
    check(e?.code === 'NOT_OFFERED' && e.message === 'Extension other doesn\'t handle commands.',
        `NOT_OFFERED for EXT_CMD (${e?.message})`);
    e = await rejects(live.extension('gone').command(new Uint8Array(0), 1000));
    check(e?.code === 'OUT_OF_RANGE' && e.detail === 'gone' && e.message === 'Extension gone not installed.'
        && !live.isClosed(), `an extension not installed is OUT_OF_RANGE (${e?.message})`);
    check(throwsType(() => live.extension()), 'extension() requires a name outside an extension UI');
    live.close();
}

// The bridge, with a fake bridge window
const AIRFROG_ORIGIN = 'http://airfrog.test';

class FakeWindow {
    constructor(origin) {
        this.origin = origin;
        this.listeners = { message: [], pagehide: [] };
        this.closed = false;
    }
    addEventListener(type, fn) { this.listeners[type].push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = this.listeners[type].filter(f => f !== fn); }
    deliver(data, origin, source) {
        const event = { data: structuredClone(data), origin, source };
        setTimeout(() => this.listeners.message.forEach(fn => fn(event)), 0);
    }
}

/** The bridge window: logs in after loginMs and relays to fake. */
class FakeBridge {
    constructor(site, fake, loginMs = 10) {
        this.site = site;
        this.fake = fake;
        this.posted = [];
        this.closed = false;
        setTimeout(() => {
            if (this.closed) return;
            this.session = fake.connect(false,
                (message) => this.post(message),
                (code) => this.post({ close: { code: 'CLOSED', detail: code, message: `closed ${code}` } }));
            const hello = Buffer.alloc(44);
            hello.writeUInt16LE(1, 0);
            hello.writeUInt32LE(4096, 4);
            this.post({ type: 1, flags: 0, payload: new Uint8Array(hello) });
            this.post({ type: 3, flags: 0,
                payload: new Uint8Array((fake.target === TARGETS.bootRom ? bootRomPayload : null)) });
        }, loginMs);
    }
    post(message, origin = AIRFROG_ORIGIN, source = this) {
        this.site.deliver({ airfrogBridge: message }, origin, source);
    }
    postMessage(data, targetOrigin) {
        if (targetOrigin !== AIRFROG_ORIGIN) return;
        this.posted.push(structuredClone(data.airfrogBridge));
        const m = data.airfrogBridge;
        if (m.close) {
            // Handled later, as a browser delivers it. A bridge window that
            // has posted closes the WebSocket with the page's code, then
            // closes itself. One closed first closes it with its own reason.
            setTimeout(() => {
                if (this.closed) {
                    return;
                }
                this.closeCode = m.close.closeCode;
                this.session?.ended();
                if (this.session) {
                    this.closedItself = true;
                    this.closed = true;
                }
            }, 0);
        } else {
            setTimeout(() => this.session.receive(structuredClone(m)), 0);
        }
    }
    close() {
        if (!this.closed) {
            this.closedByPage = true;
        }
        this.closed = true;
    }
}

const { targetPayload } = await import('./fake-airfrog.mjs');
const bootRomPayload = targetPayload(TARGETS.bootRom);

function bridgeSite(fake, options = {}) {
    const site = new FakeWindow('https://onerom.org');
    site.opens = [];
    site.open = (url, name, features) => {
        site.opens.push({ url, name, features });
        if (options.blocked) return null;
        site.bridge = new FakeBridge(site, fake, options.loginMs);
        return site.bridge;
    };
    globalThis.window = site;
    globalThis.location = { origin: 'https://onerom.org' };
    return site;
}

{
    const fake = new FakeAirfrog();
    const site = bridgeSite(fake);
    const airfrog = await Airfrog.connectBridge('airfrog.test');
    check(site.opens[0].url === 'http://airfrog.test/#bridge=https://onerom.org' && site.opens[0].name === '_blank'
        && /popup/.test(site.opens[0].features), 'connectBridge() opens Airfrog\'s page with #bridge=ORIGIN');
    check(airfrog.getMaxTransfer() === 4096 && airfrog.getTarget().offers(Service.PICOBOOT_RP2350_SWD),
        'HELLO and TARGET through the bridge');

    await airfrog.claim(1000);
    await airfrog.targetCmd(Service.PICOBOOT_RP2350_SWD, Operation.PICOBOOT_RP2350_SWD_INTERFACE_RESET,
        new Uint8Array(0), 1000);
    airfrog.release();
    check(fake.closes.length === 0, 'a target command through the bridge');
    check(site.bridge.posted.every(m => m.close || (Number.isInteger(m.type) && m.payload instanceof Uint8Array)),
        'the page posts types and payloads');

    // Messages from elsewhere are ignored
    site.deliver({ airfrogBridge: { close: { code: 'CLOSED' } } }, 'https://evil.test', site.bridge);
    site.deliver({ airfrogBridge: { close: { code: 'CLOSED' } } }, AIRFROG_ORIGIN, {});
    await sleep(10);
    check(!airfrog.isClosed(), 'messages from another origin or window are ignored');

    let closed = null;
    airfrog.addEventListener('close', ev => { closed = ev.detail; });
    site.bridge.post({ close: { code: 'CLOSED', detail: null, message: 'The airfrog.test window ended the connection.' } });
    await sleep(10);
    check(airfrog.isClosed() && closed?.code === 'CLOSED' && closed.message === 'The airfrog.test window ended the connection.',
        'Disconnect in Airfrog\'s window reaches the close event');
    check(site.listeners.message.length === 0, 'the page stops listening');
}
{
    const fake = new FakeAirfrog();
    const site = bridgeSite(fake);
    const airfrog = await Airfrog.connectBridge('airfrog.test');
    airfrog.close();
    await sleep(10);
    check(site.bridge.closedItself && !site.bridge.closedByPage && site.bridge.posted.at(-1).close && airfrog.isClosed(),
        'close() tells Airfrog\'s window, which closes itself');
}
{
    const site = bridgeSite(new FakeAirfrog(), { loginMs: 100000 });
    const pending = Airfrog.connectBridge('airfrog.test');
    site.listeners.pagehide.forEach(fn => fn());
    const e = await rejects(pending);
    check(e?.code === 'CLOSED' && site.bridge.closedByPage, 'leaving the page before login closes Airfrog\'s window');
}
{
    const site = bridgeSite(new FakeAirfrog());
    const airfrog = await Airfrog.connectBridge('airfrog.test');
    site.bridge.postMessage = () => {};
    site.listeners.pagehide.forEach(fn => fn());
    check(site.bridge.closedByPage && airfrog.isClosed(), 'leaving the page closes Airfrog\'s window');
}
{
    const site = bridgeSite(new FakeAirfrog(), { loginMs: 100000 });
    const pending = Airfrog.connectBridge('airfrog.test');
    site.bridge.closed = true;
    const e = await rejects(pending);
    check(e?.code === 'CLOSED' && e.message === 'The airfrog.test window was closed.',
        'closing Airfrog\'s window before login rejects');
}
{
    bridgeSite(new FakeAirfrog(), { blocked: true });
    const e = await rejects(Airfrog.connectBridge('airfrog.test'));
    check(e?.code === 'CONNECT' && e.message === 'Connecting to airfrog.test opens a pop-up window which the '
        + 'browser blocked. Allow pop-ups for onerom.org, then retry.',
        'a window the browser didn\'t open rejects with CONNECT');
    globalThis.location = { origin: 'http://onerom.org:8000' };
    const plain = await rejects(Airfrog.connectBridge('airfrog.test'));
    check(/Allow pop-ups for http:\/\/onerom.org:8000, then retry/.test(plain?.message),
        'a website not on https by its full address');
}
{
    const fake = new FakeAirfrog();
    const site = bridgeSite(fake);
    const airfrog = await Airfrog.connectBridge('airfrog.test');
    site.bridge.post({ type: 0x0042, flags: 0, payload: new Uint8Array(3) });
    await airfrog.claim(1000);
    airfrog.release();
    site.bridge.post({ type: CLAIM, flags: RESPONSE, payload: new Uint8Array(0) });
    await sleep(10);
    check(airfrog.isClosed() && site.bridge.closeCode === 4000, 'an unrequested response closes with 4000 and an unknown type doesn\'t');
}

process.stdout.write(failures ? `${failures} FAILED\n` : 'all passed\n');
process.exit(failures ? 1 : 0);
