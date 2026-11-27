// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Airfrog's internal JS setup module. Airfrog's firmware serves it at
// /setup.js, and each release publishes the same file. Airfrog's setup is
// this module's Page alone, Airfrog's full user interface imports the copy
// its Airfrog serves, and airfrog.org/commissioning imports the copy of the
// release Airfrog runs.

import { CSS } from './style.js';
import { Page } from './page.js';
import { Setup } from './setup.js';
import { h, link } from './dom.js';
import { nameModel } from './format.js';

export { CSS } from './style.js';
export { Page } from './page.js';
export { Setup } from './setup.js';
export { Session } from './session.js';
export { ClosedError, HelloTimeoutError, SerialClient, SerialTransport, TimeoutError } from './serial.js';
export * as format from './format.js';
export * as dom from './dom.js';

/** This module's interface version. A change that callers can't handle raises it. */
export const API = 3;

/** Adds the setup's stylesheet to the document, once. */
export function addStyle() {
    if (!document.getElementById('airfrog-setup-style')) {
        document.head.append(h('style', { id: 'airfrog-setup-style' }, CSS));
    }
}

/**
 * Replaces the page with Airfrog's setup and connects.
 * @param {{reason?: string|null, tab?: string|null, firmware?: object|null, firmwareError?: string|null,
 *          model?: {value: number, name: string}|null}} options -
 *        why Airfrog's full user interface didn't load, the tab to open, the
 *        verified firmware manifest or why there isn't one, and the model the
 *        firmware was built for
 */
export function localPage({ reason = null, tab = null, firmware = null, firmwareError = null, model = null } = {}) {
    if (model) {
        nameModel(model.value, model.name);
    }
    addStyle();
    const page = new Page({ reason, tab, firmware, firmwareError });
    page.start(document.body);
    return page;
}

/**
 * Airfrog's setup over serial, as cards appended to container. Reads every
 * setting first.
 * @param {HTMLElement} container
 * @param {import('./serial.js').SerialTransport} transport
 * @param {{onRender?: function(object)}} [options]
 * @returns {Promise<Setup>}
 */
export async function mountSerial(container, transport, { onRender } = {}) {
    addStyle();
    const setup = new Setup({ transport, onRender });
    const v = setup.views;
    container.replaceChildren(v.wifi.element, v.join.element, v.hostname.element, v.password.element,
        v.websites.element, v.targetSettings.element, v.about.element);
    await setup.readAll();
    return setup;
}
