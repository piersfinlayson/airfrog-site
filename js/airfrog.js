// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// A client for the Airfrog WebSocket Protocol (AWP), which reaches the target
// an Airfrog is connected to through Airfrog's services. The JavaScript version
// of the Rust crate airfrog-client.
//
//     const airfrog = await Airfrog.connectBridge('airfrog.local');
//     await airfrog.resetBoot();
//     const bootRom = await airfrog.waitForTarget(5000,
//         t => t.offers(Service.PICOBOOT_RP2350_SWD));

import {
    AirfrogError, AwpSocket, BRIDGE_KEY, CLAIM, CLOSE_PROTOCOL_ERROR, CONNECT_TIMEOUT_MS, ERROR, EXTENSION_KEY, EXT_CMD,
    EXT_NOTIFY, HEADER_RESPONSE, HELLO, Hello, IDENTIFY, AIRFROG_CMD, RELEASE, TARGET, TARGET_CMD, TargetInfo,
    errorFromBridge, errorFromPayload, hex, isKnown, passwordKey, siteName,
} from './awp.js';
import {
    Command, ExtensionFlag, Firmware, IdentifyFlag, IdentifyResult, MAX_TRANSFER_MIN, Operation, PIN_NAME_LEN, PinLevel,
    SALT_LEN, Service, SetExtensionFlag, WasmReason, WasmState, decodeExtCmd, decodeExtensions, decodeIdentifyResponse,
    encodeAirfrogCmd, encodeExtBegin, encodeExtCmd, encodeExtensionName, encodeIdentify, encodeOtaWrite,
    encodeResetPins, encodeSetExtensions, encodeSetPassword, encodeTargetCmd,
} from './schema.js';
import { BRIDGE, CONNECTION, ERRORS, EXTENSIONS } from './messages.js';
import { sha256 } from './sha256.js';

export {
    AirfrogError, ExtensionFlag, Firmware, IdentifyFlag, IdentifyResult, Operation, PinLevel, Service, SetExtensionFlag,
    TargetInfo, WasmReason, WasmState,
};

/** The limit on IDENTIFY, which runs identification. */
const IDENTIFY_TIMEOUT_MS = 15000;

/** The limit on a RESET operation. Each of its times is at most 10 s. */
const RESET_TIMEOUT_MS = 35000;

/** The limit on each request of an extension install but EXT_FINISH. */
const EXT_WRITE_TIMEOUT_MS = 10000;

/** The limit on EXT_FINISH, which checks the extension image. */
const EXT_FINISH_TIMEOUT_MS = 30000;

const EMPTY = new Uint8Array(0);

/** How often a page checks whether the bridge window is closed. */
const WINDOW_POLL_MS = 500;

/** How long a page waits for the bridge window to close itself after close(). */
const BRIDGE_CLOSE_WAIT_MS = 2000;

/** The bridge window: a popup, so it doesn't replace the page's tab. */
const WINDOW_FEATURES = 'popup,width=560,height=600';

/** How long connectExtension() waits for the Airfrog UI's HELLO. */
const EXTENSION_CONNECT_MS = 10000;

/**
 * The link to Airfrog through the bridge window, which holds the WebSocket.
 * Messages after HELLO go to `onmessage(type, flags, payload)`, held until
 * it is set. `onclose(error)` is called once, when the connection closes.
 */
class BridgePipe {
    /**
     * @param {Window} win - the bridge window
     * @param {string} origin - Airfrog's origin
     * @returns {Promise<{pipe: BridgePipe, hello: Hello}>} once the window
     *          forwards HELLO
     */
    static start(win, origin) {
        return new Promise((resolve, reject) => {
            const pipe = new BridgePipe(win, origin);
            pipe.opening = { resolve, reject };
        });
    }

    constructor(win, origin) {
        this.win = win;
        this.origin = origin;
        this.closed = null;
        this.heard = false;
        this.opening = null;
        this.held = [];
        this._onmessage = null;
        this.onclose = null;
        this.listener = (event) => this.receive(event);
        this.leaving = () => this.close(undefined, undefined, true);
        window.addEventListener('message', this.listener);
        window.addEventListener('pagehide', this.leaving);
        this.poll = setInterval(() => {
            if (this.win.closed) {
                this.ended(new AirfrogError('CLOSED', null, BRIDGE.WINDOW_CLOSED(new URL(origin).host)));
            }
        }, WINDOW_POLL_MS);
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

    receive(event) {
        if (this.closed || event.source !== this.win || event.origin !== this.origin) {
            return;
        }
        const message = event.data?.[BRIDGE_KEY];
        if (!message) {
            return;
        }
        this.heard = true;
        if (message.close) {
            this.ended(errorFromBridge(message.close));
            return;
        }
        const { type, flags, payload } = message;
        if (!Number.isInteger(type) || !Number.isInteger(flags) || !(payload instanceof Uint8Array)) {
            this.close(undefined, new AirfrogError('INVALID_MESSAGE', 'malformed message from the bridge window'));
            return;
        }
        if (this.opening) {
            this.hello(type, payload);
        } else if (this._onmessage) {
            this._onmessage(type, flags, payload);
        } else {
            this.held.push([type, flags, payload]);
        }
    }

    hello(type, payload) {
        const hello = type === HELLO ? Hello.parse(payload) : null;
        if (!hello) {
            const what = type === HELLO ? `${payload.length}-byte HELLO` : `${hex(type)} before HELLO`;
            this.close(CLOSE_PROTOCOL_ERROR, new AirfrogError('INVALID_MESSAGE', what));
            return;
        }
        if (hello.revision < 1) {
            this.close(CLOSE_PROTOCOL_ERROR, new AirfrogError('INVALID_MESSAGE', `AWP revision ${hello.revision}`));
            return;
        }
        const { resolve } = this.opening;
        this.opening = null;
        resolve({ pipe: this, hello });
    }

    /**
     * @param {number} type
     * @param {Uint8Array} payload
     */
    send(type, payload) {
        if (this.closed) {
            throw this.closed;
        }
        this.win.postMessage({ [BRIDGE_KEY]: { type, payload } }, this.origin);
    }

    /**
     * Closes the connection and the bridge window.
     * @param {number} [code] - the close code the bridge window closes the
     *        WebSocket with
     * @param {AirfrogError} [error] - the reason recorded, CLOSED by default
     * @param {boolean} [leaving] - whether the page is being left
     */
    close(code, error, leaving = false) {
        if (this.closed) {
            return;
        }
        // A bridge window that has posted closes the WebSocket with code and
        // then closes itself. Closed from here first, it closes the WebSocket
        // with its own reason. A message posted while the page is being left
        // arrives without a source, so the bridge window ignores it.
        try {
            this.win.postMessage({ [BRIDGE_KEY]: { close: { closeCode: code } } }, this.origin);
            if (this.heard && !leaving) {
                setTimeout(() => this.win.close(), BRIDGE_CLOSE_WAIT_MS);
            } else {
                this.win.close();
            }
        } catch (e) {
            // The window is already closed
        }
        this.ended(error ?? new AirfrogError('CLOSED', null, CONNECTION.CLOSED));
    }

    ended(error) {
        if (this.closed) {
            return;
        }
        this.closed = error;
        clearInterval(this.poll);
        window.removeEventListener('message', this.listener);
        window.removeEventListener('pagehide', this.leaving);
        if (this.opening) {
            this.opening.reject(error);
            this.opening = null;
            return;
        }
        this.onclose?.(error);
    }
}


/**
 * The link from an extension UI's frame to Airfrog, through the Airfrog UI
 * that contains the frame. The Airfrog UI holds the connection. Messages
 * after HELLO go to `onmessage(type, flags, payload)`, held until it is set.
 * `onclose(error)` is called once, when the connection closes.
 */
class FramePipe {
    /**
     * Posts a connection request to the parent window.
     * @param {Window} parent
     * @returns {Promise<{pipe: FramePipe, hello: Hello, extension: string, limited: boolean}>}
     *          once the parent posts HELLO
     */
    static start(parent) {
        return new Promise((resolve, reject) => {
            const pipe = new FramePipe(parent);
            pipe.opening = { resolve, reject };
            // The Airfrog UI's origin is known only from its first message.
            // The request contains nothing else.
            parent.postMessage({ [EXTENSION_KEY]: { connect: true, id: pipe.id } }, '*');
        });
    }

    constructor(parent) {
        this.parent = parent;
        // Messages of this connection contain it, so another connection's
        // from the same frame are ignored.
        this.id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0'))
            .join('');
        this.origin = null;
        this.closed = null;
        this.opening = null;
        this.held = [];
        this._onmessage = null;
        this.onclose = null;
        this.listener = (event) => this.receive(event);
        window.addEventListener('message', this.listener);
        this.timer = setTimeout(() => this.ended(new AirfrogError('CONNECT', 'no answer from the parent window',
            EXTENSIONS.NOT_IN_AIRFROG_UI)), EXTENSION_CONNECT_MS);
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

    receive(event) {
        if (this.closed || event.source !== this.parent || (this.origin && event.origin !== this.origin)) {
            return;
        }
        const message = event.data?.[EXTENSION_KEY];
        if (!message || message.id !== this.id) {
            return;
        }
        if (message.close) {
            this.ended(errorFromBridge(message.close));
            return;
        }
        const { type, flags, payload } = message;
        if (!Number.isInteger(type) || !Number.isInteger(flags) || !(payload instanceof Uint8Array)) {
            this.close(undefined, new AirfrogError('INVALID_MESSAGE', 'malformed message from the Airfrog UI'));
            return;
        }
        if (this.opening) {
            this.hello(event.origin, message);
        } else if (this._onmessage) {
            this._onmessage(type, flags, payload);
        } else {
            this.held.push([type, flags, payload]);
        }
    }

    hello(origin, { type, payload, extension, limited }) {
        const hello = type === HELLO ? Hello.parse(payload) : null;
        if (!hello || hello.revision < 1 || typeof extension !== 'string' || typeof limited !== 'boolean') {
            this.close(undefined, new AirfrogError('INVALID_MESSAGE', `${hex(type)} as the Airfrog UI's HELLO`));
            return;
        }
        clearTimeout(this.timer);
        this.origin = origin;
        const { resolve } = this.opening;
        this.opening = null;
        this.postHeight();
        resolve({ pipe: this, hello, extension, limited });
    }

    /**
     * Posts the page's height to the Airfrog UI, and again each time it
     * changes, so the frame is as high as the page. It goes on after the
     * connection closes, when the page displays why.
     */
    postHeight() {
        if (typeof ResizeObserver !== 'function') {
            return;
        }
        const post = () => {
            const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
            this.parent.postMessage({ [EXTENSION_KEY]: { height, id: this.id } }, this.origin);
        };
        new ResizeObserver(post).observe(document.documentElement);
    }

    /**
     * @param {number} type
     * @param {Uint8Array} payload
     */
    send(type, payload) {
        if (this.closed) {
            throw this.closed;
        }
        this.parent.postMessage({ [EXTENSION_KEY]: { type, payload, id: this.id } }, this.origin);
    }

    /**
     * Closes the connection.
     * @param {number} [code] - the close code the Airfrog UI closes the
     *        WebSocket with
     * @param {AirfrogError} [error] - the reason recorded, CLOSED by default
     */
    close(code, error) {
        if (this.closed) {
            return;
        }
        if (this.origin) {
            this.parent.postMessage({ [EXTENSION_KEY]: { close: { closeCode: code }, id: this.id } }, this.origin);
        }
        this.ended(error ?? new AirfrogError('CLOSED', null, CONNECTION.CLOSED));
    }

    ended(error) {
        if (this.closed) {
            return;
        }
        this.closed = error;
        clearTimeout(this.timer);
        window.removeEventListener('message', this.listener);
        if (this.opening) {
            this.opening.reject(error);
            this.opening = null;
            return;
        }
        this.onclose?.(error);
    }
}

/**
 * A logged-in connection to Airfrog.
 *
 * Events:
 * - `target`: Airfrog sent TARGET. `event.detail` is the TargetInfo
 * - `close`: the connection closed. `event.detail` is the AirfrogError that
 *   closed it
 *
 * Requests are sent one at a time, in the order they are made.
 */
export class Airfrog extends EventTarget {
    #host;
    #hello;
    #pipe;
    #target = new TargetInfo();
    #targetSeen = false;
    #closed = null;
    #claims = 0;
    #pending = null;
    #queue = Promise.resolve();
    /** @type {Map<string, Extension>} */
    #extensions = new Map();
    /** In an extension UI, its extension's name */
    #own = null;
    /** Whether only what an extension UI may send is sent */
    #limited = false;

    /**
     * Use `connect()`, `connectBridge()` or `connectExtension()`.
     */
    constructor(host, hello, pipe, { extension = null, limited = false } = {}) {
        super();
        this.#host = host;
        this.#own = extension;
        this.#limited = limited;
        this.#hello = hello;
        this.#pipe = pipe;
        pipe.onclose = (error) => this.#ended(error);
        pipe.onmessage = (type, flags, payload) => this.#receive(type, flags, payload);
    }

    /**
     * Opens a WebSocket to Airfrog, logs in when Airfrog has a password and
     * reads the first TARGET. For Airfrog's home page: Airfrog accepts a
     * WebSocket only from a page it served.
     * @param {string} host - Airfrog's hostname, its hostname with .local or
     *        its IP address, with :port when it isn't 80
     * @param {string|null} [password] - ignored when Airfrog doesn't have
     *        one. Without one, where Airfrog has one, the connection closes
     *        with PASSWORD_REQUIRED
     * @returns {Promise<Airfrog>}
     */
    static async connect(host, password = null) {
        const socket = await AwpSocket.open(host, password);
        const airfrog = new Airfrog(host, socket.hello, socket);
        await airfrog.#firstTarget();
        return airfrog;
    }

    /**
     * Opens the bridge window: Airfrog's home page in a new window, which
     * logs in to Airfrog and relays messages between this page and Airfrog.
     * For every page other than Airfrog's home page. Call it from a click,
     * because a browser opens a window only then.
     *
     * Resolves once the user has logged in in the bridge window. Rejects with
     * CLOSED when the user closes that window first.
     * @param {string} host - as for `connect()`
     * @returns {Promise<Airfrog>}
     */
    static async connectBridge(host) {
        let url;
        try {
            url = new URL(`http://${host}`);
        } catch (e) {
            throw new AirfrogError('CONNECT', `invalid host ${host}`, CONNECTION.INVALID_ADDRESS(host));
        }
        const win = window.open(`http://${host}/#bridge=${location.origin}`, '_blank', WINDOW_FEATURES);
        if (!win) {
            throw new AirfrogError('CONNECT', 'window.open() returned null',
                BRIDGE.BLOCKED(url.host, siteName(location.origin)));
        }
        const origin = url.origin;
        const { pipe, hello } = await BridgePipe.start(win, origin);
        const airfrog = new Airfrog(host, hello, pipe);
        await airfrog.#firstTarget();
        return airfrog;
    }

    /**
     * Connects an extension UI to Airfrog through the Airfrog UI that
     * contains it in a frame. The Airfrog UI logs in and forwards only what
     * an extension UI may send: CLAIM, RELEASE, TARGET_CMD, IDENTIFY,
     * AIRFROG_CMD get commands and EXT_CMD to its own extension. Other
     * AIRFROG_CMD commands fail with NOT_PERMITTED without being sent.
     *
     * Fails with CONNECT in a page that isn't inside the Airfrog UI.
     * @returns {Promise<Airfrog>}
     */
    static async connectExtension() {
        if (typeof window === 'undefined' || window.parent === window) {
            throw new AirfrogError('CONNECT', 'not in a frame', EXTENSIONS.NOT_IN_AIRFROG_UI);
        }
        const { pipe, hello, extension, limited } = await FramePipe.start(window.parent);
        const airfrog = new Airfrog(null, hello, pipe, { extension, limited });
        await airfrog.#firstTarget();
        return airfrog;
    }

    /** @returns {string|null} the host the connection was opened with, null in an extension UI */
    getHost() {
        return this.#host;
    }

    /** @returns {number} HELLO's AWP revision */
    getRevision() {
        return this.#hello.revision;
    }

    /** @returns {number} HELLO's max_transfer: the most bulk data in one request or response */
    getMaxTransfer() {
        return this.#hello.maxTransfer;
    }

    /** @returns {TargetInfo} the last TARGET Airfrog sent */
    getTarget() {
        return this.#target;
    }

    /** @returns {boolean} whether the connection is closed */
    isClosed() {
        return this.#closed !== null;
    }

    /**
     * Closes the connection. Through the bridge, it also closes Airfrog's
     * window.
     */
    close() {
        this.#pipe.close();
    }

    /**
     * Waits for a TARGET that meets condition. The last TARGET counts.
     * @param {number} timeoutMs
     * @param {function(TargetInfo): boolean} condition
     * @returns {Promise<TargetInfo|null>} null when none arrived in time
     */
    waitForTarget(timeoutMs, condition) {
        if (condition(this.#target)) {
            return Promise.resolve(this.#target);
        }
        if (this.#closed) {
            return Promise.reject(this.#closed);
        }
        return new Promise((resolve, reject) => {
            const done = (finish, value) => {
                clearTimeout(timer);
                this.removeEventListener('target', onTarget);
                this.removeEventListener('close', onClose);
                finish(value);
            };
            const onTarget = (event) => {
                if (condition(event.detail)) {
                    done(resolve, event.detail);
                }
            };
            const onClose = (event) => done(reject, event.detail);
            const timer = setTimeout(() => done(resolve, null), timeoutMs);
            this.addEventListener('target', onTarget);
            this.addEventListener('close', onClose);
        });
    }

    /**
     * Adds one to this connection's claims. The first sends CLAIM and waits
     * up to timeoutMs for its response. Each claim is ended by one
     * `release()`.
     * @param {number} timeoutMs
     * @returns {Promise<void>}
     */
    claim(timeoutMs) {
        return this.#locked(async () => {
            if (this.#claims === 0) {
                await this.#request(CLAIM, new Uint8Array(0), timeoutMs);
            }
            this.#claims += 1;
        });
    }

    /**
     * Ends one claim. The last sends RELEASE without waiting for its
     * response.
     */
    release() {
        if (this.#claims === 0) {
            console.warn('Airfrog claim released more times than it was claimed');
            return;
        }
        this.#claims -= 1;
        if (this.#claims === 0) {
            this.#locked(() => this.#request(RELEASE, new Uint8Array(0), CONNECT_TIMEOUT_MS))
                .catch(e => console.debug(`RELEASE failed: ${e.message}`));
        }
    }

    /**
     * Sends TARGET_CMD to service's operation with fields. Where this
     * connection holds a claim and Airfrog has ended it, CLAIM and the
     * command are sent again, once.
     * @param {number} service
     * @param {number} operation
     * @param {Uint8Array} fields
     * @param {number} timeoutMs - limits the wait for the response
     * @returns {Promise<Uint8Array>} the response's fields
     */
    targetCmd(service, operation, fields, timeoutMs) {
        if (!Number.isInteger(service) || !Number.isInteger(operation)) {
            throw new TypeError('targetCmd() requires a service and an operation');
        }
        const request = encodeTargetCmd({ service, operation, fields });
        return this.#locked(async () => {
            try {
                return await this.#request(TARGET_CMD, request, timeoutMs);
            } catch (e) {
                if (e.code !== 'NOT_CLAIMED' || this.#claims === 0) {
                    throw e;
                }
                console.debug('Airfrog ended the claim, claiming again');
                await this.#request(CLAIM, new Uint8Array(0), timeoutMs);
                return await this.#request(TARGET_CMD, request, timeoutMs);
            }
        });
    }

    /**
     * Sends AIRFROG_CMD command with fields.
     * @param {number} command
     * @param {Uint8Array} fields
     * @param {number} timeoutMs - limits the wait for the response
     * @returns {Promise<Uint8Array>} the response's fields
     */
    airfrogCmd(command, fields, timeoutMs) {
        return this.#locked(() => this.#airfrogCmd(command, fields, timeoutMs));
    }

    #airfrogCmd(command, fields, timeoutMs) {
        if (this.#limited) {
            const name = Object.keys(Command).find(k => Command[k] === command);
            if (!name?.startsWith('GET_')) {
                const what = `AIRFROG_CMD ${name ?? hex(command)}`;
                return Promise.reject(new AirfrogError('NOT_PERMITTED', what, EXTENSIONS.NOT_PERMITTED(what)));
            }
        }
        return this.#request(AIRFROG_CMD, encodeAirfrogCmd({ command, fields }), timeoutMs);
    }

    /**
     * Resets the target into its bootloader with RESET's RESET_BOOT, which
     * uses the active pin map's reset and boot pins. It claims the target for
     * the operation.
     *
     * Airfrog sends TARGET with state IDENTIFYING before the response, and
     * TARGET again once identification completes. See `waitForTarget()`.
     * @returns {Promise<void>}
     */
    async resetBoot() {
        await this.#claimed(() => this.targetCmd(Service.RESET, Operation.RESET_RESET_BOOT, new Uint8Array(0),
            RESET_TIMEOUT_MS));
    }

    /**
     * Resets the target with RESET's RESET_PINS. It claims the target for the
     * operation. RESET_PINS is supported whatever Airfrog's pin map.
     *
     * Airfrog sends TARGET as for `resetBoot()`.
     * @param {{resetPin: string, resetLevel: number, resetMs: number,
     *          bootPin: string|null, bootLevel: number, bootDelayMs: number,
     *          bootHoldMs: number}} pins - a pin is a connector name, for
     *        example J1-4, or a name in the active pin map. bootPin is null
     *        for a reset without a boot pin
     * @returns {Promise<void>}
     */
    async resetPins(pins) {
        checkPin(pins.resetPin);
        if (pins.bootPin) {
            checkPin(pins.bootPin);
        }
        const fields = encodeResetPins({ ...pins, bootLevel: pins.bootLevel ?? PinLevel.LOW });
        await this.#claimed(() => this.targetCmd(Service.RESET, Operation.RESET_RESET_PINS, fields, RESET_TIMEOUT_MS));
    }

    /**
     * Makes Airfrog identify the target at once with IDENTIFY, checking each
     * of firmware over its own protocol, in order. It claims the target for
     * the request.
     *
     * Airfrog sends the new TARGET before the response.
     * @param {number} flags - IdentifyFlag's bits
     * @param {Array<number>} firmware - firmware IDs
     * @returns {Promise<Array<number>>} an IdentifyResult per firmware ID
     */
    async identify(flags, firmware) {
        const request = encodeIdentify({ flags, firmware });
        const response = await this.#claimed(
            () => this.#locked(() => this.#request(IDENTIFY, request, IDENTIFY_TIMEOUT_MS)));
        const f = decodeIdentifyResponse(response);
        if (!f || f.count !== firmware.length) {
            throw this.#fail(new AirfrogError('INVALID_MESSAGE', `${response.length}-byte IDENTIFY response`));
        }
        return f.result;
    }

    /**
     * Sets, changes or removes Airfrog's password with AIRFROG_CMD
     * SET_PASSWORD. The password doesn't leave this page: Airfrog receives K,
     * derived with a new random salt and HELLO's iterations.
     *
     * Airfrog then closes every connection, this one included, with
     * PASSWORD_CHANGED, which the `close` event reports.
     * @param {string} password - an empty password removes it
     * @returns {Promise<void>}
     */
    async setPassword(password) {
        let fields = encodeSetPassword({});
        if (password !== '') {
            const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
            fields = encodeSetPassword({ key: passwordKey(password, salt, this.#hello.iterations), salt });
        }
        await this.airfrogCmd(Command.SET_PASSWORD, fields, CONNECT_TIMEOUT_MS);
    }

    /**
     * Reads the installed extensions with AIRFROG_CMD GET_EXTENSIONS.
     * @returns {Promise<Array<{name: string, flags: number, wasmState: number, wasmReason: number,
     *          model: number, wamr: string}>>} in list order. flags are
     *          ExtensionFlag's, wasmState WasmState's and wasmReason
     *          WasmReason's. model and wamr are the extension image's, wamr
     *          as '2.4.5'
     */
    async getExtensions() {
        const response = await this.airfrogCmd(Command.GET_EXTENSIONS, EMPTY, CONNECT_TIMEOUT_MS);
        const f = decodeExtensions(response);
        if (!f) {
            throw this.#fail(new AirfrogError('INVALID_MESSAGE', `${response.length}-byte GET_EXTENSIONS response`));
        }
        return f.entries.map(({ flags, wasmState, wasmReason, header }) => ({
            name: header.name, flags, wasmState, wasmReason, model: header.model, wamr: header.wamr.join('.'),
        }));
    }

    /**
     * Installs an extension image with EXT_BEGIN, EXT_WRITE and EXT_FINISH.
     * An image whose extension is installed updates it.
     * @param {Uint8Array} image - the extension image, unchanged
     * @param {number} flags - ExtensionFlag's TAB and SIDE_LOADED
     * @returns {Promise<void>}
     */
    async installExtension(image, flags) {
        const max = this.getMaxTransfer();
        // One request sequence, so another request can't delay a write past
        // Airfrog's install timeout.
        await this.#locked(async () => {
            await this.#airfrogCmd(Command.EXT_BEGIN,
                encodeExtBegin({ size: image.length, sha256: sha256(image), flags }), EXT_WRITE_TIMEOUT_MS);
            for (let offset = 0; offset < image.length; offset += max) {
                await this.#airfrogCmd(Command.EXT_WRITE,
                    encodeOtaWrite({ offset, data: image.subarray(offset, offset + max) }), EXT_WRITE_TIMEOUT_MS);
            }
            await this.#airfrogCmd(Command.EXT_FINISH, EMPTY, EXT_FINISH_TIMEOUT_MS);
        });
    }

    /**
     * Removes an extension with AIRFROG_CMD EXT_REMOVE.
     * @param {string} name - the extension name
     * @returns {Promise<void>}
     */
    async removeExtension(name) {
        await this.airfrogCmd(Command.EXT_REMOVE, encodeExtensionName({ name }), CONNECT_TIMEOUT_MS);
    }

    /**
     * Sets the list order and the Tab checkboxes with AIRFROG_CMD
     * SET_EXTENSIONS. Every installed extension is listed once.
     * @param {Array<{name: string, flags: number}>} entries - in the new
     *        order. flags are SetExtensionFlag's
     * @returns {Promise<void>}
     */
    async setExtensions(entries) {
        await this.airfrogCmd(Command.SET_EXTENSIONS, encodeSetExtensions({ entries }), CONNECT_TIMEOUT_MS);
    }

    /**
     * Reads an installed extension's metadata with AIRFROG_CMD
     * GET_EXTENSION_METADATA. Metadata that isn't JSON fails with
     * INVALID_MESSAGE and the connection stays open.
     * @param {string} name - the extension name
     * @returns {Promise<object>} extension-meta.json, parsed
     */
    async getExtensionMetadata(name) {
        const response = await this.airfrogCmd(Command.GET_EXTENSION_METADATA, encodeExtensionName({ name }),
            CONNECT_TIMEOUT_MS);
        try {
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response));
        } catch (e) {
            throw new AirfrogError('INVALID_MESSAGE', `${response.length}-byte GET_EXTENSION_METADATA response, not JSON`);
        }
    }

    /**
     * The extension's WASM module, for EXT_CMD and EXT_NOTIFY. Each call with
     * the same name returns the same Extension.
     * @param {string} [name] - the extension name. In an extension UI it
     *        defaults to its own extension, the only one it reaches. Another
     *        name fails at the first command with OUT_OF_RANGE
     * @returns {Extension}
     */
    extension(name = this.#own) {
        if (typeof name !== 'string' || !name) {
            throw new TypeError('extension() requires the extension name');
        }
        let extension = this.#extensions.get(name);
        if (!extension) {
            extension = new Extension((data, timeoutMs) => this.#extCmd(name, data, timeoutMs));
            this.#extensions.set(name, extension);
        }
        return extension;
    }

    #extCmd(name, data, timeoutMs) {
        if (data.length > MAX_TRANSFER_MIN) {
            return Promise.reject(new AirfrogError('TRANSFER_TOO_LARGE', data.length,
                ERRORS.TRANSFER_TOO_LARGE(data.length, MAX_TRANSFER_MIN)));
        }
        const request = encodeExtCmd({ name, data });
        return this.#locked(() => this.#request(EXT_CMD, request, timeoutMs)).catch((e) => {
            if (e.code === 'OUT_OF_RANGE') {
                throw new AirfrogError(e.code, name, EXTENSIONS.NOT_INSTALLED(name));
            }
            throw e.code === 'NOT_OFFERED' || e.code === 'NOT_RUNNING' ? new AirfrogError(e.code, name) : e;
        });
    }

    async #claimed(operation) {
        await this.claim(CONNECT_TIMEOUT_MS);
        try {
            return await operation();
        } finally {
            this.release();
        }
    }

    /** Runs fn once every earlier request has finished. */
    #locked(fn) {
        const result = this.#queue.then(() => fn());
        this.#queue = result.catch(() => {});
        return result;
    }

    /** Sends a request and resolves to its response's payload. */
    #request(type, payload, timeoutMs) {
        if (this.#closed) {
            return Promise.reject(this.#closed);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.#fail(new AirfrogError('TIMEOUT')), timeoutMs);
            this.#pending = { type, resolve, reject, timer };
            try {
                this.#pipe.send(type, payload);
            } catch (e) {
                this.#fail(e);
            }
        });
    }

    #finish(settle, value) {
        const pending = this.#pending;
        this.#pending = null;
        clearTimeout(pending.timer);
        pending[settle](value);
    }

    #firstTarget() {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#fail(new AirfrogError('TIMEOUT'));
            }, CONNECT_TIMEOUT_MS);
            const onTarget = () => { done(); resolve(); };
            const onClose = (event) => { done(); reject(event.detail); };
            const done = () => {
                clearTimeout(timer);
                this.removeEventListener('target', onTarget);
                this.removeEventListener('close', onClose);
            };
            if (this.#closed) {
                done();
                reject(this.#closed);
                return;
            }
            if (this.#targetSeen) {
                done();
                resolve();
                return;
            }
            this.addEventListener('target', onTarget);
            this.addEventListener('close', onClose);
        });
    }

    #receive(type, flags, payload) {
        const pending = this.#pending;
        if (!(flags & HEADER_RESPONSE)) {
            if (type === TARGET) {
                this.#setTarget(payload);
            } else if (type === EXT_NOTIFY) {
                this.#notify(payload);
            } else if (isKnown(type)) {
                this.#fail(new AirfrogError('INVALID_MESSAGE', `unrequested message type ${hex(type)}`));
            }
        } else if (pending && type === pending.type) {
            if (type === TARGET && !this.#setTarget(payload)) {
                return;
            }
            this.#finish('resolve', payload);
        } else if (pending && type === ERROR) {
            const e = errorFromPayload(payload);
            if (e) {
                this.#finish('reject', e);
            } else {
                this.#fail(new AirfrogError('INVALID_MESSAGE', `${payload.length}-byte ERROR`));
            }
        } else if (isKnown(type)) {
            const what = pending ? `${hex(type)} in response to ${hex(pending.type)}` : `unrequested response ${hex(type)}`;
            this.#fail(new AirfrogError('INVALID_MESSAGE', what));
        }
    }

    #notify(payload) {
        const f = decodeExtCmd(payload);
        if (!f) {
            this.#fail(new AirfrogError('INVALID_MESSAGE', `${payload.length}-byte EXT_NOTIFY`));
            return;
        }
        this.#extensions.get(f.name)?.dispatchEvent(new CustomEvent('notify', { detail: f.data.slice() }));
    }

    /** @returns {boolean} whether payload is a valid TARGET */
    #setTarget(payload) {
        const target = TargetInfo.parse(payload);
        if (!target) {
            this.#fail(new AirfrogError('INVALID_MESSAGE', `${payload.length}-byte TARGET`));
            return false;
        }
        this.#target = target;
        this.#targetSeen = true;
        this.dispatchEvent(new CustomEvent('target', { detail: target }));
        return true;
    }

    /**
     * Closes the connection after a failure. INVALID_MESSAGE closes it with
     * 4000.
     * @returns {AirfrogError} error
     */
    #fail(error) {
        console.debug(`Closing the connection to Airfrog: ${error.code} ${error.detail ?? ''}`);
        this.#pipe.close(error.code === 'INVALID_MESSAGE' ? CLOSE_PROTOCOL_ERROR : undefined, error);
        return error;
    }

    #ended(error) {
        if (this.#closed) {
            return;
        }
        this.#closed = error;
        if (this.#pending) {
            this.#finish('reject', error);
        }
        this.dispatchEvent(new CustomEvent('close', { detail: error }));
    }
}

/**
 * An extension's WASM module, from `Airfrog.extension()`.
 *
 * Events:
 * - `notify`: the module sent EXT_NOTIFY. `event.detail` is its data, a
 *   Uint8Array
 */
export class Extension extends EventTarget {
    #send;

    /**
     * Use `Airfrog.extension()`.
     */
    constructor(send) {
        super();
        this.#send = send;
    }

    /**
     * Sends EXT_CMD with data and waits for the module's reply. Fails with
     * an AirfrogError whose code is the ERROR code, for example NOT_RUNNING,
     * and with TRANSFER_TOO_LARGE for data over schema.js's MAX_TRANSFER_MIN.
     * @param {Uint8Array} data - 0 to MAX_TRANSFER_MIN bytes
     * @param {number} timeoutMs - limits the wait for the reply
     * @returns {Promise<Uint8Array>} the reply, empty if the module didn't set
     *          one
     */
    command(data, timeoutMs) {
        return this.#send(data, timeoutMs);
    }
}

/**
 * Throws PIN_NAME for a pin's name longer than a pin field.
 * @param {string} name
 */
function checkPin(name) {
    if (new TextEncoder().encode(name).length > PIN_NAME_LEN) {
        throw new AirfrogError('PIN_NAME', name);
    }
}
