// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The page's connection to Airfrog. It logs in with the password the user
// enters, keeps the password in memory and connects again whenever the
// connection closes.

import { Airfrog } from '../airfrog.js';
import { CLOSED, CONNECTION, RECONNECT, RECONNECTING, SETTINGS } from '../messages.js';
import { CLOSE_GOING_AWAY } from '../schema.js';

/** How long after a failure or a close the next connection is opened. */
const RETRY_MS = 2000;

/**
 * Failures that connecting again doesn't change: Airfrog's iterations are
 * too low, or a checkHello() returned an error.
 */
const FINAL = new Set(['ITERATIONS_TOO_LOW', 'OTHER_FIRMWARE']);

/** text as a sentence, ending with a full stop. */
function sentence(text) {
    return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * Events:
 * - `status`: detail `{ state, message, expected, via }`. state is
 *   `connecting`, `password` (the user must enter Airfrog's password),
 *   `connected`, `waiting` (for the next attempt) or `failed` (no further
 *   attempt). message is for display, or null. expected is true while the
 *   page reconnects after a change it made, and in the `password` state when
 *   message reports a change it made. via is the Interface HELLO
 *   reported in the `password` state, otherwise null
 * - `connected`: detail is the new Airfrog connection
 * - `target`: detail is the TargetInfo
 */
export class Session extends EventTarget {
    #host;
    #connect;
    #reset;
    #retryMs;
    #password = null;
    #hasPassword = false;
    #airfrog = null;
    #expected = null;
    #timer = null;
    #attempting = false;
    // The login card's message when the next connection requires the
    // password: {message, expected}
    #loginNote = null;
    // HELLO's interface, from the last PASSWORD_REQUIRED
    #via = null;
    // Whether the next connection is the reconnect after an install, which
    // sends OTA_CONFIRM, and that connection while it is open
    #confirming = false;
    #unchecked = null;
    // The message while reconnecting after a change this page made, until a
    // connection opens.
    #expecting = null;

    /**
     * @param {string} host - Airfrog's host, location.host
     * @param {{connect?: Function, resetPassword?: Function, retryMs?: number}} [options] -
     *        connect is Airfrog.connect and resetPassword
     *        Airfrog.resetPassword by default. connect(host, password,
     *        { confirming }) has confirming true for the reconnect after an
     *        install, which sends OTA_CONFIRM
     */
    constructor(host, { connect = (h, p) => Airfrog.connect(h, p),
        resetPassword = (h, p) => Airfrog.resetPassword(h, p), retryMs = RETRY_MS } = {}) {
        super();
        this.#host = host;
        this.#connect = connect;
        this.#reset = resetPassword;
        this.#retryMs = retryMs;
    }

    /** @returns {import('../../js/airfrog.js').Airfrog|null} the open connection */
    get airfrog() {
        return this.#airfrog;
    }

    get host() {
        return this.#host;
    }

    /** Whether Airfrog has a password, from the last login. */
    get hasPassword() {
        return this.#hasPassword;
    }

    start() {
        this.#attempt(null);
    }

    /** Connects with password, which the password form provides. */
    login(password) {
        this.#password = password;
        this.#attempt(CONNECTION.LOGGING_IN);
    }

    /**
     * Replaces Airfrog's password without logging in. The login card is then
     * displayed for the new password. Airfrog allows it only over the access
     * point started with the recovery button.
     * @param {string} password - the new password
     */
    async resetPassword(password) {
        this.#status('connecting', SETTINGS.SAVING);
        try {
            await this.#reset(this.#host, password);
        } catch (e) {
            this.#status('password', e.message, false, this.#via);
            return;
        }
        this.#password = null;
        this.#status('password', CONNECTION.PASSWORD_SAVED, true, this.#via);
    }

    /**
     * Records that a request about to be sent closes the connection, so the
     * close is reported with message rather than as a failure.
     * @param {{message: string, password?: string|null, loginNote?: string, confirm?: boolean}} expected -
     *        password is Airfrog's new password, null for none, after
     *        SET_PASSWORD. loginNote is displayed on the login card when
     *        the next connection requires the password. confirm is true
     *        after OTA_FINISH: the next connection opens with connect()'s
     *        confirming, until endConfirming()
     */
    expectClose(expected) {
        this.#expected = expected;
    }

    /** Forgets an expectClose() whose request failed. */
    cancelExpected() {
        this.#expected = null;
    }

    /**
     * Ends the reconnect after an install: a connection opened with
     * confirming is closed, so the next is opened without it.
     */
    endConfirming() {
        this.#confirming = false;
        const unchecked = this.#unchecked;
        this.#unchecked = null;
        if (unchecked && unchecked === this.#airfrog && !unchecked.isClosed()) {
            this.expectClose({ message: RECONNECTING });
            unchecked.close();
        }
    }

    /**
     * @param {number} timeoutMs
     * @returns {Promise<import('../../js/airfrog.js').Airfrog|null>} the next
     *          connection, or null when none opens in time
     */
    nextConnection(timeoutMs) {
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.removeEventListener('connected', onConnected);
                resolve(null);
            }, timeoutMs);
            const onConnected = (event) => {
                clearTimeout(timer);
                this.removeEventListener('connected', onConnected);
                resolve(event.detail);
            };
            this.addEventListener('connected', onConnected);
        });
    }

    /** Stops connecting and closes the connection. */
    stop() {
        clearTimeout(this.#timer);
        this.#timer = null;
        this.#attempting = true;
        this.#airfrog?.close();
    }

    #status(state, message, expected = false, via = null) {
        this.dispatchEvent(new CustomEvent('status', { detail: { state, message, expected, via } }));
    }

    async #attempt(message, expected = false) {
        if (this.#attempting) {
            return;
        }
        this.#attempting = true;
        clearTimeout(this.#timer);
        this.#timer = null;
        this.#status('connecting', message, expected);
        let airfrog;
        try {
            airfrog = await this.#connect(this.#host, this.#password, { confirming: this.#confirming });
        } catch (e) {
            this.#attempting = false;
            this.#failed(e);
            return;
        }
        this.#attempting = false;
        this.#expecting = null;
        this.#unchecked = this.#confirming ? airfrog : null;
        this.#confirming = false;
        this.#hasPassword = this.#password !== null;
        this.#airfrog = airfrog;
        airfrog.addEventListener('target', (event) => {
            this.dispatchEvent(new CustomEvent('target', { detail: event.detail }));
        });
        airfrog.addEventListener('close', (event) => this.#closed(airfrog, event.detail));
        this.#status('connected', null);
        this.dispatchEvent(new CustomEvent('connected', { detail: airfrog }));
    }

    #failed(e) {
        if (FINAL.has(e.code)) {
            this.#status('failed', e.message);
            return;
        }
        switch (e.code) {
            case 'PASSWORD_REQUIRED':
                this.#password = null;
                this.#via = e.detail?.interface ?? null;
                this.#status('password', this.#loginNote?.message ?? null, this.#loginNote?.expected ?? false,
                    this.#via);
                this.#loginNote = null;
                return;
            case 'LOGIN_FAILED':
            case 'LOGIN_BLOCKED':
                this.#password = null;
                this.#status('password', e.message, false, this.#via);
                return;
            default:
                // After a change this page made, its message stays, as it
                // contains Airfrog's new address.
                if (this.#expecting) {
                    this.#retry(this.#expecting, true);
                } else {
                    this.#retry(`${sentence(e.message)} ${RECONNECTING}`);
                }
        }
    }

    #closed(airfrog, error) {
        if (this.#airfrog !== airfrog) {
            return;
        }
        this.#airfrog = null;
        const expected = this.#expected;
        this.#expected = null;
        if (expected && 'password' in expected) {
            this.#password = expected.password;
        }
        if (expected?.loginNote) {
            this.#loginNote = { message: expected.loginNote, expected: true };
        }
        if (expected?.confirm) {
            this.#confirming = true;
        }
        if (expected) {
            this.#expecting = expected.message;
            this.#retry(expected.message, true);
            return;
        }
        switch (error.code) {
            case 'PASSWORD_CHANGED':
                // Changed over another connection, so the password isn't known
                this.#password = null;
                this.#loginNote = { message: CONNECTION.LOG_IN_AGAIN, expected: false };
                this.#retry(RECONNECT.PASSWORD_CHANGED);
                return;
            case 'NETWORK_SETTINGS_CHANGED':
                this.#retry(RECONNECT.NETWORK_SETTINGS_CHANGED);
                return;
            case 'TOO_MANY_CONNECTIONS':
                this.#retry(RECONNECT.TOO_MANY_CONNECTIONS);
                return;
            case 'CLOSED':
                this.#retry(error.detail === CLOSE_GOING_AWAY ? RECONNECT.RESTARTING : RECONNECT.LOST);
                return;
            default:
                this.#retry(`${CLOSED[error.code] ?? sentence(error.message)} ${RECONNECTING}`);
        }
    }

    #retry(message, expected = false) {
        this.#status('waiting', message, expected);
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => this.#attempt(message, expected), this.#retryMs);
    }
}
