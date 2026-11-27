// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Airfrog's home page over the WebSocket: the header, the tabs, the
// connection and login, and the Network, System and Advanced tabs. Airfrog's
// setup is this page alone. Airfrog's full user interface adds its Target tab
// in front and its engineering detail to Advanced.

import { Session } from './session.js';
import { Setup } from './setup.js';
import { Header } from './header.js';
import { ConnectionView } from './connection.js';
import { h, link, message } from './dom.js';
import { errorText, Interface, overAp, StaState } from './protocol.js';
import { FirstSetupView } from './system.js';
import { versionText } from './format.js';
import { AIRFROG_TLD } from '../urls.js';
import { AIRFROG, FULL_UI_NOT_LOADED, HOME_PAGE, PAGE, PASSWORD, SETTINGS } from '../messages.js';

/**
 * @typedef {object} Tab
 * @property {string} id - also the URL's hash for the tab, when recorded
 * @property {string} name
 * @property {HTMLElement} element
 */

export class Page {
    /**
     * @param {object} options
     * @param {object|null} [options.firmware] - the verified firmware manifest
     * @param {string|null} [options.firmwareError] - why there isn't one
     * @param {Array<Tab>} [options.tabs] - tabs before Network
     * @param {Array<Node>} [options.advanced] - engineering detail at the
     *        start of the Advanced tab, before the target settings
     * @param {Array<Node|string>} [options.footer]
     * @param {string|null} [options.reason] - why Airfrog's full user
     *        interface didn't load, for Airfrog's setup
     * @param {string|null} [options.tab] - the tab to open
     * @param {boolean} [options.recordTab] - whether the URL's hash records
     *        the tab
     * @param {function(object)} [options.onRender] - called after each redraw
     *        with the state
     * @param {Session} [options.session]
     */
    constructor({ firmware = null, firmwareError = null, tabs = [], advanced = [], footer = [],
        reason = null, tab = null, recordTab = false, onRender = () => {}, session } = {}) {
        this.session = session ?? new Session(location.host);
        this.recordTab = recordTab;
        this.onRender = onRender;
        this.header = new Header(location.hostname || AIRFROG);
        this.setup = new Setup({ session: this.session, firmware, firmwareError,
            onRender: (s) => this.#rendered(s) });
        this.connection = new ConnectionView(this.session);
        this.readMsg = message();
        const v = this.setup.views;
        this.panes = Object.fromEntries([...tabs.map(t => [t.id, t.element]),
            ['network', h('div', {}, v.wifi.element, v.join.element, v.hostname.element, v.wifiAp.element)],
            ['system', h('div', {}, v.about.element, v.firmware.element, v.password.element, v.websites.element)],
            ['advanced', h('div', {}, ...advanced, v.targetSettings.element)]]);
        const names = [...tabs.map(t => [t.id, t.name]), ['network', PAGE.NETWORK_TAB], ['system', PAGE.SYSTEM_TAB],
            ['advanced', PAGE.ADVANCED_TAB]];
        this.tabButtons = Object.fromEntries(names.map(([id, name]) => [id,
            h('button', { type: 'button', role: 'tab', onclick: () => this.show(id, true) }, name)]));
        this.tabs = h('nav', { class: 'tabs', role: 'tablist', hidden: true },
            h('div', { class: 'in' }, ...Object.values(this.tabButtons)));
        this.content = h('div', { class: 'content', hidden: true }, this.readMsg, ...Object.values(this.panes));
        // Hidden while Airfrog is in AP mode and not on a network: the
        // browser can't reach airfrog.org, and setup is what the owner came
        // for.
        // HELLO's interface, from the login card or the open connection
        this.via = null;
        // Airfrog's setup alone, over the access point: the full user
        // interface doesn't load there.
        this.accessPoint = tabs.length ? null : h('section', { class: 'card', id: 'access-point', role: 'status',
            hidden: true }, HOME_PAGE.ACCESS_POINT);
        this.reason = reason ? h('section', { class: 'card warn', id: 'reason', role: 'status', hidden: true },
            `${FULL_UI_NOT_LOADED} ${reason}`) : null;
        this.noPassword = h('section', { class: 'card warn', role: 'status', hidden: true }, `${PASSWORD.NOT_SET} `,
            h('a', { href: '#system', onclick: (e) => { e.preventDefault(); this.show('system', true);
                v.password.element.scrollIntoView?.(); } }, PASSWORD.SET_PASSWORD));
        this.footerVersion = h('span', {}, AIRFROG);
        this.element = h('div', {}, this.header.element, this.tabs,
            h('main', {}, this.accessPoint, this.reason, this.noPassword, v.wifi.joined, this.connection.element, v.firstSetup.element,
                this.content),
            h('footer', {}, this.footerVersion, ' · ',
                link(AIRFROG_TLD, new URL(AIRFROG_TLD).host, { newTab: true }), ' · ', PAGE.FROM, ' ',
                link('https://piers.rocks', 'piers.rocks', { newTab: true }), ...footer));
        const fromHash = recordTab ? names.find(([id]) => `#${id}` === location.hash)?.[0] : null;
        this.show(this.setup.updateResult ? 'system' : tab ?? fromHash ?? names[0][0], Boolean(this.setup.updateResult));
    }

    /** The state read from Airfrog. */
    get state() {
        return this.setup.state;
    }

    /** Replaces body's contents with the page and connects. */
    start(body = document.body) {
        body.replaceChildren(this.element);
        document.title = this.header.title;
        this.session.addEventListener('status', (e) => this.#status(e.detail));
        this.session.addEventListener('connected', () => this.#connected());
        this.session.addEventListener('target', (e) => this.#target(e.detail));
        this.session.start();
    }

    /** Displays a tab, and records it in the URL when asked. */
    show(tab, record = false) {
        for (const [id, pane] of Object.entries(this.panes)) {
            pane.hidden = id !== tab;
            this.tabButtons[id].setAttribute('aria-selected', String(id === tab));
        }
        if (record && this.recordTab) {
            history.replaceState?.(null, '', `#${tab}`);
        }
    }

    render() {
        this.setup.render();
    }

    #rendered(state) {
        this.content.inert = !state.connected;
        const first = FirstSetupView.shown(state);
        this.tabs.hidden = first || !this.opened;
        this.content.hidden = first || !this.opened;
        const ap = overAp(this.via);
        if (this.accessPoint) {
            this.accessPoint.hidden = !ap;
            const notice = this.via === Interface.AP_BUTTON
                ? `${HOME_PAGE.ACCESS_POINT} ${HOME_PAGE.ACCESS_POINT_BUTTON}` : HOME_PAGE.ACCESS_POINT;
            // Replaced only when it changes, so that it is announced once.
            if (this.accessPoint.textContent !== notice) {
                this.accessPoint.textContent = notice;
            }
        }
        if (this.reason) {
            this.reason.hidden = ap || !state.ap || (state.ap.on && state.sta?.state !== StaState.CONNECTED);
        }
        this.header.update(state);
        document.title = this.header.title;
        this.noPassword.hidden = !state.connected || state.hasPassword || first;
        this.footerVersion.textContent = state.fw
            ? PAGE.FOOTER_VERSION(versionText(state.fw.version, state.fw.commit)) : AIRFROG;
        this.onRender(state);
    }

    #status(status) {
        this.via = status.via ?? this.via;
        this.connection.update(status);
        this.state.connected = status.state === 'connected';
        this.render();
    }

    async #connected() {
        const airfrog = this.session.airfrog;
        this.state.target = airfrog.getTarget();
        this.state.hasPassword = this.session.hasPassword;
        this.state.interface = airfrog.getInterface();
        this.via = this.state.interface;
        this.state.releaseKeys = airfrog.getReleaseKeys();
        this.state.connected = true;
        this.opened = true;
        this.render();
        try {
            await this.setup.readAll();
            this.readMsg.say('');
        } catch (e) {
            if (!airfrog.isClosed()) {
                this.readMsg.say(`${SETTINGS.READ_FAILED} ${errorText(e)}`, 'bad');
            }
        }
        this.render();
    }

    async #target(target) {
        this.state.target = target;
        this.render();
        if (target.identified()) {
            try {
                await this.setup.reload('pinMap');
            } catch (e) {
                // The connection closed. The next one reads the pin map.
            }
        }
    }
}
