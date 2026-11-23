// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The Airfrog WebSocket Protocol (AWP): message types, errors, TARGET and the
// WebSocket with its counters, HMAC and login. airfrog.js and bridge.js
// share it. See airfrog-v2/docs/websocket-protocol.md.

import { hmacSha256, pbkdf2HmacSha256 } from './sha256.js';
import { CONNECTION, ERRORS } from './messages.js';
import {
    AIRFROG_CMD, CLAIM, CLOSE_BAD_COUNTER_OR_HMAC, CLOSE_LOGIN_BLOCKED, CLOSE_LOGIN_FAILED, CLOSE_LOGIN_TIMEOUT,
    CLOSE_NETWORK_SETTINGS_CHANGED, CLOSE_PASSWORD_CHANGED, CLOSE_PROTOCOL_ERROR, CLOSE_TOO_MANY_CONNECTIONS,
    COUNTER_OFFSET, DIRECTION_AIRFROG, DIRECTION_CLIENT, ERROR, ERROR_BUSY, ERROR_EXTENSION_INVALID,
    ERROR_EXTENSION_UNSUPPORTED, ERROR_IMAGE_INVALID, ERROR_INSTALL_IN_PROGRESS, ERROR_MEMORY_FAULT, ERROR_NOT_CLAIMED,
    ERROR_NOT_OFFERED, ERROR_NOT_RUNNING, ERROR_NO_SPACE, ERROR_OUT_OF_RANGE, ERROR_RESTARTING, ERROR_TRANSFER_FAILED,
    EXT_CMD, EXT_NOTIFY, FLAGS_OFFSET, FLAG_PASSWORD, FW_FLAG_RUNNING, HEADER_LEN, HEADER_RESPONSE, HELLO, HMAC_LEN,
    HMAC_OFFSET, IDENTIFY, LOGIN, LOGIN_LABEL, MESSAGE_TYPES, NONCE_LEN,
    PATH, PROOF_LABEL, PROOF_LEN, RELEASE, SESSION_LABEL, STATE_IDENTIFIED, SUBPROTOCOL, TARGET, TARGET_CMD,
    TYPE_OFFSET, decodeBusy, decodeError, decodeHello, decodeTarget, encodeLogin, messageTypeName,
} from './schema.js';

export {
    AIRFROG_CMD, CLAIM, CLOSE_BAD_COUNTER_OR_HMAC, CLOSE_PROTOCOL_ERROR, ERROR, EXT_CMD, EXT_NOTIFY, HEADER_RESPONSE,
    HELLO, IDENTIFY, LOGIN, RELEASE, TARGET, TARGET_CMD,
};

const KNOWN = new Set(MESSAGE_TYPES);

/**
 * Whether type is a message type this module defines. A client ignores the
 * others.
 * @param {number} type
 * @returns {boolean}
 */
export function isKnown(type) {
    return KNOWN.has(type);
}

/**
 * @param {number} type
 * @returns {string} the message type's name, for example CLAIM, or its
 *          number in hex when this module doesn't define it
 */
export function typeName(type) {
    return messageTypeName(type) ?? hex(type);
}

/** Limit on opening the connection, each message during login and the first TARGET. */
export const CONNECT_TIMEOUT_MS = 5000;

const FROM_CLIENT = new Uint8Array([DIRECTION_CLIENT]);
const FROM_AIRFROG = new Uint8Array([DIRECTION_AIRFROG]);
const ASCII = new TextEncoder();

/**
 * @param {number} type
 * @returns {string} for example 0x0022
 */
export function hex(type) {
    return `0x${type.toString(16).padStart(4, '0')}`;
}

/**
 * An Airfrog failure. `code` identifies it, one per airfrog-client
 * AirfrogError variant a browser can produce:
 *
 * - CONNECT: the WebSocket or the bridge window failed to open
 * - IO: sending failed after the connection opened
 * - TIMEOUT: Airfrog didn't respond in time. The connection is closed
 * - PASSWORD_REQUIRED, LOGIN_FAILED, LOGIN_BLOCKED, PROOF_MISMATCH
 * - PASSWORD_CHANGED, PROTOCOL_ERROR, BAD_COUNTER_OR_HMAC,
 *   TOO_MANY_CONNECTIONS, LOGIN_TIMEOUT, NETWORK_SETTINGS_CHANGED: Airfrog
 *   closed the connection with that close code
 * - CLOSED: the connection closed for another reason
 * - INVALID_MESSAGE: Airfrog sent a message AWP doesn't allow. The connection
 *   is closed. Also extension metadata that isn't JSON, with the connection
 *   left open
 * - BUSY, NOT_CLAIMED, NOT_OFFERED, TRANSFER_FAILED, NOT_RUNNING,
 *   MEMORY_FAULT, OUT_OF_RANGE, INSTALL_IN_PROGRESS, EXTENSION_INVALID,
 *   EXTENSION_UNSUPPORTED, NO_SPACE, IMAGE_INVALID, RESTARTING: ERROR with
 *   that code
 * - CODE: ERROR with another code
 * - PIN_NAME: a pin's name is longer than 8 bytes. Nothing is sent
 * - TRANSFER_TOO_LARGE: EXT_CMD's data is longer than schema.js's
 *   MAX_TRANSFER_MIN. Nothing is sent
 * - NOT_PERMITTED: in an extension UI, a request the Airfrog UI doesn't
 *   forward. Nothing is sent
 *
 * `detail` is BUSY's extension name (empty when a client holds the claim),
 * LOGIN_BLOCKED's seconds until logins are accepted again, CLOSED's close
 * code, CODE's error code, PIN_NAME's pin, TRANSFER_TOO_LARGE's length,
 * INVALID_MESSAGE's description of the message, CONNECT's and IO's reason,
 * NOT_PERMITTED's request, and for EXT_CMD, NOT_OFFERED's, NOT_RUNNING's and
 * OUT_OF_RANGE's extension name. Otherwise it is null.
 */
export class AirfrogError extends Error {
    /**
     * @param {string} code
     * @param {*} [detail]
     * @param {string} [message] - in place of the code's own
     */
    constructor(code, detail = null, message = undefined) {
        super(message ?? ERRORS[code]?.(detail) ?? code);
        this.name = 'AirfrogError';
        this.code = code;
        this.detail = detail;
    }
}

/**
 * @param {number} code - the WebSocket close code
 * @param {string} reason
 * @returns {AirfrogError}
 */
export function errorFromClose(code, reason) {
    switch (code) {
        case CLOSE_LOGIN_BLOCKED: {
            const seconds = /^\s*\d+\s*$/.test(reason ?? '') ? Number(reason) : null;
            return new AirfrogError('LOGIN_BLOCKED', seconds);
        }
        case CLOSE_PROTOCOL_ERROR: return new AirfrogError('PROTOCOL_ERROR');
        case CLOSE_BAD_COUNTER_OR_HMAC: return new AirfrogError('BAD_COUNTER_OR_HMAC');
        case CLOSE_LOGIN_FAILED: return new AirfrogError('LOGIN_FAILED');
        case CLOSE_PASSWORD_CHANGED: return new AirfrogError('PASSWORD_CHANGED');
        case CLOSE_TOO_MANY_CONNECTIONS: return new AirfrogError('TOO_MANY_CONNECTIONS');
        case CLOSE_LOGIN_TIMEOUT: return new AirfrogError('LOGIN_TIMEOUT');
        case CLOSE_NETWORK_SETTINGS_CHANGED: return new AirfrogError('NETWORK_SETTINGS_CHANGED');
        // A browser reports 1005 for a close frame without a code and 1006
        // for a connection lost without one.
        case 1005:
        case 1006:
            return new AirfrogError('CLOSED', null);
        default: return new AirfrogError('CLOSED', code);
    }
}

/** ERROR codes with their own AirfrogError code. */
const ERROR_CODES = {
    [ERROR_BUSY]: 'BUSY', [ERROR_NOT_CLAIMED]: 'NOT_CLAIMED', [ERROR_NOT_OFFERED]: 'NOT_OFFERED',
    [ERROR_TRANSFER_FAILED]: 'TRANSFER_FAILED', [ERROR_NOT_RUNNING]: 'NOT_RUNNING', [ERROR_MEMORY_FAULT]: 'MEMORY_FAULT',
    [ERROR_OUT_OF_RANGE]: 'OUT_OF_RANGE', [ERROR_INSTALL_IN_PROGRESS]: 'INSTALL_IN_PROGRESS',
    [ERROR_EXTENSION_INVALID]: 'EXTENSION_INVALID', [ERROR_EXTENSION_UNSUPPORTED]: 'EXTENSION_UNSUPPORTED',
    [ERROR_NO_SPACE]: 'NO_SPACE', [ERROR_IMAGE_INVALID]: 'IMAGE_INVALID', [ERROR_RESTARTING]: 'RESTARTING',
};

/**
 * @param {Uint8Array} payload - ERROR's payload
 * @returns {AirfrogError|null} null for a payload too short for its fields
 */
export function errorFromPayload(payload) {
    const error = decodeError(payload);
    if (!error) {
        return null;
    }
    const name = ERROR_CODES[error.code];
    if (error.code === ERROR_BUSY) {
        const busy = decodeBusy(payload);
        return busy ? new AirfrogError(name, busy.extension) : null;
    }
    return name ? new AirfrogError(name) : new AirfrogError('CODE', error.code);
}

/**
 * @param {Uint8Array} bytes
 * @returns {DataView}
 */
export function viewOf(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}


/**
 * TARGET's fields: what Airfrog found on the target and the services and
 * operations it supports now.
 */
export class TargetInfo {
    constructor() {
        /** 0 IDENTIFYING, 1 IDENTIFIED */
        this.state = 0;
        /** What SWD found. A bitfield */
        this.swd = 0;
        /** The TARGETID register. 0 if not read */
        this.targetid = 0;
        /** The firmware ID. 0 if none identified */
        this.firmware = 0;
        this.fwFlags = 0;
        /** @type {Array<{service: number, operation: number}>} ascending. Operation 0 is every operation */
        this.services = [];
    }

    /**
     * @param {Uint8Array} p - TARGET's payload
     * @returns {TargetInfo|null} null for a payload too short for its fields.
     *          Bytes from a later revision are ignored
     */
    static parse(p) {
        const f = decodeTarget(p);
        if (!f) {
            return null;
        }
        const t = new TargetInfo();
        t.state = f.state;
        t.swd = f.swd;
        t.targetid = f.targetid;
        t.firmware = f.firmware;
        t.fwFlags = f.fwFlags;
        t.services = f.services;
        return t;
    }

    /** @returns {boolean} whether identification is complete */
    identified() {
        return this.state === STATE_IDENTIFIED;
    }

    /** @returns {boolean} whether Airfrog has confirmed the firmware is running */
    running() {
        return (this.fwFlags & FW_FLAG_RUNNING) !== 0;
    }

    /**
     * @param {number} service
     * @returns {boolean} whether any operation of service is supported
     */
    offers(service) {
        return this.services.some(s => s.service === service);
    }

    /**
     * @param {number} service
     * @param {number} operation
     * @returns {boolean} whether operation of service is supported
     */
    supports(service, operation) {
        return this.services.some(s => s.service === service && (s.operation === 0 || s.operation === operation));
    }
}

/**
 * HELLO's fields. Bytes from a later revision are ignored.
 */
export class Hello {
    /**
     * @param {Uint8Array} p
     * @returns {Hello|null}
     */
    static parse(p) {
        const f = decodeHello(p);
        return f ? Object.assign(new Hello(), f) : null;
    }

    hasPassword() {
        return (this.flags & FLAG_PASSWORD) !== 0;
    }
}

/**
 * Concatenates byte arrays.
 * @param {...Uint8Array} parts
 * @returns {Uint8Array}
 */
export function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

/**
 * K for a password: PBKDF2-HMAC-SHA256 of its UTF-8 bytes.
 * @param {string} password
 * @param {Uint8Array} salt
 * @param {number} iterations
 * @returns {Uint8Array} 32 bytes
 */
export function passwordKey(password, salt, iterations) {
    return pbkdf2HmacSha256(ASCII.encode(password), salt, iterations);
}

function equal(a, b) {
    let diff = a.length ^ b.length;
    for (let i = 0; i < a.length && i < b.length; i++) {
        diff |= a[i] ^ b[i];
    }
    return diff === 0;
}

/**
 * One WebSocket to Airfrog, logged in where Airfrog has a password. It sets
 * and checks every message's counter and hmac.
 *
 * Messages after login go to `onmessage(type, flags, payload)`, held until
 * it is set. `onclose(error)` is called once, when the connection closes.
 */
export class AwpSocket {
    /**
     * Opens the connection, reads HELLO and logs in where Airfrog has a
     * password.
     * @param {string} host - Airfrog's host, with :port when it isn't 80
     * @param {string|null} password - ignored when Airfrog doesn't have one
     * @returns {Promise<AwpSocket>}
     */
    static open(host, password) {
        return new Promise((resolve, reject) => {
            let ws;
            try {
                ws = new WebSocket(`ws://${host}${PATH}`, SUBPROTOCOL);
            } catch (e) {
                reject(new AirfrogError('CONNECT', `invalid host ${host}`, CONNECTION.INVALID_ADDRESS(host)));
                return;
            }
            new AwpSocket(ws, password, resolve, reject);
        });
    }

    constructor(ws, password, resolve, reject) {
        this.ws = ws;
        this.tx = 0;
        this.rx = 0;
        this.key = null;
        /** @type {Hello|null} */
        this.hello = null;
        /** HELLO's payload, as Airfrog sent it */
        this.helloPayload = null;
        this.closed = null;
        this.held = [];
        this._onmessage = null;
        this.onclose = null;

        // Login
        this.password = password;
        this.opening = { resolve, reject, timer: setTimeout(() => this.fail(new AirfrogError('TIMEOUT')), CONNECT_TIMEOUT_MS) };
        this.nc = null;
        this.k = null;

        ws.binaryType = 'arraybuffer';
        this.wsOpen = false;
        ws.onopen = () => {
            this.wsOpen = true;
            if (ws.protocol !== SUBPROTOCOL) {
                this.fail(new AirfrogError('CONNECT', `subprotocol ${SUBPROTOCOL} not selected`,
                    CONNECTION.NOT_AIRFROG));
            }
        };
        ws.onmessage = (event) => this.receive(event.data);
        ws.onclose = (event) => {
            const error = this.wsOpen
                ? errorFromClose(event.code, event.reason)
                : new AirfrogError('CONNECT', 'the WebSocket failed to open');
            this.ended(error);
        };
        ws.onerror = () => {};
    }

    set onmessage(handler) {
        this._onmessage = handler;
        const held = this.held;
        this.held = [];
        for (const [type, flags, payload] of held) {
            handler(type, flags, payload);
        }
    }

    get onmessage() {
        return this._onmessage;
    }

    opened() {
        return this.opening === null;
    }

    /**
     * Sends a message with the next counter, signed once logged in.
     * @param {number} type
     * @param {Uint8Array} payload
     */
    send(type, payload) {
        if (this.closed) {
            throw this.closed;
        }
        this.tx += 1;
        const header = new Uint8Array(HMAC_OFFSET);
        const view = viewOf(header);
        view.setUint16(TYPE_OFFSET, type, true);
        view.setBigUint64(COUNTER_OFFSET, BigInt(this.tx), true);
        const mac = this.key ? hmacSha256(this.key, FROM_CLIENT, header, payload) : new Uint8Array(HMAC_LEN);
        try {
            this.ws.send(concat(header, mac, payload));
        } catch (e) {
            const error = new AirfrogError('IO', e.message);
            console.debug(`Sending to Airfrog failed: ${e.message}`);
            this.fail(error);
            throw error;
        }
    }

    /**
     * Closes the connection. Nothing more is delivered.
     * @param {number} [code] - the close code, for example 4000
     * @param {AirfrogError} [error] - the reason recorded, CLOSED by default
     */
    close(code, error) {
        this.fail(error ?? new AirfrogError('CLOSED', null, CONNECTION.CLOSED), code);
    }

    /**
     * Closes the connection with code, if it is open, and records error as
     * the reason.
     */
    fail(error, code) {
        if (this.closed) {
            return;
        }
        console.debug(`Closing the connection to Airfrog: ${error.code} ${error.detail ?? ''}`);
        try {
            if (code) {
                this.ws.close(code);
            } else {
                this.ws.close();
            }
        } catch (e) {
            // Already closing
        }
        this.ended(error);
    }

    ended(error) {
        if (this.closed) {
            return;
        }
        this.closed = error;
        if (this.opening) {
            clearTimeout(this.opening.timer);
            this.opening.reject(error);
            this.opening = null;
            return;
        }
        this.onclose?.(error);
    }

    receive(data) {
        if (this.closed) {
            return;
        }
        if (!(data instanceof ArrayBuffer)) {
            this.fail(new AirfrogError('INVALID_MESSAGE', 'text message'), CLOSE_PROTOCOL_ERROR);
            return;
        }
        const bytes = new Uint8Array(data);
        if (bytes.length < HEADER_LEN) {
            this.fail(new AirfrogError('INVALID_MESSAGE', `${bytes.length}-byte message`), CLOSE_PROTOCOL_ERROR);
            return;
        }
        const view = viewOf(bytes);
        const type = view.getUint16(TYPE_OFFSET, true);
        const flags = view.getUint16(FLAGS_OFFSET, true);
        const counter = Number(view.getBigUint64(COUNTER_OFFSET, true));
        if (counter !== this.rx + 1) {
            this.fail(new AirfrogError('INVALID_MESSAGE', `counter ${counter} after ${this.rx}`), CLOSE_BAD_COUNTER_OR_HMAC);
            return;
        }
        const payload = bytes.slice(HEADER_LEN);
        if (this.key && !equal(hmacSha256(this.key, FROM_AIRFROG, bytes.subarray(0, HMAC_OFFSET), payload),
            bytes.subarray(HMAC_OFFSET, HEADER_LEN))) {
            this.fail(new AirfrogError('INVALID_MESSAGE', `bad hmac on ${hex(type)} #${counter}`), CLOSE_BAD_COUNTER_OR_HMAC);
            return;
        }
        this.rx = counter;

        if (!this.opened()) {
            this.login(type, flags, payload);
        } else if (this._onmessage) {
            this._onmessage(type, flags, payload);
        } else {
            this.held.push([type, flags, payload]);
        }
    }

    login(type, flags, payload) {
        if (!this.hello) {
            if (type !== HELLO) {
                this.fail(new AirfrogError('INVALID_MESSAGE', `${hex(type)} before HELLO`), CLOSE_PROTOCOL_ERROR);
                return;
            }
            const hello = Hello.parse(payload);
            if (!hello) {
                this.fail(new AirfrogError('INVALID_MESSAGE', `${payload.length}-byte HELLO`), CLOSE_PROTOCOL_ERROR);
                return;
            }
            if (hello.revision < 1) {
                this.fail(new AirfrogError('INVALID_MESSAGE', `AWP revision ${hello.revision}`), CLOSE_PROTOCOL_ERROR);
                return;
            }
            this.hello = hello;
            this.helloPayload = payload;
            if (!hello.hasPassword()) {
                this.loggedIn();
                return;
            }
            if (this.password === null || this.password === undefined) {
                this.fail(new AirfrogError('PASSWORD_REQUIRED'));
                return;
            }
            if (hello.iterations === 0) {
                this.fail(new AirfrogError('INVALID_MESSAGE', 'HELLO has a password and zero iterations'), CLOSE_PROTOCOL_ERROR);
                return;
            }
            this.k = passwordKey(this.password, hello.salt, hello.iterations);
            this.nc = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
            const proof = hmacSha256(this.k, ASCII.encode(LOGIN_LABEL), hello.ns, this.nc);
            this.send(LOGIN, encodeLogin({ nc: this.nc, proof }));
            return;
        }

        if (!isKnown(type)) {
            return;
        }
        if (type !== LOGIN || !(flags & HEADER_RESPONSE)) {
            this.fail(new AirfrogError('INVALID_MESSAGE', `${hex(type)} in response to ${hex(LOGIN)}`), CLOSE_PROTOCOL_ERROR);
            return;
        }
        if (payload.length < PROOF_LEN) {
            this.fail(new AirfrogError('INVALID_MESSAGE', `${payload.length}-byte LOGIN response`), CLOSE_PROTOCOL_ERROR);
            return;
        }
        const ns = this.hello.ns;
        if (!equal(hmacSha256(this.k, ASCII.encode(PROOF_LABEL), ns, this.nc), payload.subarray(0, PROOF_LEN))) {
            this.fail(new AirfrogError('PROOF_MISMATCH'));
            return;
        }
        this.key = hmacSha256(this.k, ASCII.encode(SESSION_LABEL), ns, this.nc);
        this.loggedIn();
    }

    loggedIn() {
        this.password = null;
        this.k = null;
        const { resolve, timer } = this.opening;
        clearTimeout(timer);
        this.opening = null;
        resolve(this);
    }
}

/**
 * The key of every message between a page and the bridge window. A message
 * is `{ [BRIDGE_KEY]: { type, flags, payload } }` with an AWP message type,
 * its header's flags and its payload, or `{ [BRIDGE_KEY]: { close } }`. A
 * page's messages don't contain flags.
 *
 * From the page `close` is `{ closeCode }`, the WebSocket close code the bridge
 * window closes the connection with, or undefined for none. From the bridge
 * window `close` is `{ code, detail, message }`, the AirfrogError that closed
 * the connection.
 */
export const BRIDGE_KEY = 'airfrogBridge';

/**
 * The key of every message between an extension UI's frame and the Airfrog
 * UI. Messages are as BRIDGE_KEY's, and also:
 *
 * - from the frame, `{ connect: true }` is a connection request
 * - every message contains `id`, the connection's random id from its
 *   request, so another connection's messages are ignored
 * - the Airfrog UI's HELLO also contains `extension`, the extension name,
 *   and `limited`, whether the Airfrog UI forwards only what an extension
 *   UI may send
 */
export const EXTENSION_KEY = 'airfrogExtension';

/**
 * A website as the bridge texts display it: its host when it is on https,
 * otherwise its origin.
 * @param {string} origin - for example https://onerom.org
 * @returns {string} for example onerom.org, or http://onerom.org
 */
export function siteName(origin) {
    return origin.startsWith('https://') ? new URL(origin).host : origin;
}

/**
 * @param {AirfrogError} e
 * @returns {{code: string, detail: *, message: string}}
 */
export function errorToBridge(e) {
    return { code: e.code ?? 'CLOSED', detail: e.detail ?? null, message: e.message };
}

/**
 * @param {*} close - the close a bridge message contains
 * @returns {AirfrogError}
 */
export function errorFromBridge(close) {
    const code = typeof close?.code === 'string' ? close.code : 'CLOSED';
    const message = typeof close?.message === 'string' ? close.message : undefined;
    return new AirfrogError(code, close?.detail ?? null, message);
}
