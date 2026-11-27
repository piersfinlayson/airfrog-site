// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The connection's state, the login form and, over the access point started
// with the recovery button, the form that replaces a forgotten password.

import { card, editable, field, h, link, message } from './dom.js';
import { Interface, overAp } from './protocol.js';
import { newPasswordFields, showPasswordErrors } from './system.js';
import { checkNewPassword } from './validate.js';
import { CONNECTION, SETTINGS } from '../messages.js';
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
        this.forgotten = h('p', { class: 'note' }, CONNECTION.FORGOTTEN,
            link(RECOVERY, RECOVERY.replace(/^https:\/\//, ''), { newTab: true }));
        // Over the access point the recovery page doesn't load.
        this.forgottenAp = h('p', { class: 'note', hidden: true }, CONNECTION.FORGOTTEN_AP);
        this.resetMsg = message();
        this.reset = editable(h('form', { onsubmit: (event) => {
            event.preventDefault();
            const f = this.reset.elements;
            if (!showPasswordErrors(this.reset, this.resetMsg, checkNewPassword(f.password.value, f.repeat.value))) {
                return;
            }
            const password = f.password.value;
            f.password.value = '';
            f.repeat.value = '';
            this.reset.refresh();
            session.resetPassword(password);
        } }, h('hr', { class: 'sep' }), h('h3', {}, CONNECTION.RESET_PASSWORD), ...newPasswordFields(),
        h('div', { class: 'row' }, h('button', { class: 'primary' }, SETTINGS.SAVE)), this.resetMsg),
        (f) => f.elements.password.value !== '' && f.elements.repeat.value !== '');
        this.reset.hidden = true;
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
        h('div', { class: 'row' }, this.logIn), this.loginMsg, this.forgotten, this.forgottenAp);
        this.login = card(CONNECTION.LOG_IN, null, this.form, this.reset);
        this.login.hidden = true;
        this.element = h('div', {}, this.statusCard, this.login);
    }

    /** @param {{state: string, message: string|null, expected?: boolean, via?: number|null}} status - the session's */
    update({ state, message: text, expected, via = null }) {
        this.login.hidden = state !== 'password';
        if (state === 'password') {
            const button = via === Interface.AP_BUTTON;
            this.statusCard.hidden = true;
            this.loginMsg.say(text ?? '', text ? (expected ? 'ok' : 'bad') : '');
            this.forgotten.hidden = button || overAp(via);
            this.forgottenAp.hidden = button || !overAp(via);
            this.reset.hidden = !button;
            this.password.focus?.();
            return;
        }
        this.statusCard.hidden = state === 'connected';
        // A retry connects with the failure's message, in the same colour.
        const bad = Boolean(text) && (state === 'waiting' || state === 'connecting' || state === 'failed')
            && !expected;
        this.status.say(text ?? (state === 'connecting' ? CONNECTION.CONNECTING : ''), bad ? 'bad' : '');
    }
}
