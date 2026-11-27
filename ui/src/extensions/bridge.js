// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The Airfrog UI's side of an extension UI's connection. The extension UI is
// in a frame from another website and calls Airfrog.connectExtension(). The
// Airfrog UI opens a connection of its own for it, logs in and signs, and
// forwards only the messages route() allows. An extension UI from a website
// in the Airfrog manifest's full_access_websites has every request
// forwarded. Its SET_PASSWORD's key is sent in the clear, as its connection
// has no session key, so it is encrypted here with the forwarding
// connection's.

import {
    AIRFROG_CMD, AirfrogError, CLAIM, ERROR, EXTENSION_KEY, EXT_CMD, EXT_NOTIFY, HEADER_RESPONSE, HELLO, IDENTIFY,
    RELEASE, TARGET_CMD, errorToBridge,
} from '../../../js/awp.js';
import {
    Command, ERROR_OUT_OF_RANGE, PASSWORD_LABEL, SET_PASSWORD_LEN, decodeAirfrogCmd, decodeExtCmd, encodeAirfrogCmd,
    encodeError,
} from '../../../js/schema.js';
import { hmacSha256 } from '../../../js/sha256.js';

const FORWARDED = new Set([CLAIM, RELEASE, TARGET_CMD, IDENTIFY]);
const GET_COMMANDS = new Set(Object.entries(Command).filter(([k]) => k.startsWith('GET_')).map(([, v]) => v));

/**
 * Whether an extension UI from origin has full access: origin is one of
 * websites exactly, so a subdomain isn't included.
 * @param {string} origin
 * @param {Array<string>} websites - the Airfrog manifest's
 *        full_access_websites
 */
export function isTrusted(origin, websites) {
    return websites.some((w) => {
        try {
            return new URL(w).origin === origin;
        } catch (e) {
            return false;
        }
    });
}

/**
 * A forwarded message's payload: unchanged, but for SET_PASSWORD on a
 * logged-in connection, whose key is XORed with HMAC-SHA256(S,
 * PASSWORD_LABEL ‖ salt), removal included.
 * @param {number} type
 * @param {Uint8Array} payload
 * @param {Uint8Array|null} s - the forwarding connection's key S, null when
 *        Airfrog doesn't have a password
 * @returns {Uint8Array}
 */
export function forwarded(type, payload, s) {
    const cmd = type === AIRFROG_CMD ? decodeAirfrogCmd(payload) : null;
    if (!s || cmd?.command !== Command.SET_PASSWORD || cmd.fields.length !== SET_PASSWORD_LEN) {
        return payload;
    }
    const fields = cmd.fields.slice();
    const pad = hmacSha256(s, new TextEncoder().encode(PASSWORD_LABEL), fields.subarray(32));
    for (let i = 0; i < 32; i++) {
        fields[i] ^= pad[i];
    }
    return encodeAirfrogCmd({ command: cmd.command, fields });
}

/**
 * The Airfrog UI's action for a message from an extension UI.
 * @param {*} message - the message's { type, payload }
 * @param {string} name - the extension name
 * @param {boolean} trusted - whether the extension UI has full access
 * @returns {'forward'|'drop'|'not-installed'} not-installed: EXT_CMD to
 *          another extension, answered with ERROR OUT_OF_RANGE
 */
export function route(message, name, trusted) {
    const { type, payload } = message ?? {};
    if (!Number.isInteger(type) || type < 0 || type > 0xffff || !(payload instanceof Uint8Array)) {
        return 'drop';
    }
    if (trusted || FORWARDED.has(type)) {
        return 'forward';
    }
    if (type === AIRFROG_CMD) {
        const cmd = decodeAirfrogCmd(payload);
        return cmd && GET_COMMANDS.has(cmd.command) ? 'forward' : 'drop';
    }
    if (type === EXT_CMD) {
        const cmd = decodeExtCmd(payload);
        if (!cmd) {
            return 'drop';
        }
        return cmd.name === name ? 'forward' : 'not-installed';
    }
    return 'drop';
}

/**
 * One extension UI's connection, for the frame the Airfrog UI created. The
 * frame has at most one connection and one login in progress. Each
 * connectExtension() in the frame has its own id, which every message in
 * both directions contains, so messages of a replaced connection are
 * ignored. The Airfrog UI passes each window message event to receive().
 */
export class FrameLink {
    /** The id of the connection the frame wants, or null */
    #id = null;
    /** The open connection, for #id */
    #socket = null;
    /** The id of the frame's last connection request, whose heights are used after it closes */
    #heightId = null;
    #opening = false;
    #closed = false;

    /**
     * @param {object} options
     * @param {string} options.name - the extension name
     * @param {string} options.origin - the website the extension UI is loaded
     *        from
     * @param {function(): Window|null} options.target - the frame's window
     * @param {function(): Promise<import('../../../js/awp.js').AwpSocket>} options.open -
     *        opens and logs in a new connection to Airfrog
     * @param {function(): Array<string>} [options.fullAccess] - the
     *        Airfrog manifest's full_access_websites, read at each
     *        connection
     * @param {function()} [options.onConnect] - called on each connection
     *        request from the extension UI
     * @param {function(number)} [options.onHeight] - called with the
     *        extension UI's page height in pixels, which its open connection
     *        posts
     */
    constructor({ name, origin, target, open, fullAccess = () => [], onConnect = () => {}, onHeight = () => {} }) {
        this.name = name;
        this.origin = origin;
        this.fullAccess = fullAccess;
        this.trusted = false;
        this.target = target;
        this.open = open;
        this.onConnect = onConnect;
        this.onHeight = onHeight;
    }

    /** @param {MessageEvent} event */
    receive(event) {
        const win = this.target();
        if (this.#closed || !win || event.source !== win || event.origin !== this.origin) {
            return;
        }
        const message = event.data?.[EXTENSION_KEY];
        if (!message || typeof message !== 'object' || typeof message.id !== 'string' || !message.id) {
            return;
        }
        if (message.connect) {
            this.onConnect();
            this.#request(message.id);
            return;
        }
        if ('height' in message) {
            if (message.id === this.#heightId && Number.isInteger(message.height) && message.height >= 0) {
                this.onHeight(message.height);
            }
            return;
        }
        if (message.id !== this.#id) {
            return;
        }
        if (message.close) {
            // The frame ended this connection itself, so no close is posted.
            this.#id = null;
            this.#drop(Number.isInteger(message.close.closeCode) ? message.close.closeCode : undefined);
            return;
        }
        switch (route(message, this.name, this.trusted)) {
            case 'forward':
                try {
                    const socket = this.#socket;
                    socket?.send(message.type, forwarded(message.type, message.payload, socket.key));
                } catch (e) {
                    // The connection closed, and onclose has posted why
                }
                return;
            case 'not-installed':
                this.#post(this.#id, { type: ERROR, flags: HEADER_RESPONSE,
                    payload: encodeError({ code: ERROR_OUT_OF_RANGE }) });
                return;
            default:
                console.warn(`${this.name} UI: message type ${message.type} dropped`);
        }
    }

    /** Closes the connection without posting a close: the frame is being removed or reloaded. */
    close() {
        this.#closed = true;
        this.#id = null;
        this.#heightId = null;
        this.#drop();
    }

    #post(id, message) {
        try {
            this.target()?.postMessage({ [EXTENSION_KEY]: { ...message, id } }, this.origin);
        } catch (e) {
            // The frame is gone
        }
    }

    /** Closes the open connection, if any. */
    #drop(code) {
        const socket = this.#socket;
        this.#socket = null;
        socket?.close(code);
    }

    /**
     * A connection request with id. The connection or request it replaces
     * is closed and posted a close.
     */
    #request(id) {
        if (this.#id) {
            this.#post(this.#id, { close: errorToBridge(new AirfrogError('CLOSED')) });
        }
        this.#drop();
        this.#id = id;
        this.#heightId = id;
        if (!this.#opening) {
            this.#openWanted();
        }
    }

    /** Opens connections one at a time until the one wanted is open. */
    async #openWanted() {
        this.#opening = true;
        while (this.#id && !this.#socket && !this.#closed) {
            const id = this.#id;
            let socket;
            try {
                socket = await this.open();
            } catch (e) {
                if (this.#id === id && !this.#closed) {
                    this.#id = null;
                    this.#post(id, { close: errorToBridge(e instanceof AirfrogError ? e
                        : new AirfrogError('CONNECT', e.message)) });
                }
                continue;
            }
            if (this.#id !== id || this.#closed) {
                socket.close();
                continue;
            }
            this.#attach(id, socket);
        }
        this.#opening = false;
    }

    #attach(id, socket) {
        this.#socket = socket;
        this.trusted = isTrusted(this.origin, this.fullAccess());
        socket.onclose = (error) => {
            if (this.#socket === socket) {
                this.#socket = null;
                this.#id = null;
                this.#post(id, { close: errorToBridge(error) });
            }
        };
        this.#post(id, { type: HELLO, flags: 0, payload: socket.helloPayload, extension: this.name,
            limited: !this.trusted });
        socket.onmessage = (type, flags, payload) => {
            if (type === EXT_NOTIFY && decodeExtCmd(payload)?.name !== this.name) {
                return;
            }
            this.#post(id, { type, flags, payload });
        };
    }
}
