// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// An extension UI tab's frame: Loading, the failure after the load time, the
// frame displayed once connectExtension() reaches it, unloading after the
// tab is hidden, and reloading. Also the installed list's reordering and
// states. A minimal document stands in for the browser's.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sleep } from './helpers.mjs';

class Element {
    constructor(tag) {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.attributes = {};
        this.listeners = {};
        this.hidden = false;
        this.className = '';
        this.parent = null;
        this.contentWindow = tag === 'iframe' ? { posted: [], postMessage(d, o) { this.posted.push([d, o]); } } : null;
    }
    get textContent() {
        return this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join('');
    }
    set textContent(t) {
        this.children = [String(t)];
    }
    append(...c) {
        for (const x of c) {
            if (typeof x === 'object') x.parent = this;
            this.children.push(x);
        }
    }
    replaceChildren(...c) {
        this.children = [];
        this.append(...c);
    }
    remove() {
        if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
        this.parent = null;
    }
    setAttribute(k, v) { this.attributes[k] = v; }
    addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
    querySelectorAll() { return []; }
}
globalThis.document = { createElement: (tag) => new Element(tag), addEventListener() {} };

const { ExtensionPane } = await import('../../ui/src/extensions/pane.js');
const { moved, stateText } = await import('../../ui/src/extensions/tab.js');
const { EXTENSION_KEY } = await import('../../js/awp.js');
const { WasmState } = await import('../../js/schema.js');

const frameOf = (pane) => pane.holder.children[0] ?? null;

function pane(times = { loadMs: 40, unloadMs: 60 }) {
    const opened = [];
    const p = new ExtensionPane({ name: 'hello', displayName: 'Hello', ui: 'https://example.com/hello/', times,
        open: () => {
            opened.push(1);
            return new Promise(() => {});
        } });
    return { p, opened };
}

test('Loading, then failed after the load time', async () => {
    const { p } = pane();
    assert.equal(p.state, 'unloaded');
    p.shown();
    const frame = frameOf(p);
    assert.equal(frame.tagName, 'IFRAME');
    assert.equal(frame.src, 'https://example.com/hello/');
    assert.equal(frame.hidden, true, 'the frame is hidden until connectExtension() reaches the Airfrog UI');
    assert.equal(frame.attributes.sandbox.split(' ').includes('allow-top-navigation'), false);
    assert.equal(frame.referrerPolicy, 'no-referrer');
    assert.equal(p.msg.textContent, 'Loading Hello UI…');
    await sleep(60);
    assert.equal(p.state, 'failed');
    assert.equal(p.msg.textContent, 'Hello UI failed to load. Reload the page.');
    assert.equal(p.msg.className, 'msg bad');
    p.destroy();
});

test('loaded when connectExtension() arrives from the frame and its origin', async () => {
    const { p, opened } = pane();
    p.shown();
    const frame = frameOf(p);
    const connect = { [EXTENSION_KEY]: { connect: true, id: 'c1' } };
    p.receive({ source: {}, origin: 'https://example.com', data: connect });
    p.receive({ source: frame.contentWindow, origin: 'https://example.org', data: connect });
    assert.equal(opened.length, 0, 'another window or origin is ignored');
    p.receive({ source: frame.contentWindow, origin: 'https://example.com', data: connect });
    assert.equal(opened.length, 1);
    assert.equal(p.state, 'loaded');
    assert.equal(frame.hidden, false);
    assert.equal(p.msg.textContent, '');
    await sleep(60);
    assert.equal(p.state, 'loaded', "the load time doesn't apply once loaded");
    p.destroy();
});

test('unloaded after the tab is hidden, loaded again when displayed', async () => {
    const { p } = pane();
    p.shown();
    p.receive({ source: frameOf(p).contentWindow, origin: 'https://example.com', data: { [EXTENSION_KEY]: { connect: true, id: 'c1' } } });
    p.hidden();
    await sleep(30);
    assert.equal(p.state, 'loaded', 'still loaded while hidden');
    p.shown();
    p.hidden();
    await sleep(30);
    assert.equal(p.state, 'loaded', 'displaying the tab again restarts the time');
    await sleep(50);
    assert.equal(p.state, 'unloaded');
    assert.equal(frameOf(p), null);
    p.shown();
    assert.equal(p.state, 'loading');
    p.destroy();
});

test('reload and a new address', () => {
    const { p } = pane({ loadMs: 1000, unloadMs: 1000 });
    p.reload();
    assert.equal(p.state, 'unloaded', 'an unloaded extension UI stays unloaded');
    p.shown();
    const first = frameOf(p);
    p.reload();
    assert.notEqual(frameOf(p), first, 'a loaded extension UI gets a new frame');
    p.update('Hello 2', 'https://example.com/hello/2/');
    assert.equal(frameOf(p).src, 'https://example.com/hello/2/');
    assert.equal(frameOf(p).title, 'Hello 2');
    p.destroy();
    assert.equal(p.state, 'unloaded');
});

test("the installed list's order and states", () => {
    assert.deepEqual(moved(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
    assert.deepEqual(moved(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
    assert.equal(stateText(WasmState.NO_MODULE), 'UI only');
    assert.equal(stateText(WasmState.RUNNING), 'Running');
    assert.equal(stateText(WasmState.STOPPED), 'Stopped');
    assert.equal(stateText(WasmState.NOT_STARTED), 'Stopped');
});
