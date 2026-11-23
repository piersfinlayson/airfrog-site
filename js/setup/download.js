// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Downloads that fail when nothing is received for DOWNLOAD_TIMEOUT_MS, for a
// server that doesn't answer or stops part way.

import { DOWNLOAD_TIMEOUT_MS } from '../schema.js';

/** A download that failed. */
export class DownloadError extends Error {
    /**
     * @param {string} message - for developers
     * @param {object} [why] - neither for a server that can't be reached
     * @param {number|null} [why.status] - an HTTP error's status
     * @param {boolean} [why.timedOut] - nothing was received in time
     */
    constructor(message, { status = null, timedOut = false } = {}) {
        super(message);
        this.status = status;
        this.timedOut = timedOut;
    }
}

/**
 * @param {string} url
 * @param {object} [options] - fetch()'s, and:
 * @param {Function} [options.fetch]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<Uint8Array>} the body
 * @throws {DownloadError}
 */
export async function download(url, { fetch: fetchFn = fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS, ...options } = {}) {
    const abort = new AbortController();
    let timedOut = false;
    let timer = null;
    const received = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            timedOut = true;
            abort.abort();
        }, timeoutMs);
    };
    try {
        received();
        const response = await fetchFn(url, { ...options, signal: abort.signal });
        if (!response.ok) {
            throw new DownloadError(`HTTP ${response.status}: ${url}`, { status: response.status });
        }
        const reader = response.body.getReader();
        const chunks = [];
        for (;;) {
            received();
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            chunks.push(value);
        }
        return new Uint8Array(await new Blob(chunks).arrayBuffer());
    } catch (e) {
        throw e instanceof DownloadError ? e : new DownloadError(e.message, { timedOut });
    } finally {
        clearTimeout(timer);
    }
}
