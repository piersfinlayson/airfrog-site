// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The page's connection to Airfrog: login, the password form's errors and reconnecting.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serve, statuses, until } from './helpers.mjs';
import { AP_BUTTON, STATION } from './fake-airfrog.mjs';
import { Session } from '../../js/setup/session.js';
import { Command, EMPTY } from '../../js/setup/protocol.js';
import { CONNECTION, ERRORS } from '../../js/messages.js';
import { pbkdf2HmacSha256 } from '../../js/sha256.js';

const last = (seen) => seen.at(-1);
const connected = (seen) => () => last(seen)?.state === 'connected';

test('connects without a password', async () => {
    const { host } = serve();
    const session = new Session(host, { retryMs: 10 });
    const seen = statuses(session);
    session.start();
    await until(connected(seen));
    assert.equal(session.hasPassword, false);
    assert.ok(session.airfrog.getTarget().identified());
    session.stop();
});

test('the password form: required, incorrect, then logged in', async () => {
    const { fake, host } = serve({ password: 'frog' });
    const session = new Session(host, { retryMs: 10 });
    const seen = statuses(session);
    session.start();
    await until(() => last(seen)?.state === 'password');
    assert.equal(last(seen).message, null);
    session.login('toad');
    await until(() => last(seen)?.state === 'password' && last(seen).message);
    assert.equal(last(seen).message, 'Incorrect password.');
    session.login('frog');
    await until(connected(seen));
    assert.equal(session.hasPassword, true);
    assert.deepEqual(fake.closes, [4002]);
    session.stop();
});

test('logins blocked: Retry in N seconds', async () => {
    const { host } = serve({ password: 'frog', blockSeconds: 30 });
    const session = new Session(host, { retryMs: 10 });
    const seen = statuses(session);
    session.start();
    await until(() => last(seen)?.state === 'password');
    session.login('frog');
    await until(() => last(seen)?.message?.startsWith('Too many'));
    assert.equal(last(seen).message, 'Too many failed login attempts. Retry in 30 seconds.');
    const one = serve({ password: 'frog', blockSeconds: 1 });
    const s1 = new Session(one.host, { retryMs: 10 });
    const seen1 = statuses(s1);
    s1.login('frog');
    await until(() => last(seen1)?.message?.startsWith('Too many'));
    assert.equal(last(seen1).message, 'Too many failed login attempts. Retry in 1 second.');
    session.stop();
    s1.stop();
});

test('reconnects with the password kept in memory after 4006 and 1001', async () => {
    const { fake, host } = serve({ password: 'frog' });
    const session = new Session(host, { retryMs: 10 });
    const seen = statuses(session);
    session.login('frog');
    await until(connected(seen));
    const first = session.airfrog;
    fake.closeAll(4006);
    await until(() => session.airfrog && session.airfrog !== first);
    assert.ok(seen.some(s => s.message === 'Network settings changed. Reconnecting…'));
    const second = session.airfrog;
    fake.closeAll(1001);
    await until(() => session.airfrog && session.airfrog !== second);
    assert.ok(seen.some(s => s.message === 'Airfrog restarting. Reconnecting…'));
    assert.equal(seen.filter(s => s.state === 'password').length, 0);
    session.stop();
});

test('a password changed over another connection: log in again', async () => {
    const { fake, host } = serve({ password: 'frog' });
    const session = new Session(host, { retryMs: 10 });
    const seen = statuses(session);
    session.login('frog');
    await until(connected(seen));
    fake.key = pbkdf2HmacSha256(new TextEncoder().encode('newt'), fake.salt, fake.config.iterations);
    fake.closeAll(4003);
    await until(() => last(seen)?.state === 'password');
    assert.equal(last(seen).message, 'Password changed. Log in again.');
    session.login('newt');
    await until(connected(seen));
    session.stop();
});

test("this page's SET_PASSWORD: reconnects with the new password, or without after removing it", async () => {
    const { fake, host } = serve({ password: 'frog' });
    const session = new Session(host, { retryMs: 10 });
    const seen = statuses(session);
    session.login('frog');
    await until(connected(seen));
    let airfrog = session.airfrog;
    session.expectClose({ message: 'Password set.', password: 'newt' });
    await airfrog.setPassword('newt');
    await until(() => session.airfrog && session.airfrog !== airfrog);
    assert.ok(seen.some(s => s.message === 'Password set.'));
    assert.equal(session.hasPassword, true);

    airfrog = session.airfrog;
    session.expectClose({ message: 'Password removed.', password: null });
    await airfrog.setPassword('');
    await until(() => session.airfrog && session.airfrog !== airfrog);
    assert.equal(session.hasPassword, false);
    assert.equal(seen.filter(s => s.state === 'password').length, 0);
    session.stop();
});

test("nextConnection() and retries while Airfrog can't be reached", async () => {
    const { fake, host } = serve();
    const session = new Session(host, { retryMs: 10 });
    const seen = statuses(session);
    session.start();
    await until(connected(seen));
    fake.config.restartMs = 100;
    const next = session.nextConnection(2000);
    fake.restart();
    const airfrog = await next;
    assert.ok(airfrog && !airfrog.isClosed());
    assert.ok(seen.some(s => s.state === 'waiting' && s.message === 'Airfrog not found. Check its address and network. Reconnecting…'));
    assert.equal(await session.nextConnection(20), null);
    await session.airfrog.airfrogCmd(Command.GET_FW_INFO, EMPTY, 1000);
    session.stop();
});

test("an expected reconnect is marked expected, and keeps its message while Airfrog can't be reached", async () => {
    const { fake, host } = serve({ restartMs: 200 });
    const session = new Session(host, { retryMs: 10 });
    const seen = statuses(session);
    session.start();
    await until(connected(seen));
    session.expectClose({ message: 'Hostname changed to frog. Open http://frog.local/.' });
    fake.restart();
    await until(() => seen.filter(s => s.state === 'connecting').length > 2);
    const during = seen.slice(seen.findIndex(s => s.state === 'waiting'));
    assert.ok(during.filter(s => s.state !== 'connected')
        .every(s => s.expected && s.message === 'Hostname changed to frog. Open http://frog.local/.'));
    await until(connected(seen));
    fake.closeAll(4006);
    await until(() => last(seen).state === 'waiting');
    assert.equal(last(seen).expected, false, 'a close the page didn\'t expect');
    session.stop();
});

test("Airfrog's iterations below MIN_ITERATIONS: failed, without retrying", async () => {
    const { fake, host } = serve({ password: 'frog', iterations: 99999 });
    const session = new Session(host, { retryMs: 10 });
    const seen = statuses(session);
    session.start();
    await until(() => last(seen)?.state === 'failed');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(last(seen).state, 'failed');
    assert.equal(last(seen).message, ERRORS.ITERATIONS_TOO_LOW(99999));
    assert.equal(seen.filter(s => s.state === 'connecting').length, 1, 'no further attempt');
    assert.ok(!fake.received.length, 'nothing is sent');
    session.stop();
});

test("a connect() whose HELLO check fails with OTHER_FIRMWARE: failed, without retrying", async () => {
    const { host } = serve();
    const { Airfrog, AirfrogError } = await import('../../js/airfrog.js');
    const session = new Session(host, { retryMs: 10, connect: (h, p) => Airfrog.connect(h, p,
        { checkHello: () => new AirfrogError('OTHER_FIRMWARE', null, 'Other firmware.') }) });
    const seen = statuses(session);
    session.start();
    await until(() => last(seen)?.state === 'failed');
    assert.equal(last(seen).message, 'Other firmware.');
    session.stop();
});

test("over the recovery button's access point a forgotten password is replaced, then the login card asks for it", async () => {
    const { fake, host } = serve({ password: 'frog', interface: AP_BUTTON });
    const session = new Session(host, { retryMs: 10 });
    const seen = statuses(session);
    session.start();
    await until(() => last(seen)?.state === 'password');
    assert.equal(last(seen).via, AP_BUTTON, "the password state contains HELLO's interface");
    session.resetPassword('Newt2026x');
    await until(() => last(seen)?.state === 'password' && last(seen).message);
    assert.deepEqual(last(seen), { state: 'password', message: CONNECTION.PASSWORD_SAVED, expected: true, via: AP_BUTTON });
    assert.deepEqual([...fake.key], [...pbkdf2HmacSha256(new TextEncoder().encode('Newt2026x'), fake.salt, 100000)],
        'SET_PASSWORD before LOGIN, its key in the clear');
    assert.ok(seen.some(s => s.state === 'connecting' && s.message === 'Saving…'));
    assert.ok(!seen.some(s => s.state === 'connected'), "the page doesn't log in by itself");
    session.login('Newt2026x');
    await until(connected(seen));
    assert.equal(session.hasPassword, true);
    session.stop();
});

test("expectClose()'s loginNote: the next connection doesn't log in, and the login card displays the note", async () => {
    const { fake, host } = serve();
    const session = new Session(host, { retryMs: 10 });
    const seen = statuses(session);
    session.start();
    await until(connected(seen));
    session.expectClose({ message: 'Password set. Reconnecting…', password: null, loginNote: CONNECTION.PASSWORD_SAVED });
    await session.airfrog.setPassword('Newt2026x');
    await until(() => last(seen)?.state === 'password');
    assert.equal(last(seen).message, CONNECTION.PASSWORD_SAVED);
    assert.equal(last(seen).expected, true);
    assert.ok(seen.some(s => s.state === 'waiting' && s.message === 'Password set. Reconnecting…'));
    session.login('Newt2026x');
    await until(connected(seen));
    assert.ok(fake.key);
    session.stop();
});

test('replacing a password over another connection fails with NOT_PERMITTED on the login form', async () => {
    const { host } = serve({ password: 'frog' });
    const session = new Session(host, { retryMs: 10 });
    const seen = statuses(session);
    session.start();
    await until(() => last(seen)?.state === 'password');
    assert.equal(last(seen).via, STATION);
    session.resetPassword('Newt2026x');
    await until(() => last(seen)?.state === 'password' && last(seen).message);
    assert.equal(last(seen).message, ERRORS.NOT_PERMITTED());
    session.stop();
});

test('the reconnect after an install opens with confirming, and endConfirming() closes it', async () => {
    const { fake, host } = serve();
    const { Airfrog } = await import('../../js/airfrog.js');
    const calls = [];
    const session = new Session(host, { retryMs: 10, connect: (h, p, options) => {
        calls.push(options);
        return Airfrog.connect(h, p);
    } });
    const seen = statuses(session);
    session.start();
    await until(connected(seen));
    assert.deepEqual(calls, [{ confirming: false }]);
    const next = session.nextConnection(2000);
    session.expectClose({ message: 'Restarting', confirm: true });
    fake.closeAll(1001);
    const after = await next;
    assert.deepEqual(calls.at(-1), { confirming: true }, 'the reconnect opens with confirming');
    const again = session.nextConnection(2000);
    session.endConfirming();
    assert.ok(after.isClosed(), 'endConfirming() closes it');
    await again;
    assert.deepEqual(calls.at(-1), { confirming: false }, 'the next connection opens without confirming');
    assert.ok(seen.some(s => s.message === 'Reconnecting…' && s.expected), 'its close is expected');
    session.stop();
});
