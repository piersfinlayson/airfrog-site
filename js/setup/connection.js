// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The connection's state and the login form.

import { card, field, h, link, message } from './dom.js';
import { CONNECTION } from '../messages.js';
import { RECOVERY } from '../urls.js';

export class ConnectionView {
    /** @param {import('../session.js').Session} session */
    constructor(session) {
        this.status = message();
        this.statusCard = h('section', { class: 'card' }, this.status);
        this.status.say(CONNECTION.CONNECTING);

        this.loginMsg = message();
        this.logIn = h('button', { class: 'primary', disabled: true }, CONNECTION.LOG_IN);
        this.password = h('input', { name: 'password', type: 'password', autocomplete: 'current-password',
            required: true, oninput: () => { this.logIn.disabled = !this.password.value; } });
        this.form = h('form', {
            onsubmit: (event) => {
                event.preventDefault();
                const password = this.password.value;
                this.password.value = '';
                this.logIn.disabled = true;
                this.loginMsg.say(CONNECTION.LOGGING_IN);
                session.login(password);
            },
        }, field(CONNECTION.PASSWORD, this.password),
        h('div', { class: 'row' }, this.logIn), this.loginMsg,
        h('p', { class: 'note' }, CONNECTION.FORGOTTEN,
            link(RECOVERY, RECOVERY.replace(/^https:\/\//, ''), { newTab: true })));
        this.login = card(CONNECTION.LOG_IN, null, this.form);
        this.login.hidden = true;
        this.element = h('div', {}, this.statusCard, this.login);
    }

    /** @param {{state: string, message: string|null, expected?: boolean}} status - the session's */
    update({ state, message: text, expected }) {
        this.login.hidden = state !== 'password';
        if (state === 'password') {
            this.statusCard.hidden = true;
            this.loginMsg.say(text ?? '', text ? 'bad' : '');
            this.password.focus?.();
            return;
        }
        this.statusCard.hidden = state === 'connected';
        // A retry connects with the failure's message, in the same colour.
        const bad = Boolean(text) && (state === 'waiting' || state === 'connecting') && !expected;
        this.status.say(text ?? (state === 'connecting' ? CONNECTION.CONNECTING : ''), bad ? 'bad' : '');
    }
}
