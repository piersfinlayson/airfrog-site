// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The page's connection to Airfrog. It logs in with the password the user
// enters, keeps the password in memory and connects again whenever the
// connection closes.

import { Airfrog } from '../airfrog.js';
import { CLOSED, CONNECTION, RECONNECT, RECONNECTING } from '../messages.js';
import { CLOSE_GOING_AWAY } from '../schema.js';

/** How long after a failure or a close the next connection is opened. */
const RETRY_MS = 2000;

/** text as a sentence, ending with a full stop. */
function sentence(text) {
    return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * Events:
 * - `status`: detail `{ state, message, expected }`. state is `connecting`,
 *   `password` (the user must enter Airfrog's password), `connected` or
 *   `waiting` (for the next attempt). message is for display, or null.
 *   expected is true while the page reconnects after a change it made
 * - `connected`: detail is the new Airfrog connection
 * - `target`: detail is the TargetInfo
 */
export class Session extends EventTarget {
    #host;
    #connect;
    #retryMs;
    #password = null;
    #hasPassword = false;
    #airfrog = null;
    #expected = null;
    #timer = null;
    #attempting = false;
    #loginNote = null;
    // The message while reconnecting after a change this page made, until a
    // connection opens.
    #expecting = null;

    /**
     * @param {string} host - Airfrog's host, location.host
     * @param {{connect?: Function, retryMs?: number}} [options] - connect is
     *        Airfrog.connect by default
     */
    constructor(host, { connect = (h, p) => Airfrog.connect(h, p), retryMs = RETRY_MS } = {}) {
        super();
        this.#host = host;
        this.#connect = connect;
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
     * Records that a request about to be sent closes the connection, so the
     * close is reported with message rather than as a failure.
     * @param {{message: string, password?: string|null}} expected - password
     *        is Airfrog's new password, null for none, after SET_PASSWORD
     */
    expectClose(expected) {
        this.#expected = expected;
    }

    /** Forgets an expectClose() whose request failed. */
    cancelExpected() {
        this.#expected = null;
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

    #status(state, message, expected = false) {
        this.dispatchEvent(new CustomEvent('status', { detail: { state, message, expected } }));
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
            airfrog = await this.#connect(this.#host, this.#password);
        } catch (e) {
            this.#attempting = false;
            this.#failed(e);
            return;
        }
        this.#attempting = false;
        this.#expecting = null;
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
        switch (e.code) {
            case 'PASSWORD_REQUIRED':
                this.#password = null;
                this.#status('password', this.#loginNote ?? null);
                this.#loginNote = null;
                return;
            case 'LOGIN_FAILED':
            case 'LOGIN_BLOCKED':
                this.#password = null;
                this.#status('password', e.message);
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
        if (expected) {
            this.#expecting = expected.message;
            this.#retry(expected.message, true);
            return;
        }
        switch (error.code) {
            case 'PASSWORD_CHANGED':
                // Changed over another connection, so the password isn't known
                this.#password = null;
                this.#loginNote = CONNECTION.LOG_IN_AGAIN;
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
