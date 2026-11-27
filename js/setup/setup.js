// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Airfrog's setup: its state, read with AIRFROG_CMD, and the cards that
// display and change it. The same cards run over the WebSocket, on Airfrog's
// home page, and over serial, on airfrog.org/commissioning.

import { utf8 } from './bytes.js';
import { pbkdf2HmacSha256 } from '../sha256.js';
import { FLAG_PASSWORD, SALT_LEN, encodeSetPassword } from '../schema.js';
import { Command, EMPTY, StaState, errorText, parseAuthorisedWebsites, parseBoards, parseFwInfo, parseHostAliases,
    parseHostname, parseHwInfo, parsePinMap, parseSettings, parseWifiAp, parseWifiSta } from './protocol.js';
import { HostnameView, JoinView, WifiApView, WifiView } from './network.js';
import { AboutView, AuthorisedWebsitesView, FirmwareView, FirstSetupView, PasswordView } from './system.js';
import { TargetSettingsView } from './settings.js';
import { checkFirmwareManifest } from './releases.js';
import { takeResult } from './update.js';
import { SETTINGS, UPDATE } from '../messages.js';

/** The limit on each AIRFROG_CMD. */
const CMD_MS = 10000;
/** How often the WiFi state is read again while Airfrog joins a network. */
const WIFI_POLL_MS = 3000;
/** How long the WiFi state is read again after a network is saved over serial. */
const JOIN_WATCH_MS = 60000;

/** Each read: its command and parser. */
export const READS = {
    hw: [Command.GET_HW_INFO, parseHwInfo],
    fw: [Command.GET_FW_INFO, parseFwInfo],
    hostname: [Command.GET_HOSTNAME, parseHostname],
    sta: [Command.GET_WIFI_STA, parseWifiSta],
    ap: [Command.GET_WIFI_AP, parseWifiAp],
    aliases: [Command.GET_HOST_ALIASES, parseHostAliases],
    websites: [Command.GET_AUTHORISED_WEBSITES, parseAuthorisedWebsites],
    pinMap: [Command.GET_PIN_MAP, parsePinMap],
    settings: [Command.GET_SETTINGS, parseSettings],
    boards: [Command.GET_BOARDS, parseBoards],
};

/**
 * @typedef {object} Transport
 * @property {function(number, Uint8Array, number): Promise<Uint8Array>} command -
 *           sends AIRFROG_CMD and returns the response's fields
 * @property {{flags: number, iterations: number}} hello - HELLO's
 * @property {boolean} closes - whether a change of password or network
 *           settings closes the connection, as on the WebSocket
 */

/**
 * @typedef {object} SetupState
 * @property {boolean} connected
 * @property {boolean} hasPassword
 * @property {number|null} interface - HELLO's: how this connection reaches Airfrog
 * @property {Array<Uint8Array>} releaseKeys - HELLO's release keys, empty over serial
 * @property {object|null} hw - GET_HW_INFO's
 * @property {object|null} fw - GET_FW_INFO's
 * @property {string|null} hostname
 * @property {object|null} sta - GET_WIFI_STA's
 * @property {object|null} ap - GET_WIFI_AP's
 * @property {Array<string>|null} aliases
 * @property {Array<string>|null} websites - the authorised websites
 * @property {object|null} pinMap - GET_PIN_MAP's
 * @property {object|null} settings - GET_SETTINGS's
 * @property {Array<object>|null} boards - GET_BOARDS's
 * @property {import('../awp.js').TargetInfo|null} target
 * @property {string|null} joining - over serial, the network just saved, until
 *           GET_WIFI_STA reports Airfrog connected to it
 */

export class Setup {
    /**
     * @param {object} options
     * @param {import('./session.js').Session} [options.session] - the
     *        WebSocket connection. Its connections are the transport
     * @param {Transport} [options.transport] - serial, without a session
     * @param {object|null} [options.firmware] - the verified firmware
     *        manifest, for its releases
     * @param {string|null} [options.firmwareError] - why there isn't one
     * @param {function(SetupState)} [options.onRender] - called after each
     *        redraw
     */
    constructor({ session = null, transport = null, firmware = null, firmwareError = null, onRender = () => {} }) {
        this.session = session;
        this.transport = transport;
        this.firmware = null;
        this.firmwareError = firmwareError;
        if (firmware) {
            try {
                this.firmware = checkFirmwareManifest(firmware);
            } catch (e) {
                this.firmwareError = e.message;
            }
        }
        this.onRender = onRender;
        this.updating = false;
        this.wifiTimer = null;
        /** @type {SetupState} */
        this.state = { connected: Boolean(transport), hasPassword: Boolean(transport?.hello.flags & FLAG_PASSWORD),
            interface: transport?.hello.interface ?? null, releaseKeys: [], hw: null,
            fw: null, hostname: null, sta: null, ap: null, aliases: null, websites: null, pinMap: null, settings: null,
            boards: null, target: null, joining: null };
        this.joinSince = 0;
        this.joinUntil = 0;
        this.staReadAt = 0;
        this.views = {
            wifi: new WifiView(this), join: new JoinView(this), hostname: new HostnameView(this),
            wifiAp: new WifiApView(this), firstSetup: new FirstSetupView(this),
            password: new PasswordView(this), websites: new AuthorisedWebsitesView(this), about: new AboutView(),
            targetSettings: new TargetSettingsView(this),
        };
        // Over the WebSocket only, which reconnects after the restart.
        this.updateResult = session ? takeResult() : null;
        if (session) {
            this.views.firmware = new FirmwareView(this, this.updateResult);
            this.views.about.addRestart(this.views.firmware.restartElement);
        }
    }

    /** The connection the state was read on: a new one clears the cards' messages. */
    get link() {
        return this.session ? this.session.airfrog : this.transport;
    }

    /** Whether a change of password or network settings closes the connection. */
    get closes() {
        return Boolean(this.session);
    }

    /**
     * Sends AIRFROG_CMD.
     * @returns {Promise<Uint8Array>} the response's fields
     */
    command(command, fields = EMPTY, timeoutMs = CMD_MS) {
        if (this.transport) {
            return this.transport.command(command, fields, timeoutMs);
        }
        const airfrog = this.session.airfrog;
        if (!airfrog) {
            return Promise.reject(new Error(UPDATE.NOT_CONNECTED));
        }
        return airfrog.airfrogCmd(command, fields, timeoutMs);
    }

    /**
     * Sends a command that saves a setting, displaying the result on msg.
     * @param {string} [outOfRange] - displayed when Airfrog fails the
     *        command with OUT_OF_RANGE
     * @returns {Promise<boolean>} whether it was saved
     */
    async save(msg, command, fields, done, outOfRange = SETTINGS.INVALID_VALUE) {
        msg.say(SETTINGS.SAVING);
        try {
            await this.command(command, fields);
        } catch (e) {
            const outOfRangeError = e.code === 'OUT_OF_RANGE' || e.codeName === 'OUT_OF_RANGE';
            msg.say(`${SETTINGS.SAVE_FAILED} ${outOfRange && outOfRangeError ? outOfRange : errorText(e)}`, 'bad');
            return false;
        }
        msg.say(done, 'ok');
        return true;
    }

    /**
     * Records that a request about to be sent closes the connection. Over serial
     * nothing closes.
     */
    expectClose(expected) {
        this.session?.expectClose(expected);
    }

    cancelExpected() {
        this.session?.cancelExpected();
    }

    /** Sets Airfrog's password, or removes it with an empty password. */
    async setPassword(password) {
        if (this.session) {
            const airfrog = this.session.airfrog;
            if (!airfrog) {
                throw new Error(UPDATE.NOT_CONNECTED);
            }
            await airfrog.setPassword(password);
            return;
        }
        let fields = encodeSetPassword({});
        if (password) {
            const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
            fields = encodeSetPassword({ key: pbkdf2HmacSha256(utf8(password), salt, this.transport.hello.iterations),
                salt });
        }
        await this.command(Command.SET_PASSWORD, fields);
        if (!this.closes) {
            this.state.hasPassword = Boolean(password);
            this.render();
        }
    }

    /** Reads one of READS's keys again and redraws. */
    async reload(key) {
        const [command, parse] = READS[key];
        const started = Date.now();
        this.state[key] = parse(await this.command(command));
        if (key === 'sta') {
            this.staReadAt = started;
        }
        this.render();
    }

    /** Reads everything in READS. */
    async readAll() {
        for (const key of Object.keys(READS)) {
            const [command, parse] = READS[key];
            this.state[key] = parse(await this.command(command));
        }
        this.render();
    }

    setUpdating(on) {
        this.updating = on;
        this.render();
    }

    /**
     * Loads Airfrog's home page again after a firmware update, without
     * #local, so the new firmware's full user interface loads.
     */
    reloadPage() {
        if (location.hash) {
            history.replaceState?.(null, '', location.pathname);
        }
        location.reload();
    }

    render() {
        this.#endJoin();
        for (const view of Object.values(this.views)) {
            view.update(this.state);
        }
        this.#watchWifi();
        this.onRender(this.state);
    }

    /**
     * Records that network ssid was saved. Over the WebSocket the connection
     * closes and the next one reads the state. Over serial the state is read
     * again until Airfrog has joined it.
     */
    joined(ssid) {
        if (!this.closes) {
            this.state.joining = ssid;
            this.joinSince = Date.now();
            this.joinUntil = this.joinSince + JOIN_WATCH_MS;
            this.render();
        }
    }

    /** Ends the join watch once Airfrog has joined, or after JOIN_WATCH_MS. */
    #endJoin() {
        const { sta, joining } = this.state;
        // Only a read made after the save ends the watch.
        const joined = this.staReadAt >= this.joinSince && sta?.state === StaState.CONNECTED && sta.ssid === joining;
        if (joining && (joined || Date.now() > this.joinUntil)) {
            this.state.joining = null;
        }
    }

    /** Reads the WiFi state again while Airfrog joins a network. */
    #watchWifi() {
        const { sta } = this.state;
        // AP mode's notice of the network Airfrog joined is displayed until
        // AP mode stops.
        const apNotice = this.closes && this.state.ap?.on && sta?.state === StaState.CONNECTED;
        const joining = sta?.state === StaState.CONNECTING || sta?.state === StaState.FAILED;
        if (this.wifiTimer || !this.state.connected || (!joining && !this.state.joining && !apNotice)) {
            return;
        }
        this.wifiTimer = setTimeout(async () => {
            this.wifiTimer = null;
            try {
                if (apNotice) {
                    await this.reload('ap');
                }
                await this.reload('sta');
            } catch (e) {
                // The connection closed. The next one reads the state.
            }
        }, WIFI_POLL_MS);
    }
}
