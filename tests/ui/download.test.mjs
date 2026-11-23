// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// js/setup/download.js against an HTTP server: a server that doesn't answer,
// one that stops part way, a slow one and the other failures. The limit is
// short here.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { DownloadError, download } from '../../js/setup/download.js';

const LIMIT = 300;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
    if (req.url === '/silent') {
        return;
    }
    if (req.url === '/missing') {
        res.writeHead(404).end('not here');
        return;
    }
    res.writeHead(200, { 'Content-Length': req.url === '/empty' ? 0 : 5 });
    if (req.url === '/empty') {
        res.end();
        return;
    }
    res.write('a');
    if (req.url === '/cut') {
        await sleep(20);
        res.destroy();
    } else if (req.url === '/slow') {
        for (const c of 'bcde') {
            await sleep(LIMIT * 0.6);
            res.write(c);
        }
        res.end();
    } else if (req.url === '/whole') {
        res.end('bcde');
    }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
after(() => {
    server.closeAllConnections();
    server.close();
});
const at = (path) => `http://127.0.0.1:${server.address().port}${path}`;

/** The error of a download that fails, and how long it took in ms. */
async function failure(url) {
    const start = Date.now();
    const e = await download(url, { timeoutMs: LIMIT }).then(() => assert.fail(`${url} downloaded`), (err) => err);
    assert.ok(e instanceof DownloadError, String(e));
    return { e, ms: Date.now() - start };
}

test('a download', async () => {
    assert.equal(new TextDecoder().decode(await download(at('/whole'))), 'abcde');
    assert.equal((await download(at('/empty'))).length, 0);
});

test("a server that accepts the connection and doesn't answer", async () => {
    const { e, ms } = await failure(at('/silent'));
    assert.equal(e.timedOut, true);
    assert.equal(e.status, null);
    assert.ok(ms >= LIMIT * 0.9 && ms < LIMIT * 10, `${ms} ms`);
});

test('a server that stops part way through the body', async () => {
    const { e, ms } = await failure(at('/stalled'));
    assert.equal(e.timedOut, true);
    assert.ok(ms >= LIMIT * 0.9 && ms < LIMIT * 10, `${ms} ms`);
});

test('a server that takes longer than the limit but keeps sending', async () => {
    const start = Date.now();
    assert.equal(new TextDecoder().decode(await download(at('/slow'), { timeoutMs: LIMIT })), 'abcde');
    assert.ok(Date.now() - start > LIMIT * 2);
});

test("an HTTP error, a connection that closes and a server that can't be reached", async () => {
    const missing = await failure(at('/missing'));
    assert.equal(missing.e.status, 404);
    assert.equal(missing.e.timedOut, false);
    for (const url of [at('/cut'), 'http://127.0.0.1:1/']) {
        const { e } = await failure(url);
        assert.equal(e.status, null, url);
        assert.equal(e.timedOut, false, url);
    }
});
