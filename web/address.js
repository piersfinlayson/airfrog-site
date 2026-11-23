// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The addresses airfrog.org/web accepts, and which of them a frame can load.

const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const NAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The four numbers of an IPv4 address written in full without leading zeros, or null. */
function octets(host) {
    const m = IPV4.exec(host);
    const numbers = m && m.slice(1).map(Number);
    return numbers && numbers.every((n, i) => n <= 255 && String(n) === m[i + 1]) ? numbers : null;
}

/**
 * The address typed or pasted as a host with an optional port, or as an
 * http:// URL, in lower case. Returns null for anything else.
 * @param {string} text
 * @returns {string|null} HOST or HOST:PORT
 */
export function parseAddress(text) {
    const typed = text.trim().replace(/^http:\/\//i, '');
    const slash = typed.indexOf('/');
    const address = (slash < 0 ? typed : typed.slice(0, slash)).toLowerCase();
    const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(address);
    if (!m || !NAME.test(m[1]) || (m[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65535))) {
        return null;
    }
    // A name ending in a number is read as an IPv4 address, which must then be in full.
    if (/^\d+$/.test(m[1].split('.').pop()) && !octets(m[1])) {
        return null;
    }
    return address;
}

/**
 * Whether a page on airfrog.org can show the address in a frame: a .local
 * name, an IPv4 address on the local network or 127.0.0.1. Any other name
 * is blocked as mixed content.
 * @param {string} address - HOST or HOST:PORT
 */
export function frameable(address) {
    const host = address.toLowerCase().replace(/:\d+$/, '');
    const n = octets(host);
    if (n) {
        return n[0] === 10 || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 192 && n[1] === 168)
            || (n[0] === 169 && n[1] === 254) || host === '127.0.0.1';
    }
    return host.length > '.local'.length && host.endsWith('.local') && NAME.test(host);
}
