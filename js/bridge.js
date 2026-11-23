// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The bridge window: Airfrog's home page opened by a website's page with
// #bridge=ORIGIN (Airfrog.connectBridge() in airfrog.js). This window logs in
// to Airfrog, so the password doesn't reach the page, connects the website
// once it is in Airfrog's authorised websites, and relays AWP messages
// without counter and hmac between the page and Airfrog. The window forwards
// only CLAIM, RELEASE, TARGET_CMD, IDENTIFY and AIRFROG_CMD get commands. See
// "The bridge" in airfrog-v2/docs/ac3-design.md.

import {
    AIRFROG_CMD, AirfrogError, AwpSocket, BRIDGE_KEY, CLAIM, CONNECT_TIMEOUT_MS, ERROR, HEADER_RESPONSE, HELLO,
    IDENTIFY, RELEASE, TARGET_CMD, errorFromPayload, errorToBridge, hex, siteName, typeName,
} from './awp.js';
import { BRIDGE, CONNECTION, CONTROLS } from './messages.js';
import {
    CLAIM_MS, Command, ERROR_EXISTS, decodeAirfrogCmd, decodeAuthorisedWebsites, encodeAirfrogCmd,
    encodeAuthorisedWebsite,
} from './schema.js';
import { RECOVERY } from './urls.js';

/**
 * How often the window reads the authorised websites again while connected.
 * A browser may run a hidden window's timer later.
 */
const CHECK_MS = 10 * 60 * 1000;

/** How often this window checks whether the page's window is closed. */
const OPENER_POLL_MS = 500;

/** The messages a page may send, other than AIRFROG_CMD. */
const FORWARDED = new Set([CLAIM, RELEASE, TARGET_CMD, IDENTIFY]);

/**
 * The website in location's hash, #bridge=ORIGIN.
 * @param {string} hash
 * @returns {string|null} null without a website's origin
 */
function bridgeOrigin(hash) {
    const match = /^#bridge=(.+)$/.exec(hash);
    if (!match) {
        return null;
    }
    try {
        const origin = decodeURIComponent(match[1]);
        const url = new URL(origin);
        return ['http:', 'https:'].includes(url.protocol) && url.origin === origin ? origin : null;
    } catch (e) {
        return null;
    }
}

/**
 * Why a message from the page isn't forwarded.
 * @param {*} message - the bridge message's { type, payload }
 * @param {string} site
 * @returns {string|null} the reason, null for a message to forward
 */
function refusal({ type, payload }, site) {
    if (!Number.isInteger(type) || type < 0 || type > 0xffff || !(payload instanceof Uint8Array)) {
        return BRIDGE.INVALID_FROM_SITE(site);
    }
    if (FORWARDED.has(type)) {
        return null;
    }
    if (type === AIRFROG_CMD) {
        const cmd = decodeAirfrogCmd(payload);
        if (!cmd) {
            return BRIDGE.INVALID_FROM_SITE(site);
        }
        const name = Object.keys(Command).find(k => Command[k] === cmd.command);
        return name?.startsWith('GET_')
            ? null : BRIDGE.UNSUPPORTED_FROM_SITE(`AIRFROG_CMD ${name ?? hex(cmd.command)}`, site);
    }
    return BRIDGE.UNSUPPORTED_FROM_SITE(typeName(type), site);
}

/**
 * The reason line for an error that ended or prevented the connection.
 * @param {AirfrogError} e
 * @param {string} host
 * @param {string} site
 * @returns {string}
 */
function reasonFor(e, host, site) {
    switch (e.code) {
        case 'PASSWORD_CHANGED': return BRIDGE.PASSWORD_CHANGED(host);
        case 'NETWORK_SETTINGS_CHANGED': return BRIDGE.NETWORK_SETTINGS_CHANGED(host);
        case 'PROTOCOL_ERROR': return BRIDGE.PROTOCOL_ERROR(host, site);
        case 'BAD_COUNTER_OR_HMAC': return BRIDGE.BAD_COUNTER_OR_HMAC(host);
        case 'TOO_MANY_CONNECTIONS': return BRIDGE.TOO_MANY_CONNECTIONS(host);
        case 'LOGIN_TIMEOUT': return BRIDGE.LOGIN_TIMEOUT(host);
        case 'PROOF_MISMATCH': return BRIDGE.PROOF_MISMATCH(host);
        case 'INVALID_MESSAGE': return BRIDGE.INVALID_FROM_AIRFROG(host);
        case 'CONNECT':
        case 'IO':
        case 'TIMEOUT':
            return BRIDGE.NOT_RESPONDING(host);
        case 'CLOSED':
            if (e.detail === null) {
                return BRIDGE.NOT_RESPONDING(host);
            }
            return e.detail === 1001 ? BRIDGE.RESTARTED(host) : BRIDGE.UNKNOWN_CLOSE(host, e.detail);
        default:
            return e.message;
    }
}

/**
 * The connection's traffic. AWP allows one request at a time, so the
 * window's own AIRFROG_CMDs and the website's requests take turns. Messages
 * for the website are held until it is connected. The website's claim is
 * followed from its requests' responses.
 */
class Relay {
    /** @param {AwpSocket} socket */
    constructor(socket) {
        this.socket = socket;
        /** Posts a message to the website, null until it is connected */
        this.post = null;
        this.held = [];
        /** The website's request waiting for its response, by type */
        this.request = null;
        /** The window's command: { payload, resolve, reject, timer, sent } */
        this.own = null;
        /** The website's messages held while the window's command waits */
        this.queued = [];
        /** Whether the website holds the claim, as its last CLAIM, RELEASE or NOT_CLAIMED set it */
        this.holding = false;
        /** When the website's claim ends without another request */
        this.claimUntil = 0;
        this.onResponse = null;
        /** Stops released()'s wait */
        this.stop = () => {};
        socket.onmessage = (type, flags, payload) => this.#receive(type, flags, payload);
    }

    /** Connects the website: posts HELLO, then the messages held for it. */
    connect(post) {
        this.post = post;
        post({ type: HELLO, flags: 0, payload: this.socket.helloPayload });
        this.held.splice(0).forEach(post);
    }

    /**
     * Whether the website holds the claim. Airfrog keeps it while a request
     * runs and for CLAIM_MS after the response.
     */
    claimed() {
        return this.holding && ([CLAIM, TARGET_CMD, IDENTIFY].includes(this.request) || this.claimUntil > Date.now());
    }

    /** Sends the website's request, after the window's command if one waits. */
    send(type, payload) {
        if (this.own) {
            this.queued.push([type, payload]);
            return;
        }
        this.request = type;
        this.socket.send(type, payload);
    }

    /**
     * Sends the window's own AIRFROG_CMD once the website's request has its
     * response.
     * @returns {Promise<Uint8Array>} the response's fields
     */
    command(command, fields = new Uint8Array(0)) {
        return new Promise((resolve, reject) => {
            this.own = { payload: encodeAirfrogCmd({ command, fields }), resolve, reject, timer: null, sent: false };
            this.#sendOwn();
        });
    }

    #sendOwn() {
        const own = this.own;
        if (!own || own.sent || this.request !== null) {
            return;
        }
        own.sent = true;
        own.timer = setTimeout(() => this.#settleOwn('reject', new AirfrogError('TIMEOUT')), CONNECT_TIMEOUT_MS);
        try {
            this.socket.send(AIRFROG_CMD, own.payload);
        } catch (e) {
            this.#settleOwn('reject', e);
        }
    }

    #settleOwn(settle, value) {
        const own = this.own;
        this.own = null;
        clearTimeout(own.timer);
        own[settle](value);
        for (const [type, payload] of this.queued.splice(0)) {
            try {
                this.send(type, payload);
            } catch (e) {
                // The connection closed, and onclose has reported why
            }
        }
    }

    /** Fails the window's command once the connection has closed. */
    closed(error) {
        if (this.own) {
            this.#settleOwn('reject', error);
        }
    }

    #receive(type, flags, payload) {
        if (!(flags & HEADER_RESPONSE)) {
            this.#toWebsite({ type, flags, payload });
        } else if (this.own?.sent) {
            if (type === AIRFROG_CMD) {
                this.#settleOwn('resolve', payload);
            } else {
                const error = type === ERROR ? errorFromPayload(payload) : null;
                this.#settleOwn('reject', error ?? new AirfrogError('INVALID_MESSAGE'));
            }
        } else {
            this.#claimAfter(this.request, type, payload);
            this.request = null;
            this.#toWebsite({ type, flags, payload });
            this.onResponse?.();
            this.#sendOwn();
        }
    }

    /** Follows the website's claim from the response to its request. */
    #claimAfter(request, type, payload) {
        const error = type === ERROR ? errorFromPayload(payload) : null;
        if (error?.code === 'NOT_CLAIMED' || (request === RELEASE && !error)) {
            this.holding = false;
        } else if (request === CLAIM && !error) {
            this.holding = true;
        }
        if ([CLAIM, TARGET_CMD, IDENTIFY].includes(request)) {
            this.claimUntil = Date.now() + CLAIM_MS;
        }
    }

    #toWebsite(message) {
        if (this.post) {
            this.post(message);
        } else {
            this.held.push(message);
        }
    }

    /**
     * Resolves once the website doesn't hold the claim, or after ms.
     * @param {number} ms
     */
    released(ms) {
        return new Promise((resolve) => {
            const deadline = Date.now() + ms;
            let timer = null;
            const check = () => {
                clearTimeout(timer);
                if (!this.claimed() || Date.now() >= deadline || this.socket.closed) {
                    this.onResponse = null;
                    resolve();
                    return;
                }
                // A request running is followed by its response, which checks again.
                const at = this.request === null ? Math.min(this.claimUntil, deadline) : deadline;
                timer = setTimeout(check, at - Date.now() + 1);
            };
            this.onResponse = check;
            this.stop = () => clearTimeout(timer);
            check();
        });
    }
}

/**
 * The window's card: its lines, the Log in form and its buttons.
 */
class BridgeView {
    constructor(container) {
        const el = (tag, attrs = {}, text = '') => {
            const e = document.createElement(tag);
            Object.assign(e, attrs);
            if (text) {
                e.textContent = text;
            }
            return e;
        };
        this.el = el;
        this.root = el('div', { className: 'stack' });
        this.lines = el('div', { id: 'bridge-status', className: 'stack' });
        this.lines.setAttribute('role', 'status');

        this.form = el('form', { id: 'bridge-login', className: 'stack' });
        const label = el('label', {});
        const labelText = el('span', {}, CONNECTION.PASSWORD);
        this.password = el('input', { id: 'bridge-password', type: 'password', autocomplete: 'current-password' });
        label.append(labelText, this.password);
        this.loginButton = el('button', { type: 'submit', disabled: true }, CONNECTION.LOG_IN);
        this.password.addEventListener('input', () => { this.loginButton.disabled = !this.password.value; });
        const forgotten = el('p', { className: 'note' }, BRIDGE.FORGOTTEN);
        const recovery = el('a', { href: RECOVERY, target: '_blank', rel: 'noopener' },
            RECOVERY.replace(/^https:\/\//, ''));
        forgotten.append(' ', recovery);
        const loginRow = el('div', { className: 'row' });
        loginRow.append(this.loginButton);
        this.form.append(label, loginRow, forgotten);
        this.form.hidden = true;

        this.button = el('button', { type: 'button', id: 'bridge-button' });
        this.cancel = el('button', { type: 'button', id: 'bridge-cancel', className: 'cancel' }, CONTROLS.CANCEL);
        this.buttonRow = el('div', { className: 'row' });
        this.buttonRow.append(this.button, this.cancel);
        this.buttonRow.hidden = true;
        this.cancel.hidden = true;
        this.onButton = null;
        this.onCancel = null;
        this.button.addEventListener('click', () => this.onButton?.());
        this.cancel.addEventListener('click', () => this.onCancel?.());

        this.root.append(this.lines, this.form, this.buttonRow);
        container.append(this.root);
    }

    /**
     * Displays lines, each [text, kind]: kind is '' for the text colour, or
     * 'msg', 'msg ok' or 'msg bad' for a message line.
     */
    show(...lines) {
        this.lines.replaceChildren(...lines.filter(([text]) => text)
            .map(([text, kind]) => this.el('div', kind ? { className: kind } : {}, text)));
    }

    /** One button below the lines, or none for a null label. */
    action(label, onClick = null) {
        this.form.hidden = true;
        this.buttonRow.hidden = label === null;
        this.button.textContent = label ?? '';
        this.button.className = '';
        this.cancel.hidden = true;
        this.onButton = onClick;
    }

    /**
     * Displays Allow and Cancel.
     * @returns {Promise<boolean>} whether Allow was clicked
     */
    askAllow(host, site) {
        this.show([BRIDGE.ALLOW_CONNECT(site, host), '']);
        return new Promise((resolve) => {
            this.action(BRIDGE.ALLOW, () => resolve(true));
            this.button.className = 'primary';
            this.cancel.hidden = false;
            this.onCancel = () => resolve(false);
            this.cancel.focus?.();
        });
    }

    progress(text) {
        this.show([text, 'msg']);
        this.action(null);
    }

    /**
     * @param {string} host
     * @param {string} site
     * @param {string|null} failure - why the last login failed
     * @returns {Promise<string>} the password entered
     */
    askPassword(host, site, failure) {
        this.show([BRIDGE.ENTER_PASSWORD(host, site), ''], [failure, 'msg bad']);
        this.action(null);
        this.form.hidden = false;
        this.password.value = '';
        this.loginButton.disabled = true;
        this.password.focus?.();
        return new Promise(resolve => {
            const submit = (event) => {
                event.preventDefault?.();
                this.form.removeEventListener('submit', submit);
                this.progress(CONNECTION.LOGGING_IN);
                resolve(this.password.value);
                this.password.value = '';
            };
            this.form.addEventListener('submit', submit);
        });
    }
}

/**
 * Whether the website is in the authorised websites.
 * @param {Relay} relay
 * @param {string} origin
 * @returns {Promise<boolean>}
 */
async function listed(relay, origin) {
    const list = decodeAuthorisedWebsites(await relay.command(Command.GET_AUTHORISED_WEBSITES));
    if (!list) {
        throw new AirfrogError('INVALID_MESSAGE');
    }
    return list.website.includes(origin);
}

/**
 * Runs this window as the bridge for the page that opened it. Call it when
 * the URL's hash starts #bridge=. Without a website's origin in the hash the
 * window loads Airfrog's home page instead.
 * @param {HTMLElement} container - where the bridge displays its state, the
 *        login and its buttons
 * @returns {Promise<void>} once the website is connected, or the connection
 *          has failed or been cancelled
 */
export async function startBridge(container) {
    const origin = bridgeOrigin(location.hash);
    if (!origin) {
        location.replace(`http://${location.host}/`);
        return;
    }
    const host = location.host;
    const site = siteName(origin);
    document.title = BRIDGE.TITLE(host, site);
    const view = new BridgeView(container);
    const closeWindow = () => window.close();
    const opener = window.opener;
    if (!opener) {
        view.show([BRIDGE.OPENED_DIRECTLY, 'msg bad'], [BRIDGE.CONNECT_FROM(site), '']);
        // A browser closes a window from a script only when a website opened
        // it or its history has a single entry. A page restored by Back
        // checks again.
        const offerClose = () => view.action(history.length === 1 ? BRIDGE.CLOSE : null, closeWindow);
        offerClose();
        window.addEventListener('pageshow', (event) => event.persisted && offerClose());
        return;
    }

    const post = (message) => {
        try {
            opener.postMessage({ [BRIDGE_KEY]: message }, origin);
        } catch (e) {
            // The page's window is closed
        }
    };
    /** The connection ended or wasn't made. Posts the close to the page and displays the reason. */
    const ended = (heading, reason, error) => {
        view.show([heading, 'msg bad'], [reason, ''], [BRIDGE.RECONNECT_FROM(site), '']);
        view.action(BRIDGE.CLOSE, closeWindow);
        post({ close: errorToBridge(new AirfrogError(error.code, error.detail, reason)) });
    };

    view.progress(CONNECTION.CONNECTING);
    let socket = null;
    let password = null;
    while (!socket) {
        try {
            socket = await AwpSocket.open(host, password);
        } catch (e) {
            if (['PASSWORD_REQUIRED', 'LOGIN_FAILED', 'LOGIN_BLOCKED'].includes(e.code)) {
                password = await view.askPassword(host, site, e.code === 'PASSWORD_REQUIRED' ? null : e.message);
                continue;
            }
            ended(BRIDGE.NOT_CONNECTED(site, host), reasonFor(e, host, site), e);
            return;
        }
    }

    const relay = new Relay(socket);
    let connected = false;
    // Why this window closed the connection, null until it does
    let ending = null;
    let checkTimer = null;
    const close = (reason, code) => {
        ending = reason ?? CONNECTION.CLOSED;
        socket.close(code, new AirfrogError('CLOSED', null, ending));
    };
    const closeAndLeave = (reason, code) => {
        close(reason, code);
        window.close();
    };
    /**
     * The reason line for a failure of the window's own command, or null
     * once the connection has closed and onclose has displayed why.
     */
    const failure = (e, reason) => {
        if (socket.closed) {
            return null;
        }
        if (e.code === 'TIMEOUT') {
            return BRIDGE.NOT_RESPONDING(host);
        }
        return e.code === 'INVALID_MESSAGE' ? BRIDGE.INVALID_FROM_AIRFROG(host) : reason;
    };

    const fromPage = (event) => {
        if (event.source !== opener || event.origin !== origin) {
            return;
        }
        const message = event.data?.[BRIDGE_KEY];
        if (!message) {
            return;
        }
        if (message.close) {
            closeAndLeave(null, message.close.closeCode);
            return;
        }
        const refused = refusal(message, site);
        if (refused) {
            close(refused);
            return;
        }
        try {
            relay.send(message.type, message.payload);
        } catch (e) {
            // The connection closed, and onclose has reported why
        }
    };
    const leaving = () => close(BRIDGE.WINDOW_CLOSED(host));
    const openerPoll = setInterval(() => {
        if (opener.closed) {
            closeAndLeave(null);
        }
    }, OPENER_POLL_MS);

    socket.onclose = (error) => {
        clearInterval(openerPoll);
        clearTimeout(checkTimer);
        relay.stop();
        relay.closed(error);
        window.removeEventListener('message', fromPage);
        window.removeEventListener('pagehide', leaving);
        ended(connected ? BRIDGE.DISCONNECTED(site, host) : BRIDGE.NOT_CONNECTED(site, host),
            ending ?? reasonFor(error, host, site), error);
    };
    window.addEventListener('pagehide', leaving);

    // The website connects once it is listed, or once Allow adds it
    try {
        if (!await listed(relay, origin)) {
            if (!await view.askAllow(host, site)) {
                closeAndLeave(BRIDGE.WINDOW_CLOSED(host));
                return;
            }
            view.progress(CONNECTION.CONNECTING);
            try {
                await relay.command(Command.ADD_AUTHORISED_WEBSITE, encodeAuthorisedWebsite({ website: origin }));
            } catch (e) {
                // Another window added it first
                if (!(e.code === 'CODE' && e.detail === ERROR_EXISTS)) {
                    const reason = failure(e, e.code === 'NO_SPACE'
                        ? BRIDGE.TOO_MANY_WEBSITES(host) : BRIDGE.ADD_FAILED(site, host));
                    if (reason) {
                        close(reason);
                    }
                    return;
                }
            }
        }
    } catch (e) {
        const reason = failure(e, BRIDGE.READ_FAILED(host));
        if (reason) {
            close(reason);
        }
        return;
    }

    /**
     * Reads the list again. Without the website listed, or when the read
     * fails, the window disconnects once the website's claim is released, or
     * at the next check. After a failed read it reads again first.
     */
    const check = async () => {
        // true: listed, false: not listed, null: the read failed
        let ok;
        try {
            ok = await listed(relay, origin);
        } catch (e) {
            if (socket.closed) {
                return;
            }
            if (e.code === 'TIMEOUT' || e.code === 'INVALID_MESSAGE') {
                close(failure(e, ''));
                return;
            }
            ok = null;
        }
        if (ok) {
            checkTimer = setTimeout(check, CHECK_MS);
            return;
        }
        if (relay.claimed()) {
            await relay.released(CHECK_MS);
            if (socket.closed) {
                return;
            }
            if (ok === null) {
                try {
                    ok = await listed(relay, origin);
                } catch (e) {
                    if (!socket.closed) {
                        close(failure(e, BRIDGE.READ_FAILED(host)));
                    }
                    return;
                }
                if (ok) {
                    checkTimer = setTimeout(check, CHECK_MS);
                    return;
                }
            }
        }
        close(ok === null ? BRIDGE.READ_FAILED(host) : BRIDGE.REVOKED(site));
    };

    connected = true;
    window.addEventListener('message', fromPage);
    view.show([BRIDGE.CONNECTED(site, host), 'msg ok'], [BRIDGE.CLOSING_DISCONNECTS(site, host), '']);
    view.action(BRIDGE.DISCONNECT, () => closeAndLeave(BRIDGE.WINDOW_DISCONNECTED(host)));
    relay.connect(post);
    checkTimer = setTimeout(check, CHECK_MS);
}
