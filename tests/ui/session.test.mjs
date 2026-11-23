// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The page's connection to Airfrog: login, the password form's errors and reconnecting.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serve, statuses, until } from './helpers.mjs';
import { Session } from '../../js/setup/session.js';
import { Command, EMPTY } from '../../js/setup/protocol.js';
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
