// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Little-endian fields and AWP's text fields.

import { UNRECOGNISED_REPLY } from '../messages.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(text) {
    return encoder.encode(text);
}

export function u16(value) {
    const b = new Uint8Array(2);
    view(b).setUint16(0, value, true);
    return b;
}

export function u32(value) {
    const b = new Uint8Array(4);
    view(b).setUint32(0, value >>> 0, true);
    return b;
}

export function view(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

/** AWP's variable-length text: a 2-byte length then UTF-8. */
export function textField(text) {
    const bytes = utf8(text);
    return concat(u16(bytes.length), bytes);
}

/**
 * Reads AWP's fields in order. Each read throws a FieldError when the
 * message is too short for it.
 */
export class Reader {
    constructor(bytes, what) {
        this.bytes = bytes;
        this.view = view(bytes);
        this.at = 0;
        this.what = what;
    }

    need(n) {
        if (this.at + n > this.bytes.length) {
            throw new FieldError(`${this.bytes.length}-byte ${this.what}`);
        }
        const at = this.at;
        this.at += n;
        return at;
    }

    u8() {
        return this.bytes[this.need(1)];
    }

    i8() {
        return this.view.getInt8(this.need(1));
    }

    u16() {
        return this.view.getUint16(this.need(2), true);
    }

    u32() {
        return this.view.getUint32(this.need(4), true);
    }

    bytesOf(n) {
        const at = this.need(n);
        return this.bytes.slice(at, at + n);
    }

    skip(n) {
        this.need(n);
    }

    /** The bytes not yet read. */
    left() {
        return this.bytes.length - this.at;
    }

    text() {
        const n = this.u16();
        return decoder.decode(this.bytesOf(n));
    }

    /** A fixed-length ASCII field padded with zero bytes. */
    padded(n) {
        const b = this.bytesOf(n);
        const end = b.indexOf(0);
        return decoder.decode(end < 0 ? b : b.subarray(0, end));
    }
}

/** A response from Airfrog too short for its fields. */
export class FieldError extends Error {
    constructor(what) {
        super(UNRECOGNISED_REPLY);
        this.detail = what;
        this.name = 'FieldError';
    }
}

export function hex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
