// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// airfrog.org/web. Displays an Airfrog's home page in a frame, loaded from the
// Airfrog's own address. An address a frame can't load, or a browser without
// Chrome's local network permission, opens the address in this tab instead.

import { CONNECT_TIMEOUT_MS } from '../js/awp.js';
import { COMMISSIONING_CONNECT, CONNECTION, WEB } from '../js/messages.js';
import { button, field, h, input, link, message } from '../js/setup/dom.js';
import { frameable, parseAddress } from './address.js';

const STORAGE_KEY = 'airfrog-web-address';
// The sandbox of ui/src/extensions/pane.js, which isn't published.
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox '
    + 'allow-downloads allow-modals';
const ALLOW = 'local-network-access; local-network; loopback-network';

const root = document.getElementById('web');

function saved() {
    try {
        return localStorage.getItem(STORAGE_KEY);
    } catch (e) {
        return null;
    }
}

function save(address) {
    try {
        localStorage.setItem(STORAGE_KEY, address);
    } catch (e) {
        // Not saved
    }
}

/** The status of Chrome's local network permission, or null in a browser without it. */
async function permission() {
    for (const name of ['local-network', 'local-network-access']) {
        try {
            return await navigator.permissions.query({ name });
        } catch (e) {
            // The browser doesn't have this name.
        }
    }
    return null;
}

/**
 * Whether anything answers at the address. The fetch opens Chrome's permission
 * prompt. The time allowed doesn't run while the prompt is displayed.
 */
function probe(address, status) {
    return new Promise((resolve) => {
        const abort = new AbortController();
        let timer = null;
        const arm = () => {
            clearTimeout(timer);
            timer = status.state === 'prompt' ? null : setTimeout(() => abort.abort(), CONNECT_TIMEOUT_MS);
        };
        const done = (answered) => {
            clearTimeout(timer);
            status.removeEventListener('change', arm);
            resolve(answered);
        };
        status.addEventListener('change', arm);
        arm();
        fetch(`http://${address}/`, { mode: 'no-cors', cache: 'no-store', signal: abort.signal })
            .then(() => done(true), () => done(false));
    });
}

const addressField = input('address', { value: saved() ?? WEB.DEFAULT_ADDRESS, spellcheck: false, autocapitalize: 'off' });
const connectButton = h('button', { type: 'submit' }, COMMISSIONING_CONNECT.CONNECT);
const msg = message();
const form = h('form', { onsubmit: (e) => { e.preventDefault(); submit(); } },
    field(WEB.ADDRESS, addressField), h('div', { class: 'row' }, connectButton), msg);
addressField.addEventListener('input', () => addressField.removeAttribute('aria-invalid'));

function busy(on) {
    addressField.disabled = on;
    connectButton.disabled = on;
}

function showForm() {
    document.body.classList.remove('framed');
    busy(false);
    msg.say('');
    root.replaceChildren(form);
}

function showFrame(address) {
    const frame = h('iframe', { class: 'web-frame', src: `http://${address}/`, title: address });
    frame.setAttribute('sandbox', SANDBOX);
    frame.setAttribute('allow', ALLOW);
    document.body.classList.add('framed');
    root.replaceChildren(h('div', { class: 'web-bar' }, h('span', { class: 'host' }, address),
        button(WEB.CHANGE, showForm)), frame);
}

async function connect(address, status) {
    msg.say(CONNECTION.CONNECTING);
    if (await probe(address, status)) {
        save(address);
        showFrame(address);
        return;
    }
    busy(false);
    const failure = status.state === 'denied' ? WEB.BLOCKED(location.hostname) : WEB.NO_RESPONSE(address);
    msg.say([failure, ' ', link(`http://${address}/`, WEB.OPEN(address))], 'bad');
}

/** Connect, from the user's click or Enter. */
async function submit() {
    const address = parseAddress(addressField.value);
    if (!address) {
        addressField.setAttribute('aria-invalid', 'true');
        msg.say(CONNECTION.INVALID_ADDRESS(addressField.value.trim()), 'bad');
        return;
    }
    busy(true);
    const status = frameable(address) ? await permission() : null;
    if (status) {
        await connect(address, status);
    } else {
        save(address);
        busy(false);
        location.assign(`http://${address}/`);
    }
}

showForm();
const last = saved();
if (last && parseAddress(last) === last && frameable(last)) {
    busy(true);
    const status = await permission();
    if (status) {
        await connect(last, status);
    } else {
        busy(false);
    }
}
