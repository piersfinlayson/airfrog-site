// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Signed files: a firmware image or an extension image, followed by its
// signature. The image ends where its own headers say. Zero to 3 zero bytes
// to a 4-byte boundary, SIGNATURE_MAGIC and the signature follow it in a
// signed file. An unsigned file ends with the image.

import { EXT_IMAGE_MAGIC, SIGNATURE_LEN, SIGNATURE_MAGIC, decodeExtImage } from './schema.js';

const ESP_IMAGE_MAGIC = 0xE9;
/** esp_image_header_t, and its hash_appended byte. */
const ESP_HEADER_LEN = 24;
const ESP_HASH_APPENDED = 23;
const ESP_SEGMENT_HEADER_LEN = 8;
const ESP_HASH_LEN = 32;
const MAGIC = new TextEncoder().encode(SIGNATURE_MAGIC);

/**
 * The length of the ESP-IDF app image at the start of data, as ESP-IDF
 * reads it: the headers and segments, the checksum padded to 16 bytes, and
 * the SHA-256 when hash_appended is set.
 * @param {Uint8Array} data
 * @returns {number|null} null when data doesn't start with a whole image
 */
export function firmwareImageLength(data) {
    if (data.length < ESP_HEADER_LEN || data[0] !== ESP_IMAGE_MAGIC) {
        return null;
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    // Numbers, not 32-bit integers, so a hostile length can't wrap.
    let at = ESP_HEADER_LEN;
    for (let i = 0; i < data[1]; i++) {
        if (at + ESP_SEGMENT_HEADER_LEN > data.length) {
            return null;
        }
        at += ESP_SEGMENT_HEADER_LEN + view.getUint32(at + 4, true);
        if (at > data.length) {
            return null;
        }
    }
    at = Math.floor(at / 16) * 16 + 16;
    if (data[ESP_HASH_APPENDED] === 1) {
        at += ESP_HASH_LEN;
    }
    return at <= data.length ? at : null;
}

/**
 * The length of the extension image at the start of data: its module ends
 * it, and without a module module_offset is its end.
 * @param {Uint8Array} data
 * @returns {number|null} null when data doesn't start with a whole image
 */
export function extensionImageLength(data) {
    const h = decodeExtImage(data);
    if (!h || h.magic !== EXT_IMAGE_MAGIC) {
        return null;
    }
    const end = h.moduleOffset + h.moduleLen;
    return end <= data.length && h.metadataOffset + h.metadataLen <= end ? end : null;
}

/**
 * The signature a client sends for an image: its own when its key ID, the
 * key's first 8 bytes, is one of Airfrog's release keys, otherwise null, so
 * the image is sent unsigned.
 * @param {Uint8Array|null} signature - the image's
 * @param {Array<Uint8Array>} keys - HELLO's release keys
 * @returns {Uint8Array|null}
 */
export function signatureFor(signature, keys) {
    const id = signature?.subarray(2, 10);
    return id && keys.some(k => k.subarray(0, 8).every((b, i) => b === id[i])) ? signature : null;
}

/**
 * Splits a firmware or extension image file into its image and signature.
 * @param {Uint8Array} file
 * @param {'firmware'|'extension'} kind
 * @returns {{image: Uint8Array, signature: Uint8Array|null}|null} signature
 *          is null for an unsigned file. null when the file is neither
 */
export function readSignedFile(file, kind) {
    const end = kind === 'firmware' ? firmwareImageLength(file) : extensionImageLength(file);
    if (end === null) {
        return null;
    }
    const image = file.subarray(0, end);
    if (end === file.length) {
        return { image, signature: null };
    }
    const block = end + ((4 - (end % 4)) % 4);
    if (file.length !== block + MAGIC.length + SIGNATURE_LEN || file.subarray(end, block).some(b => b !== 0)
        || MAGIC.some((b, i) => file[block + i] !== b)) {
        return null;
    }
    return { image, signature: file.subarray(block + MAGIC.length) };
}
