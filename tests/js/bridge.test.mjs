// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Tests bridge.js, the bridge window, against a fake Airfrog and a
// fake page.
//
// Usage: node tests/js/bridge.test.mjs

import {
    FakeAirfrog, FakeWebSocket, TARGETS, TARGET, TARGET_CMD, CLAIM, AIRFROG_CMD, EXT_NOTIFY, RESPONSE,
} from './fake-airfrog.mjs';

globalThis.WebSocket = FakeWebSocket;
console.debug = () => {};
// The window's 10-minute check of the authorised websites runs after checkMs.
const CHECK_MS = 10 * 60 * 1000;
let checkMs = CHECK_MS;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms === CHECK_MS ? checkMs : ms, ...args);
const { startBridge } = await import('../../js/bridge.js');

let failures = 0;
const check = (ok, what) => {
    if (!ok) failures++;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${what}\n`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
/** Waits until condition() is true or timeoutMs has passed. */
const until = async (condition, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline) {
        await sleep(5);
    }
};

class Element {
    constructor(tag) {
        this.tag = tag;
        this.children = [];
        this.listeners = {};
        this.className = '';
        this.id = '';
        this.textContent = '';
        this.hidden = false;
        this.value = '';
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter(f => f !== fn); }
    fire(type) { (this.listeners[type] ?? []).slice().forEach(fn => fn({ preventDefault() {} })); }
    setAttribute(name, value) { this[name] = value; }
    /** The element with this id or class. */
    find(key) {
        if (this.id === key || this.className.split(' ').includes(key)) return this;
        for (const c of this.children) {
            const found = typeof c === 'object' && c?.find ? c.find(key) : null;
            if (found) return found;
        }
        return null;
    }
}
globalThis.document = { createElement: (tag) => new Element(tag), title: '' };

const PAGE = 'https://onerom.org';

class Window {
    constructor() {
        this.listeners = { message: [], pagehide: [], pageshow: [] };
        this.closed = false;
    }
    addEventListener(type, fn) { this.listeners[type].push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = this.listeners[type].filter(f => f !== fn); }
    close() { this.closed = true; }
}

/** The page that opened the bridge window. */
class Page {
    constructor() {
        this.closed = false;
        this.received = [];
    }
    postMessage(data, targetOrigin) {
        this.received.push({ message: structuredClone(data.airfrogBridge), targetOrigin });
    }
    send(message, origin = PAGE, source = this) {
        const event = { data: structuredClone({ airfrogBridge: message }), origin, source };
        win.listeners.message.forEach(fn => fn(event));
    }
}

let win, page, fake, container, replaced;
function setUp(hash, config, opener = true, airfrog = null) {
    fake = new FakeAirfrog(config);
    FakeWebSocket.hosts.set('airfrog.test', airfrog ?? fake);
    FakeWebSocket.opened = [];
    page = new Page();
    win = new Window();
    win.opener = opener ? page : null;
    globalThis.window = win;
    replaced = null;
    globalThis.location = { hash, host: 'airfrog.test', replace: (url) => { replaced = url; } };
    globalThis.history = { length: 1 };
    document.title = '';
    container = new Element('div');
}
/** The window's lines, each "kind: text". */
const lines = () => container.find('bridge-status').children.map(p => `${p.className || 'text'}: ${p.textContent}`);
const button = () => container.find('bridge-button');
const findRow = () => container.children[0].children.at(-1);
const shownButton = () => (findRow().hidden ? null : button().textContent);
const cancelButton = () => container.find('bridge-cancel');
const commands = () => fake.received.filter(r => r.type === AIRFROG_CMD).map(r => r.payload.readUInt16LE(0));
const lastClose = () => page.received.at(-1)?.message.close;

/** Connects, then makes the page send message, and returns the window's lines. */
async function refused(message) {
    setUp('#bridge=https://onerom.org');
    await startBridge(container);
    await sleep(10);
    const forwarded = fake.received.length;
    page.send(message);
    await sleep(10);
    return { lines: lines(), forwarded: fake.received.length - forwarded, close: lastClose() };
}

{
    for (const hash of ['#bridge=', '#bridge=onerom.org', '#bridge=https://onerom.org/web', '#bridge=javascript:x',
        '#bridge=ftp://onerom.org', '#bridge=%E0%A4%A']) {
        setUp(hash);
        await startBridge(container);
        check(replaced === 'http://airfrog.test/' && FakeWebSocket.opened.length === 0 && container.children.length === 0,
            `${hash} without a website's origin loads the home page`);
    }

    setUp('#bridge=https%3A%2F%2Fonerom.org', {}, false);
    await startBridge(container);
    check(lines().join('|') === 'msg bad: Do not open this window directly.|text: Close this window and connect from onerom.org.'
        && shownButton() === 'Close' && FakeWebSocket.opened.length === 0, 'opened directly it doesn\'t connect');
    check(document.title === 'airfrog.test (onerom.org)', 'the title');
    button().fire('click');
    check(win.closed, 'Close closes the window');

    setUp('#bridge=https://onerom.org', {}, false);
    history.length = 2;
    await startBridge(container);
    check(lines().join('|') === 'msg bad: Do not open this window directly.|text: Close this window and connect from onerom.org.'
        && shownButton() === null, 'opened directly in a tab with history: the lines without Close');

    setUp('#bridge=https://onerom.org', {}, false);
    await startBridge(container);
    history.length = 2;
    win.listeners.pageshow.forEach(fn => fn({ persisted: true }));
    check(shownButton() === null, 'restored by Back with more history: Close goes');
}
{
    setUp('#bridge=https://onerom.org');
    await startBridge(container);
    await sleep(10);
    check(lines().join('|') === 'msg ok: onerom.org is connected to airfrog.test.|'
        + 'text: Closing this window disconnects onerom.org from airfrog.test.' && shownButton() === 'Disconnect',
        'connected');
    check(container.children[0].children.length === 3, 'the lines, the login form and the button, and nothing else');
    check(page.received.length === 2 && page.received.every(r => r.targetOrigin === PAGE)
        && page.received[0].message.type === 1 && page.received[1].message.type === TARGET,
        'posts HELLO then TARGET, only to the website');

    page.received = [];
    page.send({ type: CLAIM, payload: new Uint8Array(0) });
    await sleep(10);
    page.send({ type: TARGET_CMD, payload: new Uint8Array([3, 0, 2, 0]) });
    await sleep(10);
    page.send({ type: AIRFROG_CMD, payload: new Uint8Array([0x01, 0]) });
    await sleep(10);
    check(page.received.map(r => r.message.type).join() === [CLAIM, TARGET_CMD, AIRFROG_CMD].join(),
        'forwards requests, an AIRFROG_CMD get command included, and their responses');
    check(page.received.every(r => r.message.flags === RESPONSE), 'posts each response with RESPONSE in its flags');
    page.received = [];
    fake.notify('watchdog', [1]);
    await sleep(10);
    check(page.received.length === 1 && page.received[0].message.type === EXT_NOTIFY
        && page.received[0].message.flags === 0, 'posts EXT_NOTIFY with its flags clear');
    page.received = [];

    page.send({ type: TARGET_CMD, payload: new Uint8Array([3, 0, 2, 0]) }, 'https://evil.test');
    page.send({ type: TARGET_CMD, payload: new Uint8Array([3, 0, 2, 0]) }, PAGE, {});
    await sleep(10);
    check(fake.received.length === 4, 'ignores messages from another origin or window');

    button().fire('click');
    await sleep(10);
    check(lastClose()?.code === 'CLOSED' && lastClose().message === 'The airfrog.test window ended the connection.'
        && win.closed, 'Disconnect tells the page and closes the window');
    check(fake.closes.length === 0 && FakeWebSocket.opened[0].readyState === 3, 'the WebSocket closes');
}
{
    setUp('#bridge=http://onerom.org', { websites: ['http://onerom.org'] });
    await startBridge(container);
    await sleep(10);
    check(document.title === 'airfrog.test (http://onerom.org)'
        && lines()[0] === 'msg ok: http://onerom.org is connected to airfrog.test.',
        'a website not on https by its full address');
}
{
    setUp('#bridge=https://onerom.org', { password: 'frog', iterations: 500 });
    const started = startBridge(container);
    await sleep(20);
    const form = container.find('bridge-login');
    check(!form.hidden && lines().join() === 'text: Enter airfrog.test\'s password to allow onerom.org to connect.'
        && shownButton() === null, 'asks for the password');
    const forgotten = form.children.at(-1);
    check(forgotten.textContent === 'Forgotten password:' && forgotten.children[0] === ' '
        && forgotten.children[1].textContent === 'airfrog.org/recovery', 'Forgotten password: and the recovery link');
    container.find('bridge-password').value = 'toad';
    form.fire('submit');
    const askedAgain = () => !form.hidden && lines().join('|') === 'text: Enter airfrog.test\'s password to allow '
        + 'onerom.org to connect.|msg bad: Incorrect password.' && page.received.length === 0;
    await until(askedAgain);
    check(askedAgain(), 'a wrong password asks again under the first line and the website hears nothing');
    container.find('bridge-password').value = 'frog';
    form.fire('submit');
    await started;
    await sleep(20);
    check(form.hidden && page.received.length === 2 && container.find('bridge-password').value === '',
        'logs in and forwards HELLO and TARGET');
}
{
    setUp('#bridge=https://onerom.org', { password: 'frog', iterations: 500, blockSeconds: 30 });
    startBridge(container);
    await sleep(20);
    container.find('bridge-password').value = 'frog';
    container.find('bridge-login').fire('submit');
    await until(() => lines().length === 2);
    check(lines()[1] === 'msg bad: Too many failed login attempts. Retry in 30 seconds.', 'too many failed logins');
}

const GET = 0x1E, ADD = 0x20;
const allowLine = 'text: Allow evil.test to connect to airfrog.test?';
{
    setUp('#bridge=https://evil.test', { oneRequest: true });
    const started = startBridge(container);
    await until(() => lines().join() === allowLine);
    check(lines().join() === allowLine && shownButton() === 'Allow' && button().className === 'primary'
        && !cancelButton().hidden && cancelButton().textContent === 'Cancel' && page.received.length === 0
        && commands().join() === String(GET), 'a website not listed: Allow or Cancel, and the website receives nothing');
    button().fire('click');
    await started;
    await sleep(10);
    check(commands().join() === [GET, ADD].join() && fake.websites.includes('https://evil.test')
        && lines()[0] === 'msg ok: evil.test is connected to airfrog.test.' && cancelButton().hidden,
        'Allow adds the website, then connects');
    check(page.received.map(r => r.message.type).join() === [1, TARGET].join(),
        'then posts HELLO and the TARGET held while asking');
}
{
    setUp('#bridge=https://evil.test');
    const started = startBridge(container);
    await until(() => lines().join() === allowLine);
    cancelButton().fire('click');
    await started;
    check(win.closed && commands().join() === String(GET) && !fake.websites.includes('https://evil.test')
        && FakeWebSocket.opened[0].readyState >= 2 && !page.received.some(r => r.message.type !== undefined),
        'Cancel closes the window and saves nothing');
}
{
    setUp('#bridge=https://evil.test', { password: 'frog', iterations: 500 });
    startBridge(container);
    await sleep(20);
    check(commands().length === 0, 'with a password the window logs in before it reads the list');
    container.find('bridge-password').value = 'frog';
    container.find('bridge-login').fire('submit');
    await until(() => lines().join() === allowLine);
    check(lines().join() === allowLine && commands().join() === String(GET), 'then reads the list and asks');
}
const notAdded = ['msg bad: evil.test couldn\'t connect to airfrog.test.'];
for (const [what, setup, reason] of [
    ['8 websites listed', (f) => { f.websites = Array.from({ length: 8 }, (_, i) => `https://${i}.test`); },
        'airfrog.test has too many authorised websites. Revoke one in airfrog.test\'s System tab.'],
    ['Airfrog failing the add', (f) => { f.cmdErrors[ADD] = 8; },
        'Failed to add evil.test as an authorised website on airfrog.test.'],
]) {
    setUp('#bridge=https://evil.test');
    setup(fake);
    const started = startBridge(container);
    await until(() => lines().join() === allowLine);
    button().fire('click');
    await started;
    await sleep(10);
    check(lines().join('|') === [...notAdded, `text: ${reason}`, 'text: Reconnect from evil.test.'].join('|')
        && shownButton() === 'Close' && lastClose()?.message === reason && !page.received.some(r => r.message.type),
        `Allow with ${what} doesn't connect`);
}
{
    setUp('#bridge=https://evil.test');
    fake.cmdErrors[ADD] = 18;
    const started = startBridge(container);
    await until(() => lines().join() === allowLine);
    button().fire('click');
    await started;
    await sleep(10);
    check(lines()[0] === 'msg ok: evil.test is connected to airfrog.test.', 'Allow when another window added it connects');
}
{
    setUp('#bridge=https://onerom.org');
    fake.cmdErrors[GET] = 8;
    await startBridge(container);
    check(lines().join('|') === ['msg bad: onerom.org couldn\'t connect to airfrog.test.',
        'text: Failed to read airfrog.test\'s authorised websites.', 'text: Reconnect from onerom.org.'].join('|'),
    'the first read failing with an error doesn\'t connect');
}

// The 10-minute check
checkMs = 30;
{
    setUp('#bridge=https://onerom.org', { oneRequest: true });
    await startBridge(container);
    await sleep(80);
    check(commands().filter(c => c === GET).length >= 2 && lines()[0] === 'msg ok: onerom.org is connected to airfrog.test.',
        'reads the list again and stays connected while listed');
}
const revoked = ['msg bad: onerom.org was disconnected from airfrog.test.', 'text: onerom.org\'s authorisation has been revoked.',
    'text: Reconnect from onerom.org.'];
{
    setUp('#bridge=https://onerom.org');
    await startBridge(container);
    fake.websites = [];
    await sleep(80);
    check(lines().join('|') === revoked.join('|') && shownButton() === 'Close'
        && lastClose()?.message === 'onerom.org\'s authorisation has been revoked.', 'revoked: disconnects');
}
{
    setUp('#bridge=https://onerom.org', { oneRequest: true });
    await startBridge(container);
    page.send({ type: CLAIM, payload: new Uint8Array(0) });
    await sleep(10);
    fake.websites = [];
    await sleep(80);
    check(lines()[0] === 'msg ok: onerom.org is connected to airfrog.test.', 'revoked with the claim: stays connected');
    page.send({ type: 0x21, payload: new Uint8Array(0) });
    await sleep(20);
    check(lines().join('|') === revoked.join('|') && page.received.some(r => r.message.type === 0x21),
        'and disconnects once the website releases it');
}
{
    setUp('#bridge=https://onerom.org');
    await startBridge(container);
    fake.cmdErrors[GET] = 8;
    await sleep(80);
    check(lines().join('|') === ['msg bad: onerom.org was disconnected from airfrog.test.',
        'text: Failed to read airfrog.test\'s authorised websites.', 'text: Reconnect from onerom.org.'].join('|'),
    'a failed read without the claim disconnects');
}
{
    setUp('#bridge=https://onerom.org', { oneRequest: true });
    await startBridge(container);
    page.send({ type: CLAIM, payload: new Uint8Array(0) });
    await sleep(10);
    fake.cmdErrors[GET] = 8;
    await sleep(80);
    const reads = commands().filter(c => c === GET).length;
    check(lines()[0] === 'msg ok: onerom.org is connected to airfrog.test.', 'a failed read with the claim waits');
    checkMs = CHECK_MS;
    page.send({ type: 0x21, payload: new Uint8Array(0) });
    await sleep(20);
    check(commands().filter(c => c === GET).length === reads + 1 && lines()[0] === 'msg ok: onerom.org is connected to airfrog.test.',
        'then reads again on the release and stays connected when listed');
    checkMs = 30;
}
{
    // A request still running when CLAIM_MS has passed since the last
    // response keeps the claim, as Airfrog does.
    setUp('#bridge=https://onerom.org', { oneRequest: true });
    await startBridge(container);
    page.send({ type: CLAIM, payload: new Uint8Array(0) });
    await sleep(10);
    const realNow = Date.now;
    Date.now = () => realNow() + 11000;
    fake.delayNext = 150;
    page.send({ type: TARGET_CMD, payload: new Uint8Array([3, 0, 2, 0]) });
    fake.websites = [];
    await sleep(100);
    const during = lines()[0];
    await sleep(150);
    const after = lines()[0];
    page.send({ type: 0x21, payload: new Uint8Array(0) });
    await sleep(30);
    Date.now = realNow;
    check(during === 'msg ok: onerom.org is connected to airfrog.test.' && after === during
        && lines().join('|') === revoked.join('|'), 'revoked with a request running after CLAIM_MS: waits for its '
        + 'response and the release');
}
{
    // The website's request is waiting when the check starts.
    setUp('#bridge=https://onerom.org', { oneRequest: true });
    await startBridge(container);
    fake.delayNext = 60;
    page.send({ type: CLAIM, payload: new Uint8Array(0) });
    await sleep(40);
    page.send({ type: TARGET_CMD, payload: new Uint8Array([3, 0, 2, 0]) });
    await sleep(120);
    check(fake.closes.length === 0 && lines()[0] === 'msg ok: onerom.org is connected to airfrog.test.'
        && page.received.filter(r => r.message.flags === RESPONSE).map(r => r.message.type).join() === [CLAIM, TARGET_CMD].join(),
        'the check and the website\'s requests take turns, and only the website\'s responses reach it');
}
checkMs = CHECK_MS;

const disconnected = ['msg bad: onerom.org was disconnected from airfrog.test.'];
const reconnect = 'text: Reconnect from onerom.org.';
for (const [what, message, reason] of [
    ['LOGIN', { type: 2, payload: new Uint8Array(48) }, 'Received an unsupported message (LOGIN) from onerom.org.'],
    ['HELLO', { type: 1, payload: new Uint8Array(0) }, 'Received an unsupported message (HELLO) from onerom.org.'],
    ['an unknown type', { type: 0x42, payload: new Uint8Array(0) },
        'Received an unsupported message (0x0042) from onerom.org.'],
    ['AIRFROG_CMD SET_HOST_ALIASES', { type: AIRFROG_CMD, payload: new Uint8Array([0x0a, 0, 0, 0]) },
        'Received an unsupported message (AIRFROG_CMD SET_HOST_ALIASES) from onerom.org.'],
    ['an unknown AIRFROG_CMD', { type: AIRFROG_CMD, payload: new Uint8Array([0x99, 0]) },
        'Received an unsupported message (AIRFROG_CMD 0x0099) from onerom.org.'],
    ['a short AIRFROG_CMD', { type: AIRFROG_CMD, payload: new Uint8Array([1]) },
        'Received a message from onerom.org with an invalid type or payload.'],
    ['a payload that isn\'t bytes', { type: CLAIM, payload: [] },
        'Received a message from onerom.org with an invalid type or payload.'],
    ['a type out of range', { type: 0x10000, payload: new Uint8Array(0) },
        'Received a message from onerom.org with an invalid type or payload.'],
]) {
    const r = await refused(message);
    check(r.forwarded === 0 && r.lines.join('|') === [...disconnected, `text: ${reason}`, reconnect].join('|')
        && shownButton() === 'Close' && !win.closed && r.close?.message === reason,
        `${what} from the page isn't forwarded and ends the connection`);
}
{
    setUp('#bridge=https://onerom.org');
    await startBridge(container);
    await sleep(10);
    page.send({ close: { closeCode: 4000 } });
    await sleep(10);
    check(FakeWebSocket.opened[0].closeCode === 4000 && win.closed, 'the page\'s close closes the WebSocket and the window');
}
for (const [code, reason] of [
    [4003, 'airfrog.test\'s password was changed.'],
    [1001, 'airfrog.test restarted.'],
    [1006, 'airfrog.test stopped responding.'],
    [4006, 'airfrog.test\'s network settings were changed.'],
    [4000, 'airfrog.test received an unexpected message from onerom.org.'],
    [4001, 'airfrog.test received a message with an invalid signature or sequence number.'],
    [4321, 'airfrog.test closed the connection with unknown error 4321.'],
]) {
    setUp('#bridge=https://onerom.org');
    await startBridge(container);
    await sleep(10);
    fake.sessions.values().next().value.close(code);
    await sleep(10);
    check(lines().join('|') === [...disconnected, `text: ${reason}`, reconnect].join('|') && shownButton() === 'Close'
        && !win.closed && lastClose()?.message === reason, `Airfrog's close ${code} is displayed and reaches the page`);
}
{
    // Signed, with a password, so the hmac is checked
    setUp('#bridge=https://onerom.org', { password: 'frog', iterations: 500 });
    const started = startBridge(container);
    await sleep(20);
    container.find('bridge-password').value = 'frog';
    container.find('bridge-login').fire('submit');
    await started;
    await sleep(10);
    fake.corruptNext = true;
    fake.setTarget(TARGETS.running);
    await sleep(10);
    check(lines().join('|') === [...disconnected, 'text: Received an unexpected message from airfrog.test.', reconnect].join('|'),
        'an invalid message from Airfrog after login ends the connection');
    button().fire('click');
    check(win.closed, 'Close closes the window');
}
{
    setUp('#bridge=https://onerom.org');
    await startBridge(container);
    await sleep(10);
    page.closed = true;
    await sleep(600);
    check(win.closed && FakeWebSocket.opened[0].readyState === 3, 'the page\'s window closing closes the connection');
}
{
    setUp('#bridge=https://onerom.org');
    await startBridge(container);
    await sleep(10);
    win.listeners.pagehide.forEach(fn => fn({}));
    await sleep(10);
    check(lastClose()?.message === 'The airfrog.test window was closed.', 'closing this window tells the page');
}
const notConnected = ['msg bad: onerom.org couldn\'t connect to airfrog.test.'];
for (const [what, airfrog, reason] of [
    ['Airfrog not found', 'none', 'airfrog.test stopped responding.'],
    ['too many connections', 4004,
        'airfrog.test has too many connections. Close another page or program connected to airfrog.test.'],
    ['the login timed out', 4005, 'airfrog.test closed the connection because the login timed out.'],
    ['an invalid message from Airfrog', 'short', 'Received an unexpected message from airfrog.test.'],
]) {
    const closing = {
        config: {},
        connect: (framed, out, close) => {
            if (airfrog === 'short') {
                out(Buffer.alloc(3));
            } else {
                close(airfrog, '');
            }
            return { receive() {}, ended() {} };
        },
    };
    setUp('#bridge=https://onerom.org', {}, true, closing);
    if (airfrog === 'none') FakeWebSocket.hosts.delete('airfrog.test');
    await startBridge(container);
    check(lines().join('|') === [...notConnected, `text: ${reason}`, reconnect].join('|') && shownButton() === 'Close'
        && lastClose()?.message === reason, `${what} is displayed and reaches the page`);
}
{
    setUp('#bridge=https://onerom.org', { password: 'frog', iterations: 500, badProof: true });
    const started = startBridge(container);
    await sleep(20);
    container.find('bridge-password').value = 'frog';
    container.find('bridge-login').fire('submit');
    await started;
    check(lines()[1] === 'text: airfrog.test sent an invalid response to the login.', 'a login proof that doesn\'t match');
}

process.stdout.write(failures ? `${failures} FAILED\n` : 'all passed\n');
process.exit(failures ? 1 : 0);
