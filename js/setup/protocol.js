// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// AIRFROG_CMD's commands and their fields, from AIRFROG_CMD in
// airfrog-v2/docs/websocket-protocol.md.

import { FieldError } from './bytes.js';
import {
    AP_ON, BOOT_WINDOW_AUTO, BOOT_WINDOW_MAX_MS, Command, Ipv4Mode, PinLevel, PinRole, RESCAN_DB_MAX, RESCAN_MIN_S,
    RestartMode, SCAN_START, ScanSecurity, ScanState, SetStaFlag, SettingsFlag, StaFlag, StaReason, StaState,
    decodeBoards, decodeFwInfo,
    decodeAuthorisedWebsites, decodeHello, decodeHostAliases, decodeHostname, decodeHwInfo, decodePinMap, decodeScan,
    decodeSettings,
    decodeWifiAp, decodeWifiSta, encodeAuthorisedWebsite as encodeWebsite, encodeHostAliases as encodeAliases,
    encodeHostname as encodeName,
    encodeOtaBegin as encodeBegin, encodeOtaWrite as encodeWrite, encodeRestart as encodeRestartFields,
    encodeSetWifiSta as encodeWifi, encodeSettings as encodeSettingsFields, encodeWifiScan as encodeScan,
} from '../schema.js';

export {
    BOOT_WINDOW_AUTO, BOOT_WINDOW_MAX_MS, Command, Ipv4Mode, PinLevel, PinRole, RESCAN_DB_MAX, RESCAN_MIN_S,
    RestartMode, ScanSecurity, ScanState, SetStaFlag, SettingsFlag, StaFlag, StaReason, StaState,
};

export const EMPTY = new Uint8Array(0);

/**
 * Returns fields. Throws a FieldError when fields is null.
 * @param {object|null} fields
 * @param {Uint8Array} p
 * @param {string} what - the message, for example 'GET_HW_INFO response'
 */
function need(fields, p, what) {
    if (!fields) {
        throw new FieldError(`${p.length}-byte ${what}`);
    }
    return fields;
}

/** HELLO's payload. */
export function parseHello(p) {
    const { revision, flags, maxTransfer, salt, iterations } = need(decodeHello(p), p, 'HELLO');
    if (!iterations) {
        throw new FieldError('HELLO with 0 PBKDF2 iterations');
    }
    return { revision, flags, maxTransfer, salt, iterations };
}

export function parseHwInfo(p) {
    const f = need(decodeHwInfo(p), p, 'GET_HW_INFO response');
    return {
        chip: f.chip, chipRev: { major: f.chipRev[0], minor: f.chipRev[1] }, flash: f.flash, psram: f.psram,
        mac: f.mac, model: f.model, serial: f.serial,
    };
}

export function parseFwInfo(p) {
    const f = need(decodeFwInfo(p), p, 'GET_FW_INFO response');
    return { version: f.version.join('.'), bootloader: f.bootloader, wamr: f.wamr.join('.'), commit: f.commit ?? '' };
}

export function parseWifiSta(p) {
    const f = need(decodeWifiSta(p), p, 'GET_WIFI_STA response');
    return {
        state: f.state, reason: f.reason, rssi: f.rssi, ipv4: f.ipv4, ipv6: f.ipv6, ipv4Mode: f.ipv4Mode,
        password: Boolean(f.flags & StaFlag.PASSWORD), netmask: f.ipv4Netmask, gateway: f.ipv4Gateway,
        dns: f.ipv4Dns, ssid: f.ssid,
    };
}

export function parseWifiAp(p) {
    const f = need(decodeWifiAp(p), p, 'GET_WIFI_AP response');
    return { on: f.state === AP_ON, stations: f.stations, ipv4: f.ipv4, ipv6: f.ipv6, ssid: f.ssid };
}

/**
 * @param {{ssid: string, password: string, keepPassword?: boolean,
 *          ipv4: null|{address: Uint8Array, netmask: Uint8Array,
 *          gateway: Uint8Array, dns: Uint8Array}}} wifi
 *        keepPassword keeps the saved password, and password is then empty.
 *        ipv4 null for DHCP. Each address is 4 bytes in network order
 */
export function encodeSetWifiSta(wifi) {
    const ip = wifi.ipv4;
    return encodeWifi({
        ipv4Mode: ip ? Ipv4Mode.STATIC : Ipv4Mode.DHCP, flags: wifi.keepPassword ? SetStaFlag.KEEP_PASSWORD : 0,
        ipv4: ip?.address, ipv4Netmask: ip?.netmask, ipv4Gateway: ip?.gateway, ipv4Dns: ip?.dns,
        ssid: wifi.ssid, password: wifi.password,
    });
}

export function parseHostname(p) {
    return need(decodeHostname(p), p, 'GET_HOSTNAME response').hostname;
}

export function encodeHostname(name) {
    return encodeName({ hostname: name });
}

export function parseHostAliases(p) {
    return need(decodeHostAliases(p), p, 'GET_HOST_ALIASES response').alias;
}

export function encodeHostAliases(aliases) {
    return encodeAliases({ alias: aliases });
}

export function parseAuthorisedWebsites(p) {
    return need(decodeAuthorisedWebsites(p), p, 'GET_AUTHORISED_WEBSITES response').website;
}

/** ADD_AUTHORISED_WEBSITE's and REMOVE_AUTHORISED_WEBSITE's fields. */
export function encodeAuthorisedWebsite(website) {
    return encodeWebsite({ website });
}

/**
 * GET_BOARDS's response.
 * @returns {Array<{board: number, target: string, name: string}>}
 */
export function parseBoards(p) {
    return need(decodeBoards(p), p, 'GET_BOARDS response').entries;
}

export function parsePinMap(p) {
    const f = need(decodePinMap(p), p, 'GET_PIN_MAP response');
    return { board: f.board, resetMs: f.resetMs, bootDelayMs: f.bootDelayMs, bootHoldMs: f.bootHoldMs,
        entries: f.entries };
}

export function parseSettings(p) {
    const f = need(decodeSettings(p), p, 'GET_SETTINGS response');
    return {
        board: f.board, bootWindowMs: f.bootWindowMs, changeCheckMs: f.changeCheckMs,
        bootWindowAutoMs: f.bootWindowAutoMs || null, flags: f.flags,
        recovery: Boolean(f.flags & SettingsFlag.RECOVERY),
        wifiPowerSave: Boolean(f.flags & SettingsFlag.WIFI_POWER_SAVE),
        wifiRescanS: f.wifiRescanS, wifiRescanDb: f.wifiRescanDb,
    };
}

/**
 * SET_SETTINGS's fields. recovery and wifiPowerSave set their flags, and
 * flags' other bits are sent as GET_SETTINGS read them.
 */
export function encodeSettings(s) {
    const known = SettingsFlag.RECOVERY | SettingsFlag.WIFI_POWER_SAVE;
    const flags = ((s.flags ?? 0) & ~known) | (s.recovery ? SettingsFlag.RECOVERY : 0)
        | (s.wifiPowerSave ? SettingsFlag.WIFI_POWER_SAVE : 0);
    return encodeSettingsFields({ board: s.board, bootWindowMs: s.bootWindowMs, changeCheckMs: s.changeCheckMs, flags,
        wifiRescanS: s.wifiRescanS, wifiRescanDb: s.wifiRescanDb });
}

/**
 * RESTART's fields.
 * @param {number} mode - RestartMode
 * @param {number} [timeoutMs] - graceful's longest wait for the claim to be
 *        released. 0 for Airfrog's default
 */
export function encodeRestart(mode, timeoutMs = 0) {
    return encodeRestartFields({ mode, timeoutMs });
}

/** WIFI_SCAN's request. */
export function encodeWifiScan(start) {
    return encodeScan({ flags: start ? SCAN_START : 0 });
}

/**
 * @returns {{state: number, networks: Array<{rssi: number, security: number,
 *           channel: number, ssid: string}>}}
 */
export function parseWifiScan(p) {
    const f = need(decodeScan(p), p, 'WIFI_SCAN response');
    return { state: f.state, networks: f.networks };
}

/**
 * @param {number} size
 * @param {Uint8Array} sha256 - 32 bytes
 */
export function encodeOtaBegin(size, sha256) {
    return encodeBegin({ size, sha256 });
}

export function encodeOtaWrite(offset, data) {
    return encodeWrite({ offset, data });
}

/**
 * @param {Error} e - an AirfrogError or any other error
 * @returns {string} the error for display. An AirfrogError's message is
 *          js/messages.js's text for it
 */
export function errorText(e) {
    return e?.message ?? String(e);
}
