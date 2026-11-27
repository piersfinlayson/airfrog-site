// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// An extension file: an extension package or one extension image. A
// package, NAME-VERSION.afx, is a zip with extension-meta.json,
// extension.wasm when the extension has a module, and an extension image for
// each model in images/. A package is unsigned. An extension image file is a
// signed file or an unsigned image.

import { decodeExtImage, EXT_IMAGE_MAGIC } from '../../../js/schema.js';
import { readSignedFile } from '../../../js/signed.js';
import { ERRORS, EXTENSIONS } from '../../../js/messages.js';
import { ExtensionError, checkHeader, imageMetadata, parseMetadata, pickImage, wamrText } from './list.js';
import { readZip } from './zip.js';

/** The most bytes a package entry may hold. */
const MAX_ENTRY = 1024 * 1024;

/** The most bytes the package entries read may hold together. */
const MAX_TOTAL = 4 * 1024 * 1024;

/**
 * Reads an extension file: an extension image file, or a package with the
 * extension image for this Airfrog picked from it.
 * @param {Uint8Array} bytes - the file
 * @param {number} model - GET_HW_INFO's
 * @param {string} wamr - GET_FW_INFO's, for example 2.4.5
 * @returns {Promise<{metadata: object, image: Uint8Array, signature: Uint8Array|null}>}
 *          the image's extension metadata, the image and its signature,
 *          null when it is unsigned
 * @throws {ExtensionError} INVALID_FILE's text, or EXTENSION_UNSUPPORTED's
 *         when the image isn't for this Airfrog
 */
export async function readExtensionFile(bytes, model, wamr) {
    if (decodeExtImage(bytes)?.magic !== EXT_IMAGE_MAGIC) {
        return { ...await readPackage(bytes, model, wamr), signature: null };
    }
    const file = readSignedFile(bytes, 'extension');
    const header = file && decodeExtImage(file.image);
    if (!header) {
        throw new ExtensionError(EXTENSIONS.INVALID_FILE);
    }
    const found = { model: header.model, wamr: wamrText(header.wamr) };
    if (!pickImage([found], model, wamr)) {
        throw new ExtensionError(ERRORS.EXTENSION_UNSUPPORTED());
    }
    let metadata = null;
    try {
        metadata = imageMetadata(file.image, checkHeader(file.image, { name: header.name, ...found }));
    } catch (e) {
        // Invalid below
    }
    if (metadata?.name !== header.name) {
        throw new ExtensionError(EXTENSIONS.INVALID_FILE);
    }
    return { metadata, image: file.image, signature: file.signature };
}

/**
 * Reads an extension package and picks the extension image for this
 * Airfrog.
 * @param {Uint8Array} bytes - the package
 * @param {number} model - GET_HW_INFO's
 * @param {string} wamr - GET_FW_INFO's, for example 2.4.5
 * @returns {Promise<{metadata: object, image: Uint8Array}>} the image's
 *          extension metadata and the image
 * @throws {ExtensionError} INVALID_FILE's text, or EXTENSION_UNSUPPORTED's
 *         when no image is for this Airfrog
 */
export async function readPackage(bytes, model, wamr) {
    let files;
    try {
        files = await readZip(bytes, { maxSize: MAX_ENTRY, maxTotal: MAX_TOTAL },
            (path) => path === 'extension-meta.json' || /^images\/[^/]+$/.test(path));
    } catch (e) {
        console.warn(`Extension package: ${e.message}`);
        throw new ExtensionError(EXTENSIONS.INVALID_FILE);
    }
    const meta = files.get('extension-meta.json');
    const metadata = meta && parseMetadata(meta);
    if (!metadata) {
        throw new ExtensionError(EXTENSIONS.INVALID_FILE);
    }
    const images = [];
    for (const [path, data] of files) {
        const header = path.startsWith('images/') ? decodeExtImage(data) : null;
        if (header?.magic === EXT_IMAGE_MAGIC && header.name === metadata.name) {
            images.push({ model: header.model, wamr: wamrText(header.wamr), data });
        }
    }
    if (!images.length) {
        throw new ExtensionError(EXTENSIONS.INVALID_FILE);
    }
    const chosen = pickImage(images, model, wamr);
    if (!chosen) {
        throw new ExtensionError(ERRORS.EXTENSION_UNSUPPORTED());
    }
    let header;
    try {
        header = checkHeader(chosen.data, { name: metadata.name, model: chosen.model, wamr: chosen.wamr });
    } catch (e) {
        throw new ExtensionError(EXTENSIONS.INVALID_FILE);
    }
    const stored = imageMetadata(chosen.data, header);
    if (stored?.name !== metadata.name) {
        throw new ExtensionError(EXTENSIONS.INVALID_FILE);
    }
    return { metadata: stored, image: chosen.data };
}
