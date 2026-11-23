// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Reads a zip file's stored and deflated entries, with the browser's
// DecompressionStream for deflate. ZIP64, encryption and multi-disk zips
// aren't supported.

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

export class ZipError extends Error {}

let crcTable = null;

/** CRC-32 as zip uses it. */
export function crc32(bytes) {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            }
            crcTable[n] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (const b of bytes) {
        crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

async function inflate(data, size) {
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const out = new Uint8Array(size);
    let at = 0;
    for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) {
            break;
        }
        if (at + chunk.length > size) {
            throw new ZipError('entry larger than its recorded size');
        }
        out.set(chunk, at);
        at += chunk.length;
    }
    if (at !== size) {
        throw new ZipError('entry smaller than its recorded size');
    }
    return out;
}

/**
 * Reads the files of a zip that want() selects.
 * @param {Uint8Array} zip
 * @param {object} limits
 * @param {number} limits.maxSize - the most bytes an entry may hold
 * @param {number} limits.maxTotal - the most bytes the selected entries may
 *        hold together
 * @param {function(string): boolean} [want] - selects a file by its path
 * @returns {Promise<Map<string, Uint8Array>>} each selected file's bytes by
 *          its path. Directories are left out
 * @throws {ZipError} when zip isn't a zip this reads, entries overlap, a
 *         limit is passed, or an entry's CRC-32 or size is wrong
 */
export async function readZip(zip, { maxSize, maxTotal }, want = () => true) {
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let end = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
        if (v.getUint32(i, true) === EOCD) {
            end = i;
            break;
        }
    }
    if (end < 0) {
        throw new ZipError('no end of central directory');
    }
    const count = v.getUint16(end + 10, true);
    let at = v.getUint32(end + 16, true);
    const entries = [];
    const names = new TextDecoder();
    for (let n = 0; n < count; n++) {
        if (at + 46 > zip.length || v.getUint32(at, true) !== CENTRAL) {
            throw new ZipError('bad central directory');
        }
        const flags = v.getUint16(at + 8, true);
        const method = v.getUint16(at + 10, true);
        const crc = v.getUint32(at + 16, true);
        const packed = v.getUint32(at + 20, true);
        const size = v.getUint32(at + 24, true);
        const nameLen = v.getUint16(at + 28, true);
        const local = v.getUint32(at + 42, true);
        const name = names.decode(zip.subarray(at + 46, at + 46 + nameLen));
        at += 46 + nameLen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
        if (local + 30 > zip.length || v.getUint32(local, true) !== LOCAL) {
            throw new ZipError(`bad local header for ${name}`);
        }
        const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
        entries.push({ name, flags, method, crc, packed, size, local, start, end: start + packed });
    }
    // Entries sharing their bytes could inflate one entry's data many times.
    const spans = [...entries].sort((a, b) => a.local - b.local);
    for (let i = 1; i < spans.length; i++) {
        if (spans[i].local < spans[i - 1].end) {
            throw new ZipError(`${spans[i - 1].name} and ${spans[i].name} overlap`);
        }
    }
    const wanted = entries.filter(e => !e.name.endsWith('/') && want(e.name));
    if (wanted.reduce((total, e) => total + e.size, 0) > maxTotal) {
        throw new ZipError('files too large together');
    }
    const files = new Map();
    for (const { name, flags, method, crc, packed, size, start } of wanted) {
        if (flags & 1) {
            throw new ZipError(`${name} is encrypted`);
        }
        if (size > maxSize || packed === 0xffffffff) {
            throw new ZipError(`${name} too large`);
        }
        if (start + packed > zip.length) {
            throw new ZipError(`${name} truncated`);
        }
        const data = zip.subarray(start, start + packed);
        let bytes;
        if (method === STORED) {
            if (packed !== size) {
                throw new ZipError(`${name}'s sizes differ`);
            }
            bytes = data.slice();
        } else if (method === DEFLATED) {
            try {
                bytes = await inflate(data, size);
            } catch (e) {
                throw e instanceof ZipError ? e : new ZipError(`${name}: ${e.message}`);
            }
        } else {
            throw new ZipError(`${name} uses compression method ${method}`);
        }
        if (crc32(bytes) !== crc) {
            throw new ZipError(`${name}'s CRC-32 is wrong`);
        }
        files.set(name, bytes);
    }
    return files;
}
