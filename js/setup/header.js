// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The dark bar at the top of Airfrog's home page.

import { h, setPill } from './dom.js';
import { ipv4, targetState, modelName, versionText } from './format.js';
import { StaState } from './protocol.js';
import { AIRFROG, PAGE } from '../messages.js';

export class Header {
    /**
     * @param {string} host - the host the page was loaded from, until the
     *        hostname is read
     */
    constructor(host) {
        this.host = h('div', { class: 'host' }, host);
        this.sub = h('div', { class: 'sub' });
        this.state = h('span', { class: 'pill', hidden: true });
        this.element = h('div', { class: 'bar' }, h('div', { class: 'bar-in' },
            h('img', { src: '/logo.png', alt: AIRFROG }),
            h('div', {}, this.host, this.sub),
            this.state));
    }

    /** The title, which is also the browser tab's. */
    get title() {
        return this.host.textContent;
    }

    /** @param {import('./setup.js').SetupState} s */
    update(s) {
        if (s.hostname) {
            this.host.textContent = `${s.hostname}.local`;
        }
        const ip = s.sta?.state === StaState.CONNECTED ? ipv4(s.sta.ipv4) : s.ap?.on ? ipv4(s.ap.ipv4) : null;
        const model = s.hw ? PAGE.MODEL(modelName(s.hw.model)) : null;
        // Each part wraps as a whole on a phone.
        const parts = [ip, model, s.fw ? PAGE.FIRMWARE(versionText(s.fw.version, s.fw.commit)) : null].filter(v => v);
        this.sub.replaceChildren(...parts.flatMap((p, i) => [i ? ' · ' : '', h('span', { class: 'part' }, p)]));
        if (s.target && s.connected) {
            const { text, ok } = targetState(s.target);
            setPill(this.state, text, ok ? 'ok' : s.target.identified() ? '' : 'warn');
        } else {
            setPill(this.state, null);
        }
    }
}
