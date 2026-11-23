// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Semantic versions, compared by precedence (semver.org 2.0.0, section 11).

const SEMVER = new RegExp('^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)'
    + '(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?'
    + '(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$');

/**
 * @param {string} version
 * @returns {{core: Array<number>, pre: Array<string>}|null} null when version
 *          isn't a semantic version
 */
export function parse(version) {
    const m = typeof version === 'string' ? SEMVER.exec(version) : null;
    if (!m) {
        return null;
    }
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

export function isVersion(version) {
    return parse(version) !== null;
}

function compareIdentifier(a, b) {
    const na = /^\d+$/.test(a);
    const nb = /^\d+$/.test(b);
    if (na && nb) {
        return Math.sign(Number(a) - Number(b));
    }
    if (na !== nb) {
        return na ? -1 : 1;
    }
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compares two semantic versions by precedence. Build metadata is ignored.
 * @returns {number} negative when a is lower, 0 when equal, positive when a
 *          is higher
 * @throws {TypeError} when either isn't a semantic version
 */
export function compare(a, b) {
    const pa = parse(a);
    const pb = parse(b);
    if (!pa || !pb) {
        throw new TypeError(`Not a semantic version: ${pa ? b : a}`);
    }
    for (let i = 0; i < 3; i++) {
        if (pa.core[i] !== pb.core[i]) {
            return Math.sign(pa.core[i] - pb.core[i]);
        }
    }
    if (!pa.pre.length || !pb.pre.length) {
        return (pa.pre.length ? -1 : 0) + (pb.pre.length ? 1 : 0);
    }
    for (let i = 0; i < Math.min(pa.pre.length, pb.pre.length); i++) {
        const c = compareIdentifier(pa.pre[i], pb.pre[i]);
        if (c) {
            return c;
        }
    }
    return Math.sign(pa.pre.length - pb.pre.length);
}
