// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Airfrog's full user interface: Airfrog's internal JS setup module's page
// with the Target tab in front, holding the Target card, the target's details
// and pins added to the Advanced tab, the Extensions tab last and each
// extension UI tab before Target.

import { h } from '../../js/setup/dom.js';
import { TargetCard, TargetView } from './ui/target.js';
import { PinsView } from './ui/pins.js';
import { versionText } from './names.js';
import { ExtensionsTab } from './extensions/tab.js';
import { ExtensionPane } from './extensions/pane.js';
import { Airfrog } from '../../js/airfrog.js';
import { AirfrogError, AwpSocket } from '../../js/awp.js';
import { EXTENSIONS, PAGE } from '../../js/messages.js';

/** An extension UI tab's id, which is also its URL hash. */
export function extensionTabId(name) {
    return `ext-${name}`;
}

export class FullUi {
    /**
     * @param {object} options
     * @param {object} options.setup - Airfrog's internal JS setup module, as Airfrog serves it
     * @param {object|null} [options.firmware] - the verified firmware manifest
     * @param {string|null} [options.firmwareError] - why there isn't one
     * @param {function(): Promise<object>} [options.loadFirmware] - loads the
     *        firmware manifest to check a chosen firmware file
     * @param {function(): Promise<{url: string, manifest: object}>} options.loadExtensions -
     *        loads and verifies the extensions manifest
     * @param {string|null} options.extensionsUrl - the extensions manifest's
     *        address, or null when the Airfrog manifest didn't load
     * @param {object} [options.session]
     * @param {string} [options.version] - this full user interface's version
     */
    constructor({ setup, firmware = null, firmwareError = null, loadFirmware = null,
        loadExtensions, extensionsUrl, session, version }) {
        // The password the session's open connection logged in with opens
        // each extension UI's connection. It is forgotten when that
        // connection closes, so a changed password isn't tried until the
        // session logs in again.
        this.login = null;
        session ??= new setup.Session(location.host, { connect: async (host, password) => {
            const airfrog = await Airfrog.connect(host, password);
            this.login = { host, password, airfrog };
            airfrog.addEventListener('close', () => {
                if (this.login?.airfrog === airfrog) {
                    this.login = null;
                }
            });
            return airfrog;
        } });
        this.targetCard = new TargetCard(this);
        this.targetView = new TargetView();
        this.pinsView = new PinsView();
        this.page = new setup.Page({
            firmware, firmwareError, loadFirmware, session,
            tabs: [{ id: 'target', name: PAGE.TARGET_TAB, element: h('div', {}, this.targetCard.element) }],
            advanced: [this.targetView.element, this.pinsView.element],
            recordTab: true,
            onRender: () => this.#rendered(),
        });
        if (version) {
            this.page.setup.views.about.setUiVersion?.(versionText(version));
        }
        /** @type {Map<string, ExtensionPane>} */
        this.extensionPanes = new Map();
        this.extensions = this.#addExtensions(loadExtensions, extensionsUrl);
    }

    #addExtensions(loadExtensions, extensionsUrl) {
        const page = this.page;
        const extensions = new ExtensionsTab({
            airfrog: () => this.session.airfrog,
            state: () => this.state,
            loadExtensions,
            extensionsUrl,
            onChange: (installed) => this.#extensionTabs(installed),
            onUpdated: (name) => this.extensionPanes.get(name)?.reload(),
            open: (name) => page.show(extensionTabId(name), true),
        });
        this.#addTab('extensions', EXTENSIONS.TAB, extensions.element);
        // Page.show() is wrapped to call each extension pane's shown() or
        // hidden().
        const show = page.show.bind(page);
        page.show = (id, record) => {
            show(id, record);
            for (const [name, pane] of this.extensionPanes) {
                if (id === extensionTabId(name)) {
                    pane.shown();
                } else {
                    pane.hidden();
                }
            }
            if (id === 'extensions') {
                extensions.shown();
            }
        };
        window.addEventListener('message', (event) => {
            for (const pane of this.extensionPanes.values()) {
                pane.receive(event);
            }
        });
        let connections = 0;
        this.session.addEventListener('connected', async () => {
            connections += 1;
            await extensions.refresh();
            // The URL's hash can record an extension UI tab, which exists
            // once the extensions are read.
            if (connections === 1 && this.page.panes[location.hash.slice(1)] && location.hash.startsWith('#ext-')) {
                page.show(location.hash.slice(1));
            }
            if (connections > 1) {
                for (const pane of this.extensionPanes.values()) {
                    pane.reload();
                }
            }
        });
        if (location.hash === '#extensions') {
            page.show('extensions');
        }
        return extensions;
    }

    /** Adds a tab after Advanced, or before beforeId. */
    #addTab(id, name, element, beforeId = null) {
        const page = this.page;
        page.panes[id] = element;
        element.hidden = true;
        page.tabButtons[id] = h('button', { type: 'button', role: 'tab', 'aria-selected': 'false',
            onclick: () => page.show(id, true) }, name);
        page.tabs.firstChild.insertBefore(page.tabButtons[id], beforeId ? page.tabButtons[beforeId] : null);
        page.content.append(element);
    }

    #removeTab(id) {
        const page = this.page;
        const shown = !page.panes[id].hidden;
        page.panes[id].remove();
        page.tabButtons[id].remove();
        delete page.panes[id];
        delete page.tabButtons[id];
        if (shown) {
            page.show('extensions', true);
        }
    }

    /**
     * Makes the extension UI tabs match the installed extensions: one for
     * each with a UI, in list order, with its button displayed while its
     * Tab checkbox is ticked.
     */
    #extensionTabs(installed) {
        const withUi = installed.filter(x => x.ui);
        for (const name of [...this.extensionPanes.keys()]) {
            if (!withUi.some(x => x.name === name)) {
                this.extensionPanes.get(name).destroy();
                this.extensionPanes.delete(name);
                this.#removeTab(extensionTabId(name));
            }
        }
        for (const x of withUi) {
            const id = extensionTabId(x.name);
            let pane = this.extensionPanes.get(x.name);
            if (pane) {
                pane.update(x.displayName, x.ui);
                this.page.tabButtons[id].textContent = x.displayName;
            } else {
                pane = new ExtensionPane({ name: x.name, displayName: x.displayName, ui: x.ui,
                    open: () => this.#openSocket() });
                this.extensionPanes.set(x.name, pane);
                this.#addTab(id, x.displayName, pane.element, 'target');
            }
            const tabButton = this.page.tabButtons[id];
            tabButton.hidden = !x.tab;
            this.page.tabs.firstChild.insertBefore(tabButton, this.page.tabButtons.target);
        }
    }

    /** A new logged-in connection for an extension UI. */
    #openSocket() {
        if (!this.login || this.login.airfrog.isClosed()) {
            return Promise.reject(new AirfrogError('CLOSED'));
        }
        return AwpSocket.open(this.login.host, this.login.password);
    }

    get session() {
        return this.page.session;
    }

    get state() {
        return this.page.state;
    }

    /** Replaces body's contents with the page and connects. */
    start(body = document.body) {
        this.page.start(body);
    }

    render() {
        this.page.render();
    }

    /** Whether the Target card has an operation on the target running. */
    targetBusy() {
        return Boolean(this.targetCard.busy);
    }

    #rendered() {
        this.targetCard.update(this.state);
        this.targetView.update(this.state);
        this.pinsView.update(this.state);
    }
}
