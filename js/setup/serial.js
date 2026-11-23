// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Airfrog's messages over serial: `@af ` lines mixed with Airfrog's log. See
// "Over serial" in airfrog-v2/docs/websocket-protocol.md.
//
// The client works over any pair of byte streams: a Web Serial port's readable and
// writable, or a TCP socket's from Node's Duplex.toWeb().

import { AirfrogError as AwpError, errorFromPayload } from '../awp.js';
import { concat } from './bytes.js';
import { Command, parseHello } from './protocol.js';
import {
    AIRFROG_CMD, ERROR, HEADER_RESPONSE, HELLO, SERIAL_LINE_MAX as MAX_LINE, SERIAL_PREFIX as PREFIX, decodeHeader,
    encodeAirfrogCmd, encodeHeader,
} from '../schema.js';
import { SERIAL_ACTIONS, SERIAL_SETUP } from '../messages.js';

export { MAX_LINE, PREFIX };

/** SERIAL_ACTIONS by command number. */
const COMMAND_ACTIONS = Object.fromEntries(Object.entries(SERIAL_ACTIONS).map(([name, action]) => [Command[name], action]));

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ascii = new TextEncoder();
const text = new TextDecoder();

export class TimeoutError extends Error {}
export class HelloTimeoutError extends TimeoutError {}
export class ClosedError extends Error {}

function toBinary(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
}

// A message with counter and hmac 0.
export function encodeLine(type, payload = new Uint8Array(0), flags = 0) {
    const message = encodeHeader({ type, flags, payload });
    return ascii.encode(PREFIX + btoa(toBinary(message)) + '\n');
}

// A line without its newline or carriage return. Returns { type, flags,
// payload } for a message and { log } for any other line, including a
// malformed `@af ` line. Counter and hmac aren't checked.
export function decodeLine(line) {
    const s = text.decode(line);
    if (s.startsWith(PREFIX)) {
        const b64 = s.slice(PREFIX.length);
        const message = BASE64.test(b64) ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) : new Uint8Array(0);
        const header = decodeHeader(message);
        if (header) {
            return { type: header.type, flags: header.flags, payload: header.payload };
        }
    }
    return { log: s };
}

// Splits a byte stream into lines and passes each to onLine as decodeLine
// returns it. A line longer than MAX_LINE bytes is discarded.
export class LineDecoder {
    #onLine;
    #parts = [];
    #length = 0;
    #discarding = false;

    constructor(onLine) {
        this.#onLine = onLine;
    }

    push(chunk) {
        let start = 0;
        for (;;) {
            const nl = chunk.indexOf(0x0a, start);
            this.#append(chunk.subarray(start, nl < 0 ? chunk.length : nl));
            if (nl < 0) return;
            this.#end();
            start = nl + 1;
        }
    }

    #append(bytes) {
        if (this.#discarding || bytes.length === 0) return;
        this.#length += bytes.length;
        // One byte over MAX_LINE may be the carriage return.
        if (this.#length > MAX_LINE + 1) {
            this.#discarding = true;
            this.#parts = [];
            return;
        }
        this.#parts.push(new Uint8Array(bytes));
    }

    #end() {
        let line = concat(...this.#parts);
        const discarding = this.#discarding;
        this.#parts = [];
        this.#length = 0;
        this.#discarding = false;
        if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
        if (!discarding && line.length <= MAX_LINE) this.#onLine(decodeLine(line));
    }
}

// Resolves to the promise's value, or to undefined after ms.
function within(promise, ms) {
    let timer;
    const expired = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

// A client of Airfrog over serial. Every line that isn't a message is passed to
// onLog. Requests are sent one at a time.
export class SerialClient {
    #reader;
    #writer;
    #onLog;
    #waiting = null;
    #closed = null;
    #reading;
    // The last request, which the next waits for.
    #turn = Promise.resolve();

    constructor({ readable, writable }, { onLog = () => {} } = {}) {
        this.#reader = readable.getReader();
        this.#writer = writable.getWriter();
        this.#onLog = onLog;
        this.#reading = this.#read();
    }

    async #read() {
        const decoder = new LineDecoder((line) => this.#line(line));
        let reason = SERIAL_SETUP.CLOSED;
        try {
            for (;;) {
                const { value, done } = await this.#reader.read();
                if (done) break;
                decoder.push(value);
            }
        } catch (e) {
            reason = SERIAL_SETUP.FAILED(e.message);
        }
        this.#closed = new ClosedError(reason);
        this.#waiting?.reject(this.#closed);
        this.#waiting = null;
    }

    #line(line) {
        if (line.log !== undefined) {
            this.#onLog(line.log);
        } else if (line.flags & HEADER_RESPONSE && this.#waiting?.types.includes(line.type)) {
            this.#waiting.resolve(line);
            this.#waiting = null;
        }
    }

    // The next message of one of these types.
    #expect(types) {
        if (this.#closed) return Promise.reject(this.#closed);
        return new Promise((resolve, reject) => { this.#waiting = { types, resolve, reject }; });
    }

    // Runs fn once every earlier request has ended.
    #inTurn(fn) {
        const run = this.#turn.then(fn, fn);
        this.#turn = run.catch(() => {});
        return run;
    }

    async #send(type, payload) {
        if (this.#closed) throw this.#closed;
        await this.#writer.write(encodeLine(type, payload));
    }

    // Sends HELLO every interval ms until Airfrog's HELLO arrives, and returns
    // it parsed.
    hello(options) {
        return this.#inTurn(() => this.#hello(options));
    }

    async #hello({ interval = 500, timeout = 20000 } = {}) {
        const deadline = Date.now() + timeout;
        const reply = this.#expect([HELLO]);
        try {
            for (;;) {
                const left = deadline - Date.now();
                if (left <= 0) {
                    throw new HelloTimeoutError(SERIAL_SETUP.NO_HELLO(timeout / 1000));
                }
                await this.#send(HELLO);
                const line = await within(reply, Math.min(interval, left));
                if (line) return parseHello(line.payload);
            }
        } finally {
            this.#waiting = null;
            reply.catch(() => {});
        }
    }

    // Sends AIRFROG_CMD and returns the response's fields.
    // A failure is the AirfrogError the WebSocket's would be.
    command(cmd, fields = new Uint8Array(0), options = {}) {
        return this.#inTurn(() => this.#command(cmd, fields, options));
    }

    async #command(cmd, fields, { timeout = 5000 } = {}) {
        const action = COMMAND_ACTIONS[cmd] || SERIAL_SETUP.COMMAND(cmd);
        const reply = this.#expect([AIRFROG_CMD, ERROR]);
        try {
            await this.#send(AIRFROG_CMD, encodeAirfrogCmd({ command: cmd, fields }));
            const line = await within(reply, timeout);
            if (!line) {
                throw new TimeoutError(SERIAL_SETUP.NO_RESPONSE(action));
            }
            if (line.type === ERROR) {
                throw errorFromPayload(line.payload) ?? new AwpError('INVALID_MESSAGE', 'ERROR too short');
            }
            return line.payload;
        } finally {
            this.#waiting = null;
            reply.catch(() => {});
        }
    }

    // Stops reading and releases both streams. The caller closes them.
    async close() {
        try {
            await this.#reader.cancel();
        } catch {
            // Already closed or failed.
        }
        await this.#reading;
        this.#reader.releaseLock();
        this.#writer.releaseLock();
    }
}

/**
 * The setup's transport over serial, for Setup.
 * @implements {import('./setup.js').Transport}
 */
export class SerialTransport {
    /**
     * @param {SerialClient} serial
     * @param {object} hello - SerialClient.hello()'s
     */
    constructor(serial, hello) {
        this.serial = serial;
        this.hello = hello;
        this.closes = false;
    }

    command(cmd, fields, timeoutMs) {
        return this.serial.command(cmd, fields, { timeout: timeoutMs });
    }
}
