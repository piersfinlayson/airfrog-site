// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Shared by the tests of Airfrog's full user interface: the fake Airfrog on a fake WebSocket, and test
// data.

import { IMAGE_MODEL_OFFSET, Model } from '../../js/schema.js';
import { FakeAirfrog, FakeWebSocket } from './fake-airfrog.mjs';

globalThis.WebSocket = FakeWebSocket;

// picoflash and one-rom-wasm log each step
console.log = () => {};
console.debug = () => {};
console.info = () => {};
console.warn = () => {};

let hosts = 0;

/** A fake Airfrog at a new host. */
export function serve(config) {
    const fake = new FakeAirfrog(config);
    const host = `airfrog${++hosts}.test`;
    FakeWebSocket.hosts.set(host, fake);
    return { fake, host };
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Waits up to timeoutMs for condition() to be true. */
export async function until(condition, timeoutMs = 2000) {
    const end = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > end) {
            throw new Error('Timed out waiting for a condition');
        }
        await sleep(5);
    }
}

/** An ESP-IDF app image of size bytes with version in its app description, for model. */
export function espImage(version, size = 10000, { chip = 5, model = Model.MINI, project = 'airfrog' } = {}) {
    const image = new Uint8Array(size).map((_, i) => (i * 13) & 0xff);
    image[0] = 0xE9;
    new DataView(image.buffer).setUint16(12, chip, true);
    new DataView(image.buffer).setUint16(IMAGE_MODEL_OFFSET, model, true);
    new DataView(image.buffer).setUint32(32, 0xABCD5432, true);
    image.fill(0, 48, 112);
    image.set(new TextEncoder().encode(version), 48);
    image.set(new TextEncoder().encode(project), 80);
    return image;
}

/** A session's statuses, in order. */
export function statuses(session) {
    const seen = [];
    session.addEventListener('status', (e) => seen.push(e.detail));
    return seen;
}
