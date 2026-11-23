// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// SHA-256, HMAC-SHA256 and PBKDF2-HMAC-SHA256 (FIPS 180-4, RFC 2104, RFC
// 8018). crypto.subtle is unavailable to a page served over http://, which
// Airfrog's home page is.

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const W = new Uint32Array(64);

/**
 * Compresses the 64-byte block at block[at] into state.
 * @param {Uint32Array} state
 * @param {Uint8Array} block
 * @param {number} at
 */
function compress(state, block, at) {
    for (let i = 0; i < 16; i++, at += 4) {
        W[i] = (block[at] << 24) | (block[at + 1] << 16) | (block[at + 2] << 8) | block[at + 3];
    }
    for (let i = 16; i < 64; i++) {
        const a = W[i - 15], b = W[i - 2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = state[0], b = state[1], c = state[2], d = state[3];
    let e = state[4], f = state[5], g = state[6], h = state[7];
    for (let i = 0; i < 64; i++) {
        const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const t1 = (h + s1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
        const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    state[0] += a; state[1] += b; state[2] += c; state[3] += d;
    state[4] += e; state[5] += f; state[6] += g; state[7] += h;
}

class Sha256 {
    constructor() {
        this.state = new Uint32Array(INITIAL);
        this.buffer = new Uint8Array(64);
        this.buffered = 0;
        this.length = 0;
    }

    clone() {
        const copy = new Sha256();
        copy.state.set(this.state);
        copy.buffer.set(this.buffer);
        copy.buffered = this.buffered;
        copy.length = this.length;
        return copy;
    }

    /**
     * @param {Uint8Array} data
     * @returns {Sha256}
     */
    update(data) {
        this.length += data.length;
        let at = 0;
        if (this.buffered) {
            const take = Math.min(64 - this.buffered, data.length);
            this.buffer.set(data.subarray(0, take), this.buffered);
            this.buffered += take;
            at = take;
            if (this.buffered < 64) {
                return this;
            }
            compress(this.state, this.buffer, 0);
            this.buffered = 0;
        }
        for (; at + 64 <= data.length; at += 64) {
            compress(this.state, data, at);
        }
        this.buffer.set(data.subarray(at), 0);
        this.buffered = data.length - at;
        return this;
    }

    /**
     * @returns {Uint8Array} 32 bytes
     */
    digest() {
        const bits = this.length * 8;
        const pad = new Uint8Array((this.buffered < 56 ? 56 : 120) - this.buffered + 8);
        pad[0] = 0x80;
        const view = new DataView(pad.buffer);
        view.setUint32(pad.length - 8, Math.floor(bits / 0x100000000));
        view.setUint32(pad.length - 4, bits >>> 0);
        this.update(pad);
        const out = new Uint8Array(32);
        const outView = new DataView(out.buffer);
        for (let i = 0; i < 8; i++) {
            outView.setUint32(i * 4, this.state[i]);
        }
        return out;
    }
}

/**
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function sha256(data) {
    return new Sha256().update(data).digest();
}

/**
 * The inner and outer hashes of HMAC-SHA256 with key, each after its padded
 * key block.
 * @param {Uint8Array} key
 * @returns {{inner: Sha256, outer: Sha256}}
 */
function hmacStart(key) {
    if (key.length > 64) {
        key = sha256(key);
    }
    const block = new Uint8Array(64);
    block.set(key);
    const inner = new Sha256().update(block.map(b => b ^ 0x36));
    const outer = new Sha256().update(block.map(b => b ^ 0x5c));
    return { inner, outer };
}

/**
 * HMAC-SHA256 of the parts, one after another.
 * @param {Uint8Array} key
 * @param {...Uint8Array} parts
 * @returns {Uint8Array}
 */
export function hmacSha256(key, ...parts) {
    const { inner, outer } = hmacStart(key);
    for (const part of parts) {
        inner.update(part);
    }
    return outer.update(inner.digest()).digest();
}

/**
 * PBKDF2-HMAC-SHA256 with a 32-byte result.
 * @param {Uint8Array} password
 * @param {Uint8Array} salt
 * @param {number} iterations
 * @returns {Uint8Array}
 */
export function pbkdf2HmacSha256(password, salt, iterations) {
    const { inner, outer } = hmacStart(password);
    const block1 = new Uint8Array([0, 0, 0, 1]);
    let u = outer.clone().update(inner.clone().update(salt).update(block1).digest()).digest();
    const result = u.slice();

    // Each later HMAC hashes 32 bytes after the key block, so its inner and
    // outer hashes are each one compression of a block padded to 96 bytes.
    const block = new Uint8Array(64);
    block[32] = 0x80;
    block[62] = 0x03;  // 96 bytes = 0x300 bits
    const state = new Uint32Array(8);
    for (let i = 1; i < iterations; i++) {
        block.set(u);
        state.set(inner.state);
        compress(state, block, 0);
        for (let j = 0; j < 8; j++) {
            block[j * 4] = state[j] >>> 24;
            block[j * 4 + 1] = state[j] >>> 16;
            block[j * 4 + 2] = state[j] >>> 8;
            block[j * 4 + 3] = state[j];
        }
        state.set(outer.state);
        compress(state, block, 0);
        for (let j = 0; j < 8; j++) {
            u[j * 4] = state[j] >>> 24;
            u[j * 4 + 1] = state[j] >>> 16;
            u[j * 4 + 2] = state[j] >>> 8;
            u[j * 4 + 3] = state[j];
            result[j * 4] ^= u[j * 4];
            result[j * 4 + 1] ^= u[j * 4 + 1];
            result[j * 4 + 2] ^= u[j * 4 + 2];
            result[j * 4 + 3] ^= u[j * 4 + 3];
        }
    }
    return result;
}
