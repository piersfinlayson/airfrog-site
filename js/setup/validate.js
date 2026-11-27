// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Checks the settings forms against the limits Airfrog applies, and builds
// each command's fields. Each check returns { errors, fields }: errors lists
// { field, message }, and fields is set only when errors is empty.

import { BOOT_WINDOW_AUTO, BOOT_WINDOW_MAX_MS, RESCAN_DB_MAX, RESCAN_MIN_S, encodeAuthorisedWebsite,
    encodeHostAliases, encodeHostname, encodeSetWifiAp, encodeSetWifiSta, encodeSettings } from './protocol.js';
import { utf8 } from './bytes.js';
import {
    AUTHORISED_WEBSITE_MAX, HOSTNAME_MAX, HOST_ALIASES_MAX as MAX_ALIASES, HOST_ALIAS_MAX, LABEL_MAX, PASSWORD_MIN,
    SETTINGS_BOARD_MAX, SETTINGS_CHANGE_CHECK_MS_MAX, SETTINGS_WIFI_RESCAN_S_MAX, SSID_MAX, WIFI_PASSWORD_MAX,
    WIFI_PASSWORD_MIN,
} from '../schema.js';
import { AUTHORISED_WEBSITES, NETWORK, PASSWORD, PASSWORD_RULE, TARGET_SETTINGS, WIFI_AP } from '../messages.js';

const HOSTNAME = new RegExp(`^[A-Za-z0-9]([A-Za-z0-9-]{0,${HOSTNAME_MAX - 2}}[A-Za-z0-9])?$`);
const ALIAS_LABELS = new RegExp(`^[A-Za-z0-9-]{1,${LABEL_MAX}}(\\.[A-Za-z0-9-]{1,${LABEL_MAX}})*$`);
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const bytes = (s) => utf8(s).length;

function result(errors, fields) {
    return errors.length ? { errors, fields: null } : { errors, fields };
}

/** @returns {Uint8Array|null} a dotted IPv4 address as 4 bytes */
export function parseIpv4(s) {
    const m = IPV4.exec(s.trim());
    if (!m) return null;
    const b = m.slice(1).map(Number);
    return b.every(n => n <= 255) ? new Uint8Array(b) : null;
}

/** Whether a netmask's 1 bits are contiguous from the top bit. */
export function contiguous(mask) {
    const inverse = ~((mask[0] << 24) | (mask[1] << 16) | (mask[2] << 8) | mask[3]) >>> 0;
    return (inverse & (inverse + 1)) === 0;
}

/**
 * @param {{ssid: string, password: string, keepPassword?: boolean, staticIpv4: boolean,
 *          address: string, netmask: string, gateway: string, dns: string}} f -
 *        keepPassword keeps the saved password, with password empty
 * @returns {{errors: Array, fields: Uint8Array|null}} SET_WIFI_STA's fields
 */
export function checkWifi(f) {
    const errors = [];
    const fail = (field, message) => errors.push({ field, message });
    const ssid = f.ssid ?? '';
    const password = f.password ?? '';
    if (bytes(ssid) < 1 || bytes(ssid) > SSID_MAX) {
        fail('ssid', NETWORK.INVALID_SSID);
    }
    if (password && (bytes(password) < WIFI_PASSWORD_MIN || bytes(password) > WIFI_PASSWORD_MAX)) {
        fail('password', NETWORK.INVALID_PASSWORD);
    }
    let ipv4 = null;
    if (f.staticIpv4) {
        const address = (name, invalid, required) => {
            const s = (f[name] ?? '').trim();
            if (!s && !required) return new Uint8Array(4);
            const a = parseIpv4(s);
            if (!a) fail(name, invalid);
            return a;
        };
        ipv4 = {
            address: address('address', NETWORK.INVALID_IP_ADDRESS, true),
            netmask: address('netmask', NETWORK.INVALID_SUBNET_MASK, true),
            gateway: address('gateway', NETWORK.INVALID_GATEWAY, false),
            dns: address('dns', NETWORK.INVALID_DNS_SERVER, false),
        };
        if (ipv4.address?.every(b => b === 0)) {
            fail('address', NETWORK.ZERO_IP_ADDRESS);
        }
        if (ipv4.netmask && (ipv4.netmask.every(b => b === 0) || !contiguous(ipv4.netmask))) {
            fail('netmask', NETWORK.SUBNET_MASK_BITS);
        }
    }
    return result(errors, errors.length ? null
        : encodeSetWifiSta({ ssid, password, keepPassword: Boolean(f.keepPassword), ipv4 }));
}

/** @returns {{errors: Array, fields: Uint8Array|null}} SET_HOSTNAME's fields */
export function checkHostname(name) {
    if (!HOSTNAME.test(name)) {
        return result([{ field: 'hostname', message: NETWORK.INVALID_HOSTNAME }]);
    }
    return result([], encodeHostname(name));
}

/**
 * @param {string} text - aliases separated by spaces
 * @returns {{errors: Array, fields: Uint8Array|null, aliases: Array<string>}}
 *          SET_HOST_ALIASES's fields
 */
export function checkAliases(text) {
    const aliases = text.split(/[\s,]+/).filter(a => a);
    const errors = [];
    if (aliases.length > MAX_ALIASES) {
        errors.push({ field: 'aliases', message: NETWORK.TOO_MANY_ALIASES });
    }
    const bad = aliases.find(a => bytes(a) > HOST_ALIAS_MAX || !ALIAS_LABELS.test(a));
    if (bad) {
        errors.push({ field: 'aliases', message: NETWORK.INVALID_ALIAS(bad) });
    }
    return { ...result(errors, encodeHostAliases(aliases)), aliases };
}

/**
 * A website typed in the Authorised websites card, in the form a browser
 * reports it: https:// when typed without a scheme, the host in lower case,
 * without the scheme's default port.
 * @param {string} text
 * @returns {{errors: Array, fields: Uint8Array|null, website: string|null}}
 *          ADD_AUTHORISED_WEBSITE's fields
 */
export function checkWebsite(text) {
    const typed = text.trim();
    let website = null;
    try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
        const host = url.hostname;
        const hostValid = host.startsWith('[') || (bytes(host) <= HOST_ALIAS_MAX && ALIAS_LABELS.test(host));
        if (['http:', 'https:'].includes(url.protocol) && hostValid && !url.username && !url.password
            && url.pathname === '/' && !url.search && !url.hash && !/[?#]$/.test(typed)
            && bytes(url.origin) <= AUTHORISED_WEBSITE_MAX) {
            website = url.origin;
        }
    } catch (e) {
        // Not a URL
    }
    if (!website) {
        return { ...result([{ field: 'website', message: AUTHORISED_WEBSITES.INVALID(typed) }]), website };
    }
    return { ...result([], encodeAuthorisedWebsite(website)), website };
}

/**
 * Whether password follows the password rule, PASSWORD_RULE: at least
 * PASSWORD_MIN characters, including an upper case letter, a lower case
 * letter and a number. Characters are code points, and the classes are
 * Unicode's Uppercase, Lowercase and Number, as Rust's char::is_uppercase,
 * is_lowercase and is_numeric in the airfrog CLI.
 * @param {string} password
 */
export function followsRule(password) {
    return [...password].length >= PASSWORD_MIN && /\p{Uppercase}/u.test(password)
        && /\p{Lowercase}/u.test(password) && /\p{N}/u.test(password);
}

/**
 * Airfrog's new password, entered twice.
 * @param {string} password
 * @param {string} repeat
 * @returns {Array} the errors, empty when the password can be set
 */
export function checkNewPassword(password, repeat) {
    if (!password) {
        return [{ field: 'password', message: PASSWORD.ENTER_NEW }];
    }
    if (!followsRule(password)) {
        return [{ field: 'password', message: PASSWORD_RULE.NOT_MET }];
    }
    if (password !== repeat) {
        return [{ field: 'repeat', message: PASSWORD.NOT_MATCHING }];
    }
    return [];
}

/**
 * The access point's new name and password.
 * @param {string} ssid
 * @param {string} password
 * @returns {{errors: Array, fields: Uint8Array|null}} SET_WIFI_AP's fields
 */
export function checkWifiAp(ssid, password) {
    const errors = [];
    if (bytes(ssid) < 1 || bytes(ssid) > SSID_MAX) {
        errors.push({ field: 'apSsid', message: NETWORK.INVALID_SSID });
    }
    if (bytes(password) < WIFI_PASSWORD_MIN || bytes(password) > WIFI_PASSWORD_MAX) {
        errors.push({ field: 'apPassword', message: WIFI_AP.INVALID_PASSWORD });
    }
    return result(errors, errors.length ? null : encodeSetWifiAp(ssid, password));
}

/**
 * @param {{board: string, bootWindowAuto: boolean, bootWindowMs: string,
 *          changeCheckMs: string, recovery: boolean, wifiPowerSave: boolean,
 *          wifiRescanS: string, wifiRescanDb: string}} f - board is the ID,
 *        0 for automatic
 * @returns {{errors: Array, fields: Uint8Array|null}} SET_SETTINGS's fields
 */
export function checkSettings(f) {
    const errors = [];
    const number = (name, max, message, valid = () => true) => {
        const s = String(f[name] ?? '').trim();
        const n = /^\d+$/.test(s) ? Number(s) : NaN;
        if (!(n <= max) || !valid(n)) {
            errors.push({ field: name, message });
        }
        return n;
    };
    const board = Number(f.board);
    if (!Number.isInteger(board) || board < 0 || board > SETTINGS_BOARD_MAX) {
        errors.push({ field: 'board', message: TARGET_SETTINGS.CHOOSE_BOARD });
    }
    const bootWindowMs = f.bootWindowAuto ? BOOT_WINDOW_AUTO
        : number('bootWindowMs', BOOT_WINDOW_MAX_MS, TARGET_SETTINGS.INVALID_BOOT_WINDOW);
    const changeCheckMs = number('changeCheckMs', SETTINGS_CHANGE_CHECK_MS_MAX, TARGET_SETTINGS.INVALID_CHANGE_CHECK);
    const wifiRescanS = number('wifiRescanS', SETTINGS_WIFI_RESCAN_S_MAX, NETWORK.INVALID_RESCAN_INTERVAL,
        (n) => n === 0 || n >= RESCAN_MIN_S);
    const wifiRescanDb = number('wifiRescanDb', RESCAN_DB_MAX, NETWORK.INVALID_RESCAN_THRESHOLD, (n) => n >= 1);
    return result(errors, errors.length ? null
        : encodeSettings({ board, bootWindowMs, changeCheckMs, flags: f.flags, recovery: Boolean(f.recovery),
            wifiPowerSave: Boolean(f.wifiPowerSave), wifiRescanS, wifiRescanDb }));
}
