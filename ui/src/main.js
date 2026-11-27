// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Airfrog's full user interface. Airfrog's home page loads it from the UI
// manifest and calls start() once.
// Its connection, Network and System tabs and target settings are Airfrog's
// internal JS setup module, which Airfrog serves at /setup.js, so they are
// always the firmware's own.

import { startBridge } from '../../js/bridge.js';
import { checkHello } from './firmware-check.js';
import { FullUi } from './full-ui.js';
import { Manifests } from './manifests.js';
import { UI_CSS } from './style.js';
import { h } from '../../js/setup/dom.js';
import { AIRFROG, HOME_PAGE } from '../../js/messages.js';

/** This full user interface's version, set by ci/build-ui.sh. */
const VERSION = typeof __UI_VERSION__ === 'string' ? __UI_VERSION__ : undefined;

/** The oldest interface of Airfrog's internal JS setup module this runs with. */
const SETUP_API = 3;

/**
 * Replaces the page with Airfrog's full user interface. With #bridge=ORIGIN
 * in the URL the page is the bridge window for that site and does nothing
 * else. Otherwise the firmware manifest is loaded before the page is built.
 */
export async function start({}) {
    // A Blob URL doesn't resolve /setup.js, so the page's URL is the base.
    const setup = await import(new URL('/setup.js', location.href).href);
    if (!(setup.API >= SETUP_API)) {
        const error = new Error(HOME_PAGE.NEWER_FIRMWARE);
        error.tab = 'system';
        throw error;
    }
    setup.addStyle();
    document.head.append(h('style', {}, UI_CSS));
    if (location.hash.startsWith('#bridge=')) {
        document.title = location.hostname;
        const container = h('section', { class: 'card' });
        document.body.replaceChildren(h('div', { class: 'bar' }, h('div', { class: 'bar-in' },
            h('img', { src: '/logo.png', alt: AIRFROG }), h('div', { class: 'host' }, location.hostname))),
        h('main', {}, container));
        await startBridge(container, { checkHello });
        return;
    }
    const manifests = new Manifests();
    let firmware = null;
    let firmwareError = null;
    try {
        firmware = await manifests.firmware();
    } catch (e) {
        firmwareError = e.message;
    }
    new FullUi({
        setup, firmware, firmwareError,
        loadExtensions: () => manifests.extensions(), extensionsUrl: manifests.extensionsUrl,
        fullAccess: () => manifests.fullAccessWebsites, version: VERSION,
    }).start();
}
