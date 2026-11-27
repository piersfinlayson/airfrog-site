// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Extensions in Airfrog's full user interface: semantic versions, the
// extension list's checks, the choice of extension image, the SHA-256 check,
// extension packages and their zip, the extension UI addresses, the frame
// bridge's forwarding rules and origin check with connectExtension() through
// it, and an extension UI tab's loading, failure and unloading.
//
// fixtures/hello-0.3.0.afx is the test repository's package of hello 0.3.0
// (airfrog-v2/rust/airfrog-ext/test/repository.py), as airfrog-ext writes it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';

import { serve, sleep, until } from './helpers.mjs';
import { EXT_CMD, EXT_NOTIFY, extensionRecord } from './fake-airfrog.mjs';
import { compare, isVersion } from '../../ui/src/extensions/semver.js';
import {
    ExtensionError, checkDownload, checkList, findVersion, isLocal, latest, parseMetadata, pickImage, targetGroup,
    uiAddress,
} from '../../ui/src/extensions/list.js';
import { crc32, readZip, ZipError } from '../../ui/src/extensions/zip.js';
import { readExtensionFile, readPackage } from '../../ui/src/extensions/package.js';
import { signedFile } from './minisign.mjs';
import { FrameLink, isTrusted, route } from '../../ui/src/extensions/bridge.js';
import { AwpSocket, EXTENSION_KEY } from '../../js/awp.js';
import { pbkdf2HmacSha256, sha256 } from '../../js/sha256.js';
import {
    AIRFROG_CMD, CLAIM, Command, ERROR, HELLO, IDENTIFY, RELEASE, TARGET, TARGET_CMD, encodeAirfrogCmd, encodeExtCmd,
    encodeExtImage, encodeHostname, encodeSetExtensions,
} from '../../js/schema.js';

const encoder = new TextEncoder();
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** extension-meta.json for name. */
function meta(name, version = '1.0.0', extra = {}) {
    return { name, display_name: name.toUpperCase(), version, description: `About ${name}`, author: 'Ada',
        contact: 'ada@example.com', source: `https://example.com/${name}`, license: 'MIT', firmware: [],
        ui: `https://example.com/${name}/`, ...extra };
}

/** An extension image of name's metadata, for model and WAMR version, without a module unless moduleLen. */
function image(m, model = 0, wamr = [0, 0, 0], module = new Uint8Array(0)) {
    const metadata = encoder.encode(JSON.stringify(m));
    const head = encodeExtImage({ magic: 'AFXI', model, wamr, metadataOffset: 0, metadataLen: 0, moduleOffset: 0,
        moduleLen: 0, name: m.name }).length;
    const header = encodeExtImage({ magic: 'AFXI', model, wamr, metadataOffset: head, metadataLen: metadata.length,
        moduleOffset: head + metadata.length, moduleLen: module.length, name: m.name });
    const out = new Uint8Array(head + metadata.length + module.length);
    out.set(header);
    out.set(metadata, head);
    out.set(module, head + metadata.length);
    return out;
}

/** A list entry's image for bytes. */
function listImage(bytes, model = 0, wamr = '0.0.0') {
    return { model, wamr, url: 'https://extensions.test/x.bin', size: bytes.length, sha256: hex(sha256(bytes)) };
}

/**
 * A zip of files, each [name, bytes, method], with an optional corruption.
 * share: every central directory entry points at the first file's data.
 */
function zip(files, { badCrc = false, share = false } = {}) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, data, method = 8] of files) {
        const packed = method === 8 ? new Uint8Array(zlib.deflateRawSync(data)) : data;
        const n = encoder.encode(name);
        const crc = (crc32(data) ^ (badCrc ? 1 : 0)) >>> 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(n.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(packed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(n.length, 28);
        central.writeUInt32LE(share ? 0 : offset, 42);
        locals.push(local, n, packed);
        centrals.push(central, n);
        offset += 30 + n.length + packed.length;
    }
    const dir = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(offset, 16);
    return new Uint8Array(Buffer.concat([...locals, dir, end]));
}

test('semantic version precedence', () => {
    const order = ['0.9.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2',
        '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.2.0', '1.10.0', '2.0.0'];
    for (let i = 0; i + 1 < order.length; i++) {
        assert.ok(compare(order[i], order[i + 1]) < 0, `${order[i]} < ${order[i + 1]}`);
        assert.ok(compare(order[i + 1], order[i]) > 0, `${order[i + 1]} > ${order[i]}`);
    }
    assert.equal(compare('1.0.0+build.1', '1.0.0+build.2'), 0);
    assert.equal(compare('1.0.0', '1.0.0'), 0);
    for (const bad of ['1.0', '01.0.0', '1.0.0-', '1.0.0-01', 'v1.0.0', '', null]) {
        assert.equal(isVersion(bad), false, String(bad));
    }
    assert.throws(() => compare('1.0', '1.0.0'), TypeError);
});

test("the extension list's checks", () => {
    const hello1 = image(meta('hello', '0.1.0'));
    const list = checkList({
        type: 'extensions', version: 3, extensions: {
            hello: { depublished: false, versions: [
                { metadata: meta('hello', '0.1.0'), images: [listImage(hello1)] },
                { metadata: meta('hello', '0.10.0'), images: [listImage(hello1)] },
                { metadata: meta('hello', '0.2.0'), images: [listImage(hello1)] },
                { metadata: meta('other', '0.3.0'), images: [listImage(hello1)] },
                { metadata: meta('hello', '0.4.0'), images: [{ ...listImage(hello1), sha256: 'AB' }] },
                { metadata: meta('hello', '0.5.0'), images: [] },
            ] },
            gone: { depublished: true, versions: [{ metadata: meta('gone'), images: [listImage(hello1)] }] },
            'Bad-Name': { depublished: false, versions: [{ metadata: meta('bad'), images: [listImage(hello1)] }] },
            nodep: { versions: [{ metadata: meta('nodep'), images: [listImage(hello1)] }] },
            nover: { depublished: false, versions: [{ metadata: { ...meta('nover'), version: '1' }, images: [listImage(hello1)] }] },
            badurl: { depublished: false, versions: [{ metadata: meta('badurl'), images: [{ ...listImage(hello1), url: 'file:///x' }] }] },
        },
    });
    assert.deepEqual([...list.keys()], ['hello', 'gone']);
    assert.deepEqual(list.get('hello').versions.map(v => v.metadata.version), ['0.10.0', '0.2.0', '0.1.0'],
        'versions highest first by precedence, invalid ones left out');
    assert.equal(list.get('gone').depublished, true);
    assert.equal(checkList({ type: 'extensions', version: 1, extensions: [] }).size, 0);
    assert.equal(checkList(null).size, 0);
});

test('the extension image for this Airfrog', () => {
    const images = [
        { model: 1, wamr: '2.4.5', n: 'mini 2.4.5' }, { model: 1, wamr: '2.4.6', n: 'mini 2.4.6' },
        { model: 2, wamr: '2.4.5', n: 'other model' },
    ];
    assert.equal(pickImage(images, 1, '2.4.6').n, 'mini 2.4.6');
    assert.equal(pickImage(images, 1, '2.4.4'), null, 'no image for another WAMR version');
    assert.equal(pickImage(images, 3, '2.4.5'), null);
    const uiOnly = [{ model: 0, wamr: '0.0.0', n: 'no module' }];
    assert.equal(pickImage(uiOnly, 1, '0.0.0').n, 'no module', 'an extension without a module, on firmware without WAMR');
    assert.equal(pickImage(uiOnly, 1, '2.4.5').n, 'no module', 'and on firmware with WAMR');
    const entry = { versions: [
        { metadata: { version: '2.0.0' }, images: [{ model: 1, wamr: '2.4.6' }] },
        { metadata: { version: '1.0.0' }, images: [{ model: 1, wamr: '2.4.5' }] },
    ] };
    assert.equal(latest(entry, 1, '2.4.5').metadata.version, '1.0.0', 'the latest version with an image for this Airfrog');
    assert.equal(latest(entry, 1, '2.4.6').metadata.version, '2.0.0');
    assert.equal(latest(entry, 2, '2.4.6'), null);
    assert.equal(findVersion(entry, '1.0.0', 1, '2.4.5').image.wamr, '2.4.5');
    assert.equal(findVersion(entry, '1.0.0', 1, '2.4.6'), null);
});

test("a downloaded image's size, SHA-256 and header", () => {
    const plain = image(meta('hello'));
    const signed = signedFile(plain);
    const file = checkDownload(signed, 'hello', listImage(signed));
    assert.deepEqual([file.image, file.signature], [plain, signed.subarray(signed.length - 74)],
        'a signed file: its image and signature');
    const extra = Uint8Array.from([...signed, 0]);
    assert.throws(() => checkDownload(extra, 'hello', listImage(extra)), { message: 'Invalid extension.' },
        'a byte after the signature block');
    const bytes = plain;
    const entry = listImage(bytes);
    assert.equal(checkDownload(bytes, 'hello', entry).signature, null, 'an unsigned image');
    const corrupt = bytes.slice();
    corrupt[corrupt.length - 1] ^= 1;
    assert.throws(() => checkDownload(corrupt, 'hello', entry), { message: 'Download corrupt. Try again.' });
    assert.throws(() => checkDownload(bytes.subarray(1), 'hello', entry), ExtensionError);
    assert.throws(() => checkDownload(bytes, 'other', entry), { message: 'Invalid extension.' },
        'the header names another extension');
    assert.throws(() => checkDownload(bytes, 'hello', { ...entry, model: 1 }), { message: 'Invalid extension.' },
        'the header is for another model than the list says');
    assert.throws(() => checkDownload(bytes, 'hello', { ...entry, wamr: '2.4.5' }), { message: 'Invalid extension.' });
    const notImage = encoder.encode('not an extension image at all, but long enough');
    assert.throws(() => checkDownload(notImage, 'hello', listImage(notImage)), { message: 'Invalid extension.' });
});

test('extension metadata', () => {
    assert.equal(parseMetadata(encoder.encode(JSON.stringify(meta('hello')))).name, 'hello');
    assert.equal(parseMetadata(encoder.encode('{')), null);
    assert.equal(parseMetadata(encoder.encode(JSON.stringify({ ...meta('hello'), display_name: '' }))), null);
    assert.equal(parseMetadata(encoder.encode(JSON.stringify({ ...meta('hello'), firmware: 'ONE_ROM' }))), null);
    assert.equal(parseMetadata(new Uint8Array(2049).fill(0x20)), null, 'over 2,048 bytes');
    assert.equal(targetGroup([], 1), 'any');
    assert.equal(targetGroup(['ONE_ROM_LAB', 'ONE_ROM'], 1), 'this');
    assert.equal(targetGroup(['ONE_ROM_LAB'], 1), 'other');
    assert.equal(targetGroup(['ONE_ROM'], 0), 'other');
    assert.equal(targetGroup(['SOMETHING_NEW'], 1), 'other');
});

test('extension UI addresses (D1a)', () => {
    assert.equal(uiAddress('https://example.com/x/', false), 'https://example.com/x/');
    assert.equal(uiAddress('http://example.com/x/', true), null);
    assert.equal(uiAddress('http://127.0.0.1:8000/x/', false), null, 'local only for an unsigned extension or a local repository');
    assert.equal(uiAddress('http://127.0.0.1:8000/x/', true), 'http://127.0.0.1:8000/x/');
    assert.equal(uiAddress('http://localhost/x/', true), 'http://localhost/x/');
    for (const bad of ['http://127.0.0.2/', 'http://localhost.example.com/', 'http://[::1]/', 'javascript:alert(1)',
        'data:text/html,x', 'not a url', undefined, 7]) {
        assert.equal(uiAddress(bad, true), null, String(bad));
    }
    assert.equal(isLocal('http://127.0.0.1:18093/extensions/manifest.json'), true);
    assert.equal(isLocal('https://extensions.airfrog.org/manifest.json'), false);
    assert.equal(isLocal(null), false);
});

const LIMITS = { maxSize: 1 << 20, maxTotal: 1 << 22 };

test('zip: stored and deflated entries, CRC-32 and damage', async () => {
    const a = encoder.encode('stored entry');
    const b = new Uint8Array(5000).map((_, i) => i % 7);
    const files = await readZip(zip([['a.txt', a, 0], ['dir/b.bin', b, 8], ['dir/', new Uint8Array(0), 0]]), LIMITS);
    assert.deepEqual([...files.keys()], ['a.txt', 'dir/b.bin']);
    assert.deepEqual(files.get('a.txt'), a);
    assert.deepEqual(files.get('dir/b.bin'), b);
    await assert.rejects(readZip(zip([['a.txt', a, 8]], { badCrc: true }), LIMITS), ZipError);
    await assert.rejects(readZip(zip([['b.bin', b, 8]]), { maxSize: 100, maxTotal: 1 << 22 }), /too large/);
    const whole = zip([['b.bin', b, 8]]);
    await assert.rejects(readZip(whole.subarray(0, 40), LIMITS), ZipError, 'truncated');
    await assert.rejects(readZip(encoder.encode('not a zip'), LIMITS), ZipError);
    const bad = whole.slice();
    bad[35] ^= 0xff;
    await assert.rejects(readZip(bad, LIMITS), ZipError, 'damaged deflate data');
});

test('zip: entries sharing data, the total size and the files selected', async () => {
    const zeros = new Uint8Array(100000);
    const shared = zip([['a.bin', zeros, 8], ['b.bin', zeros, 8], ['c.bin', zeros, 8]], { share: true });
    await assert.rejects(readZip(shared, LIMITS), /overlap/, 'entries pointing at one entry\'s data');
    const three = zip([['a.bin', zeros, 8], ['b.bin', zeros, 8], ['c.bin', zeros, 8]]);
    assert.equal((await readZip(three, { maxSize: 100000, maxTotal: 300000 })).size, 3);
    await assert.rejects(readZip(three, { maxSize: 100000, maxTotal: 299999 }), /too large together/,
        'the total of the entries read is limited');
    const some = await readZip(three, { maxSize: 100000, maxTotal: 100000 }, (path) => path === 'b.bin');
    assert.deepEqual([...some.keys()], ['b.bin'], 'only the files selected are read and counted');
});

test('an extension package from airfrog-ext', async () => {
    const pkg = new Uint8Array(fs.readFileSync(new URL('fixtures/hello-0.3.0.afx', import.meta.url)));
    const { metadata, image: img } = await readPackage(pkg, 1, '0.0.0');
    assert.equal(metadata.name, 'hello');
    assert.equal(metadata.version, '0.3.0');
    assert.equal(extensionRecord(img, 0).name, 'hello');
    const again = await readPackage(pkg, 2, '2.4.5');
    assert.deepEqual(again.image, img, 'an image without a module is for every model and WAMR version');
});

test("an extension package's image for this Airfrog", async () => {
    const m = meta('watchdog');
    const mini = image(m, 1, [2, 4, 5], new Uint8Array(100).fill(1));
    const other = image(m, 2, [2, 4, 5], new Uint8Array(100).fill(2));
    const pkg = zip([['extension-meta.json', encoder.encode(JSON.stringify(m))], ['extension.wasm', new Uint8Array(8)],
        ['images/a.bin', other], ['images/b.bin', mini]]);
    assert.deepEqual((await readPackage(pkg, 1, '2.4.5')).image, mini, 'picked by header, not file name');
    assert.deepEqual((await readPackage(pkg, 2, '2.4.5')).image, other);
    await assert.rejects(readPackage(pkg, 1, '2.4.6'), { message: 'Extension not supported by this Airfrog.' });
    await assert.rejects(readPackage(zip([['images/b.bin', mini]]), 1, '2.4.5'), { message: 'Invalid extension file.' },
        'without extension-meta.json');
    await assert.rejects(readPackage(zip([['extension-meta.json', encoder.encode(JSON.stringify(m))]]), 1, '2.4.5'),
        { message: 'Invalid extension file.' }, 'without images');
    const otherName = image(meta('other'), 1, [2, 4, 5]);
    await assert.rejects(readPackage(zip([['extension-meta.json', encoder.encode(JSON.stringify(m))],
        ['images/b.bin', otherName]]), 1, '2.4.5'), { message: 'Invalid extension file.' }, 'an image of another extension');
    await assert.rejects(readPackage(encoder.encode('PK not really'), 1, '2.4.5'), { message: 'Invalid extension file.' });
});

const OWN = 'watchdog';
const cmd = (command, fields = new Uint8Array(0)) => ({ type: AIRFROG_CMD, payload: encodeAirfrogCmd({ command, fields }) });

test('an extension file: a package, a signed image or an unsigned image', async () => {
    const m = meta('hello');
    const plain = image(m);
    const signed = await readExtensionFile(signedFile(plain), 1, '2.4.5');
    assert.deepEqual([signed.metadata, signed.image, signed.signature.length], [m, plain, 74]);
    const unsigned = await readExtensionFile(plain, 1, '2.4.5');
    assert.deepEqual([unsigned.image, unsigned.signature], [plain, null]);
    const pkg = await readExtensionFile(zip([['extension-meta.json', encoder.encode(JSON.stringify(m))],
        ['images/0.bin', plain]]), 1, '2.4.5');
    assert.deepEqual([pkg.metadata, pkg.image, pkg.signature], [m, plain, null], 'a package is unsigned');
    await assert.rejects(readExtensionFile(image(m, 2, [2, 4, 5]), 1, '2.4.5'),
        { message: 'Extension not supported by this Airfrog.' }, "another model's image");
    await assert.rejects(readExtensionFile(Uint8Array.from([...plain, 9]), 1, '2.4.5'),
        { message: 'Invalid extension file.' }, 'a byte after the image');
});

test("the bridge's forwarding rules", () => {
    for (const type of [CLAIM, RELEASE, TARGET_CMD, IDENTIFY]) {
        assert.equal(route({ type, payload: new Uint8Array(4) }, OWN, false), 'forward');
    }
    for (const name of Object.keys(Command)) {
        assert.equal(route(cmd(Command[name]), OWN, false), name.startsWith('GET_') ? 'forward' : 'drop', name);
    }
    assert.equal(route(cmd(Command.SET_EXTENSIONS, encodeSetExtensions({ entries: [] })), OWN, false), 'drop');
    assert.equal(route({ type: EXT_CMD, payload: encodeExtCmd({ name: OWN, data: new Uint8Array([1]) }) }, OWN, false),
        'forward');
    assert.equal(route({ type: EXT_CMD, payload: encodeExtCmd({ name: 'other', data: new Uint8Array(0) }) }, OWN, false),
        'not-installed');
    for (const type of [HELLO, 2, TARGET, ERROR, EXT_NOTIFY, 0x42]) {
        assert.equal(route({ type, payload: new Uint8Array(8) }, OWN, false), 'drop', `type ${type}`);
    }
    assert.equal(route({ type: AIRFROG_CMD, payload: new Uint8Array(1) }, OWN, false), 'drop', 'short AIRFROG_CMD');
    assert.equal(route({ type: CLAIM, payload: [] }, OWN, false), 'drop', 'payload not a Uint8Array');
    assert.equal(route({ type: 1.5, payload: new Uint8Array(0) }, OWN, false), 'drop');
    assert.equal(route(null, OWN, false), 'drop');
    assert.equal(route(cmd(Command.SET_PASSWORD, new Uint8Array(48)), OWN, true), 'forward', 'full access: every request');
    assert.equal(route({ type: EXT_CMD, payload: encodeExtCmd({ name: 'other', data: new Uint8Array(0) }) }, OWN, true),
        'forward');
    const full = ['https://airfrog.org', 'https://tools.example.com:8443', 'not a URL'];
    assert.equal(isTrusted('https://airfrog.org', full), true);
    assert.equal(isTrusted('https://tools.example.com:8443', full), true);
    assert.equal(isTrusted('https://ext.airfrog.org', full), false, 'a subdomain isn\'t included');
    assert.equal(isTrusted('http://airfrog.org', full), false);
    assert.equal(isTrusted('https://airfrog.org.example.com', full), false);
    assert.equal(isTrusted('https://airfrog.org:8443', full), false);
    assert.equal(isTrusted('https://tools.example.com', full), false);
    assert.equal(isTrusted('null', full), false);
    assert.equal(isTrusted('https://airfrog.org', []), false, 'an empty list: none');
});

/**
 * The Airfrog UI's window and an extension UI's frame, which post to each
 * other as a browser does, with event.source and event.origin.
 */
function windows(uiOrigin) {
    const listeners = [];
    const parent = { posted: [] };
    const frame = { posted: [] };
    let link = null;
    const deliver = (target, data, source, origin) => setTimeout(() => {
        if (target === parent) {
            link?.receive({ source, origin, data: structuredClone(data) });
        } else {
            [...listeners].forEach(fn => fn({ source, origin, data: structuredClone(data) }));
        }
    }, 0);
    parent.postMessage = (data, targetOrigin) => {
        parent.posted.push({ data, targetOrigin });
        deliver(parent, data, frame, uiOrigin);
    };
    frame.postMessage = (data, targetOrigin) => {
        frame.posted.push({ data, targetOrigin });
        if (targetOrigin === uiOrigin) {
            deliver(frame, data, parent, 'http://airfrog.test');
        }
    };
    frame.parent = parent;
    frame.addEventListener = (type, fn) => listeners.push(fn);
    frame.removeEventListener = (type, fn) => listeners.splice(listeners.indexOf(fn), 1);
    return { parent, frame, setLink: (l) => { link = l; } };
}

test('connectExtension() through the bridge', async () => {
    const m = meta(OWN);
    const { fake, host } = serve({ password: 'frog', extensions: [{ image: image(m), flags: 1 }, { image: image(meta('other')), flags: 0 }],
        modules: { [OWN]: (data) => [...data].reverse() } });
    const uiOrigin = 'https://example.com';
    const w = windows(uiOrigin);
    let connects = 0;
    const link = new FrameLink({ name: OWN, origin: uiOrigin, target: () => w.frame,
        open: () => AwpSocket.open(host, 'frog'), onConnect: () => { connects++; } });
    w.setLink(link);
    globalThis.window = w.frame;
    const { Airfrog } = await import('../../js/airfrog.js');
    const airfrog = await Airfrog.connectExtension();
    assert.equal(connects, 1);
    assert.equal(w.parent.posted[0].targetOrigin, '*', 'the request is posted before the Airfrog UI is known');
    assert.ok(w.frame.posted.every(p => p.targetOrigin === uiOrigin), 'the Airfrog UI posts only to the frame origin');
    assert.ok(w.parent.posted.slice(1).every(p => p.targetOrigin === 'http://airfrog.test'));
    assert.equal(airfrog.getHost(), null);
    assert.equal(airfrog.getTarget().firmware, 1, 'TARGET reaches the extension UI');
    assert.ok(fake.sessions.size === 1, 'one connection, logged in by the Airfrog UI');

    const hw = await airfrog.airfrogCmd(Command.GET_HW_INFO, new Uint8Array(0), 1000);
    assert.ok(hw.length > 20, 'a get command is forwarded');
    let e = await airfrog.airfrogCmd(Command.SET_HOSTNAME, new Uint8Array(2), 1000).catch(x => x);
    assert.equal(e.code, 'NOT_PERMITTED');
    assert.equal(e.message, 'AIRFROG_CMD SET_HOSTNAME not available to an extension UI.');
    e = await airfrog.setExtensions([]).catch(x => x);
    assert.equal(e.code, 'NOT_PERMITTED');
    assert.ok(!fake.received.some(r => r.type === AIRFROG_CMD && r.payload[0] !== Command.GET_HW_INFO),
        'nothing but the get command reached Airfrog');

    const reply = await airfrog.extension().command(new Uint8Array([1, 2, 3]), 1000);
    assert.deepEqual([...reply], [3, 2, 1], "extension() is the extension UI's own extension");
    e = await airfrog.extension('other').command(new Uint8Array(0), 1000).catch(x => x);
    assert.equal(e.code, 'OUT_OF_RANGE');
    assert.equal(e.message, 'Extension other not installed.');
    assert.ok(!fake.received.some(r => r.type === EXT_CMD && new TextDecoder().decode(r.payload).includes('other')),
        "EXT_CMD to another extension doesn't reach Airfrog");

    const own = [];
    const others = [];
    airfrog.extension().addEventListener('notify', ev => own.push([...ev.detail]));
    airfrog.extension('other').addEventListener('notify', ev => others.push([...ev.detail]));
    fake.notify(OWN, [9]);
    fake.notify('other', [8]);
    await until(() => own.length === 1);
    await sleep(20);
    assert.deepEqual(own, [[9]]);
    assert.deepEqual(others, [], "another extension's EXT_NOTIFY isn't passed on");

    // A message from another window, from the frame's window at another
    // origin, or with another connection's id, is ignored.
    const idOf = (n) => w.parent.posted.filter(p => p.data[EXTENSION_KEY].connect)[n].data[EXTENSION_KEY].id;
    const claim = (id) => ({ [EXTENSION_KEY]: { type: CLAIM, payload: new Uint8Array(0), id } });
    const first = idOf(0);
    let before = fake.received.length;
    link.receive({ source: {}, origin: uiOrigin, data: claim(first) });
    link.receive({ source: w.frame, origin: 'https://evil.example', data: claim(first) });
    link.receive({ source: w.frame, origin: uiOrigin, data: claim('another') });
    link.receive({ source: w.frame, origin: uiOrigin, data: { [EXTENSION_KEY]: { type: CLAIM, payload: new Uint8Array(0) } } });
    link.receive({ source: w.frame, origin: uiOrigin, data: { other: true } });
    await sleep(20);
    assert.equal(fake.received.length, before);

    // A second connectExtension() in the frame replaces the open first one.
    assert.equal(airfrog.isClosed(), false);
    const firstClosed = new Promise(r => airfrog.addEventListener('close', ev => r(ev.detail)));
    const second = await Airfrog.connectExtension();
    assert.equal((await firstClosed).code, 'CLOSED', 'the replaced connection is closed');
    assert.equal(second.isClosed(), false);
    await until(() => fake.sessions.size === 1);
    assert.deepEqual([...await second.extension().command(new Uint8Array([4, 5]), 1000)], [5, 4],
        'the new connection works');
    before = fake.received.length;
    link.receive({ source: w.frame, origin: uiOrigin, data: claim(first) });
    await sleep(20);
    assert.equal(fake.received.length, before, "the replaced connection's messages are ignored");
    assert.equal(second.isClosed(), false);
    link.receive({ source: w.frame, origin: uiOrigin, data: claim(idOf(1)) });
    await until(() => fake.received.length === before + 1);
    assert.equal(fake.received.at(-1).type, CLAIM, "the frame's message, from its origin, with its id, is forwarded");

    // Airfrog closing the connection closes the extension UI's.
    const third = await Airfrog.connectExtension();
    const closed = new Promise(r => third.addEventListener('close', ev => r(ev.detail)));
    fake.closeAll(1001);
    assert.equal((await closed).code, 'CLOSED');

    // Removed by the Airfrog UI: the connection closes.
    const fourth = await Airfrog.connectExtension();
    assert.equal(fake.sessions.size, 1);
    link.close();
    await until(() => fake.sessions.size === 0);
    fourth.close();
    delete globalThis.window;
});

test('an extension UI from a full access website has every request forwarded', async () => {
    const m = meta(OWN);
    const { fake, host } = serve({ extensions: [{ image: image(m), flags: 1 }] });
    const uiOrigin = 'https://tools.example.com';
    let websites = [];
    const w = windows(uiOrigin);
    const link = new FrameLink({ name: OWN, origin: uiOrigin, target: () => w.frame, open: () => AwpSocket.open(host, null),
        fullAccess: () => websites });
    w.setLink(link);
    globalThis.window = w.frame;
    const { Airfrog } = await import('../../js/airfrog.js');
    let airfrog = await Airfrog.connectExtension();
    let e = await airfrog.airfrogCmd(Command.SET_HOSTNAME, encodeHostname({ hostname: 'bench' }), 1000).catch(x => x);
    assert.equal(e.code, 'NOT_PERMITTED', 'not listed: limited');
    airfrog.close();
    websites = [uiOrigin];
    airfrog = await Airfrog.connectExtension();
    await airfrog.airfrogCmd(Command.SET_HOSTNAME, encodeHostname({ hostname: 'bench' }), 1000).catch(x => x);
    assert.equal(fake.hostname, 'bench', 'listed when the connection opens: every request forwarded');
    await until(() => airfrog.isClosed());
    link.close();
    delete globalThis.window;
});

test('a full access extension UI sets a password that logs in, and removes it', async () => {
    const { fake, host } = serve({ password: 'Frog pond 1', extensions: [{ image: image(meta(OWN)), flags: 1 }] });
    const uiOrigin = 'https://tools.example.com';
    let password = 'Frog pond 1';
    const w = windows(uiOrigin);
    const link = new FrameLink({ name: OWN, origin: uiOrigin, target: () => w.frame,
        open: () => AwpSocket.open(host, password), fullAccess: () => [uiOrigin] });
    w.setLink(link);
    globalThis.window = w.frame;
    const { Airfrog } = await import('../../js/airfrog.js');
    let airfrog = await Airfrog.connectExtension();
    await airfrog.setPassword('Newt pond 2');
    await until(() => airfrog.isClosed());
    const sent = fake.sentKey;
    const k = pbkdf2HmacSha256(encoder.encode('Newt pond 2'), fake.salt, fake.config.iterations);
    assert.ok(sent.some((b, i) => b !== k[i]), 'the key reaches Airfrog encrypted');
    const logged = await Airfrog.connect(host, 'Newt pond 2');
    assert.ok(!logged.isClosed(), 'the new password logs in');
    logged.close();
    password = 'Newt pond 2';
    airfrog = await Airfrog.connectExtension();
    await airfrog.setPassword('');
    await until(() => airfrog.isClosed());
    assert.equal(fake.key, null, 'removing it, encrypted too, removes it');
    link.close();
    delete globalThis.window;
});

test("the frame is as high as the extension UI's page", async () => {
    const { host } = serve({ password: 'frog', extensions: [{ image: image(meta(OWN)), flags: 1 }] });
    const uiOrigin = 'https://example.com';
    const w = windows(uiOrigin);
    const heights = [];
    const link = new FrameLink({ name: OWN, origin: uiOrigin, target: () => w.frame,
        open: () => AwpSocket.open(host, 'frog'), onHeight: (height) => heights.push(height) });
    w.setLink(link);
    let pageHeight = 300.4;
    let observer = null;
    globalThis.window = w.frame;
    globalThis.document = { documentElement: { getBoundingClientRect: () => ({ height: pageHeight }) } };
    globalThis.ResizeObserver = class {
        constructor(fn) { this.fn = fn; observer = this; }
        observe() { setTimeout(this.fn, 0); }
        disconnect() { observer = null; }
    };
    try {
        const { Airfrog } = await import('../../js/airfrog.js');
        const airfrog = await Airfrog.connectExtension();
        await until(() => heights.length === 1);
        assert.deepEqual(heights, [301], 'the height, rounded up, once connected');
        pageHeight = 520;
        observer.fn();
        await until(() => heights.length === 2);
        assert.equal(heights[1], 520, 'and again when the page changes');
        const id = w.parent.posted.find(p => p.data[EXTENSION_KEY].connect).data[EXTENSION_KEY].id;
        const height = (h, i = id) => ({ [EXTENSION_KEY]: { height: h, id: i } });
        link.receive({ source: w.frame, origin: 'https://evil.example', data: height(10) });
        link.receive({ source: {}, origin: uiOrigin, data: height(11) });
        link.receive({ source: w.frame, origin: uiOrigin, data: height(12, 'another') });
        link.receive({ source: w.frame, origin: uiOrigin, data: height(-1) });
        link.receive({ source: w.frame, origin: uiOrigin, data: height(1.5) });
        link.receive({ source: w.frame, origin: uiOrigin, data: height('40') });
        assert.equal(heights.length, 2, "another origin, window or connection's height, or an invalid one, is ignored");
        airfrog.close();
        pageHeight = 610;
        observer.fn();
        await until(() => heights.length === 3);
        assert.equal(heights[2], 610, 'and after the connection closes');
    } finally {
        link.close();
        delete globalThis.window;
        delete globalThis.document;
        delete globalThis.ResizeObserver;
    }
});

test('one login at a time for a frame', async () => {
    const { fake, host } = serve({ password: 'frog', extensions: [{ image: image(meta(OWN)), flags: 1 }] });
    const uiOrigin = 'https://example.com';
    const w = windows(uiOrigin);
    let active = 0;
    let peak = 0;
    let opens = 0;
    const link = new FrameLink({ name: OWN, origin: uiOrigin, target: () => w.frame, open: async () => {
        opens++;
        active++;
        peak = Math.max(peak, active);
        try {
            return await AwpSocket.open(host, 'frog');
        } finally {
            active--;
        }
    } });
    w.setLink(link);
    for (let i = 0; i < 50; i++) {
        link.receive({ source: w.frame, origin: uiOrigin, data: { [EXTENSION_KEY]: { connect: true, id: `c${i}` } } });
    }
    await until(() => w.frame.posted.some(p => p.data[EXTENSION_KEY].type === HELLO));
    await sleep(50);
    assert.equal(peak, 1, 'one login in progress at a time');
    assert.ok(opens <= 2, `logins ${opens}`);
    assert.equal(fake.sessions.size, 1, 'one connection');
    const hellos = w.frame.posted.filter(p => p.data[EXTENSION_KEY].type === HELLO).map(p => p.data[EXTENSION_KEY].id);
    assert.deepEqual(hellos, ['c49'], 'the last request gets the connection');
    const closes = w.frame.posted.filter(p => p.data[EXTENSION_KEY].close).map(p => p.data[EXTENSION_KEY].id);
    assert.equal(closes.length, 49, 'every replaced request is posted a close');
    link.close();
    await until(() => fake.sessions.size === 0);
});

test('connectExtension() outside the Airfrog UI', async () => {
    const top = {};
    top.parent = top;
    globalThis.window = top;
    const { Airfrog } = await import('../../js/airfrog.js');
    const e = await Airfrog.connectExtension().catch(x => x);
    assert.equal(e.code, 'CONNECT');
    assert.equal(e.message, 'Not inside the Airfrog UI.');
    delete globalThis.window;
});
