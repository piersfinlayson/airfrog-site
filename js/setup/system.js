// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The System tab: Airfrog's hardware, its firmware with the update and
// restart, the password and the authorised websites.

import {
    button, card, editable, field, fileChooser, h, input, message, prompt, rows, showErrors, showRow,
} from './dom.js';
import { MODELS, mcuText, sizeText, modelName, versionText } from './format.js';
import { Command, RestartMode, encodeAuthorisedWebsite, encodeRestart, errorText } from './protocol.js';
import {
    ABOUT, AUTHORISED_WEBSITES, PASSWORD, RECONNECT, RECONNECTING, RESTART, SETTINGS, UI_VERSION_ROW, UPDATE, VALUES,
} from '../messages.js';
import { siteName } from '../awp.js';
import { ERROR_EXISTS, ERROR_NO_ENTRY } from '../schema.js';
import { FIRMWARE_UPDATE_IMAGE } from '../urls.js';
import { checkFirmwareManifest } from './releases.js';
import { checkNewPassword, checkWebsite } from './validate.js';
import {
    checkFirmwareFile, describeResult, downloadFirmware, firmwareRelease, imageVersion, inFirmwareManifest, keepResult,
    runUpdate,
} from './update.js';

/** The New firmware file tooltip for a model's key, for example "mini". */
function fileHelp(key) {
    return UPDATE.FILE_HELP(FIRMWARE_UPDATE_IMAGE.split('/').pop().replace('{model}', key));
}

export class FirmwareView {
    /** @param {object|null} result - an update's result, kept while the page reloaded */
    constructor(setup, result) {
        this.setup = setup;
        this.result = result;
        this.rows = rows([['version', UPDATE.VERSION_ROW]]);
        this.release = null;
        this.offerButton = button('', () => this.updateFromRelease(), { class: 'primary', id: 'firmware-offer' });
        this.notes = h('a', { target: '_blank', rel: 'noopener' }, UPDATE.RELEASE_NOTES);
        this.offerRow = h('div', { class: 'row actions', hidden: true }, this.offerButton, this.notes);
        this.chooser = fileChooser(() => this.checkFile());
        this.file = this.chooser.input;
        // The chosen file once checked: its image and version, or null.
        this.checked = null;
        this.fileCheck = h('span', { class: 'file-check', role: 'status' });
        this.fileButton = button(UPDATE.UPDATE, () => this.updateFromFile(), { disabled: true });
        this.progress = h('progress', { max: 1, value: 0, hidden: true });
        this.msg = message();
        this.msg.id = 'firmware-msg';
        this.rows.values.version.id = 'firmware-version';
        this.fileField = field(UPDATE.FILE,
            h('div', { class: 'row' }, this.chooser.element, this.fileCheck, this.fileButton), fileHelp(''));
        // update() fills the tooltip once Airfrog's model is read.
        this.fileField.querySelector('.tip').hidden = true;
        this.airfrog = null;
        this.restarting = false;
        this.restartMsg = message();
        this.restartConfirm = prompt();
        this.restartButton = button(RESTART.BUTTON, () => this.restartConfirm.ask(RESTART.CONFIRM, RESTART.BUTTON,
            () => this.restart()), { id: 'restart' });
        this.element = card(UPDATE.TITLE, null, this.rows.element, this.offerRow, h('hr', { class: 'sep' }),
            h('h3', {}, UPDATE.UPDATE_FIRMWARE), this.fileField, this.progress, this.msg);
        // Displayed in the About card.
        this.restartElement = h('div', {}, h('hr', { class: 'sep' }), h('div', { class: 'row' }, this.restartButton),
            this.restartConfirm.element, this.restartMsg);
        if (result) {
            const { text, ok } = describeResult(result);
            this.msg.say(text, ok ? 'ok' : 'bad');
        }
    }

    update(s) {
        if (this.airfrog !== this.setup.link) {
            this.airfrog = this.setup.link;
            this.restarting = false;
            this.restartMsg.say('');
            this.restartConfirm.element.hidden = true;
        }
        // A model not released doesn't have firmware on airfrog.org.
        const key = s.hw ? MODELS[s.hw.model]?.key : null;
        const mark = this.fileField.querySelector('.tip');
        mark.hidden = !key;
        if (key) {
            mark.setAttribute('aria-label', fileHelp(key));
            mark.querySelector('.tip-box').textContent = fileHelp(key);
        }
        if (!s.fw) {
            return;
        }
        let note = this.setup.firmwareError ? `${UPDATE.LATEST_UNKNOWN} ${this.setup.firmwareError}` : null;
        try {
            this.release = s.hw ? firmwareRelease(this.setup.firmware, s.hw.model, s.fw.version) : null;
        } catch (e) {
            this.release = null;
            note = `${UPDATE.LATEST_UNKNOWN} ${e.message}`;
        }
        const offer = this.release?.offer;
        if (this.release?.latest) {
            note = UPDATE.LATEST;
        }
        this.rows.values.version.replaceChildren(versionText(s.fw.version, s.fw.commit),
            note ? h('div', { class: 'note' }, note) : '');
        this.offerRow.hidden = !offer;
        if (offer) {
            this.offerButton.textContent = UPDATE.UPDATE_TO(versionText(offer.version, offer.commit));
            this.notes.hidden = !offer.notes;
            this.notes.href = offer.notes ?? '';
        }
        const disabled = this.setup.updating || this.restarting || !s.connected;
        this.offerButton.disabled = disabled;
        this.fileButton.disabled = disabled || !this.checked;
        this.file.disabled = disabled;
        this.chooser.button.disabled = disabled;
        this.restartButton.disabled = disabled;
        if (this.setup.updating) {
            this.restartConfirm.element.hidden = true;
        }
    }

    // Once the claim is released, or after RESTART's timeout, Airfrog closes
    // the connection with 1001 and restarts. The session then reconnects.
    async restart() {
        this.restarting = true;
        this.setup.render();
        this.restartMsg.say(RESTART.PROGRESS);
        this.setup.expectClose({ message: RECONNECT.RESTARTING });
        try {
            await this.setup.command(Command.RESTART, encodeRestart(RestartMode.GRACEFUL));
        } catch (e) {
            this.setup.cancelExpected();
            this.restarting = false;
            this.setup.render();
            this.restartMsg.say(`${RESTART.FAILED} ${errorText(e)}`, 'bad');
        }
    }

    async updateFromRelease() {
        const offer = this.release.offer;
        this.setup.setUpdating(true);
        this.msg.say(UPDATE.DOWNLOADING(versionText(offer.version, offer.commit)));
        let image;
        try {
            image = await downloadFirmware(offer);
        } catch (e) {
            this.msg.say(e.message, 'bad');
            this.setup.setUpdating(false);
            return;
        }
        // The version written is the image's own.
        const version = imageVersion(image) ?? offer.version;
        await this.run(image, version, version.replace(/^v/, '') === offer.version.replace(/^v/, '') ? offer.commit : '');
    }

    /**
     * Checks the chosen file as soon as it is chosen: a spinner while it
     * checks, then a tick, or a cross with the reason. A file that isn't in
     * the firmware manifest is marked unsigned and can still be installed.
     * When Airfrog's setup started without the firmware manifest, the
     * manifest is loaded first. Without one, a file isn't marked unsigned.
     */
    async checkFile() {
        this.checked = null;
        this.msg.say('');
        const file = this.file.files?.[0];
        const mark = (cls, label, text = '', tone = '') => this.fileCheck.replaceChildren(
            h('span', { class: cls, role: 'img', 'aria-label': label }), text ? h('span', { class: tone }, text) : '');
        if (!file) {
            this.fileCheck.replaceChildren();
            this.setup.render();
            return;
        }
        mark('spinner', UPDATE.CHECKING);
        this.setup.render();
        const image = new Uint8Array(await file.arrayBuffer());
        if (file !== this.file.files?.[0]) {
            return;
        }
        const { version, error } = this.setup.state.hw ? checkFirmwareFile(image, this.setup.state.hw.model)
            : { version: null, error: UPDATE.INVALID_FILE };
        const firmware = error ? null : await this.signedReleases();
        if (file !== this.file.files?.[0]) {
            return;
        }
        if (error) {
            mark('cross', UPDATE.NOT_VALID, error, 'bad');
        } else if (firmware && !inFirmwareManifest(firmware, image)) {
            this.checked = { image, version };
            mark('tick', UPDATE.VALID, UPDATE.UNSIGNED, 'warn');
        } else {
            this.checked = { image, version };
            mark('tick', UPDATE.VALID);
        }
        this.setup.render();
    }

    /**
     * The firmware manifest, loaded when Airfrog's setup started without
     * one, or null when it can't be loaded.
     */
    async signedReleases() {
        if (this.setup.firmware || !this.setup.loadFirmware) {
            return this.setup.firmware;
        }
        this.loaded ??= this.setup.loadFirmware().then(checkFirmwareManifest).catch((e) => {
            console.debug(`Firmware manifest: ${e.message}`);
            this.loaded = null;
            return null;
        });
        return this.loaded;
    }

    async updateFromFile() {
        const { image, version } = this.checked;
        await this.run(image, version, '');
    }

    async run(image, version, commit) {
        this.setup.setUpdating(true);
        this.progress.value = 0;
        this.progress.hidden = false;
        let result;
        try {
            result = await runUpdate({
                session: this.setup.session, image, version, commit, previous: this.setup.state.fw,
                onPhase: (text) => this.msg.say(text),
                onProgress: (fraction) => { this.progress.value = fraction; },
            });
        } catch (e) {
            this.msg.say(`${UPDATE.FAILED} ${errorText(e)}`, 'bad');
            this.progress.hidden = true;
            this.setup.setUpdating(false);
            return;
        }
        // The new firmware's home page loads, then displays the result.
        if (keepResult(result)) {
            this.msg.say(UPDATE.RELOADING);
            this.setup.reloadPage();
            return;
        }
        const { text, ok } = describeResult(result);
        this.msg.say(text, ok ? 'ok' : 'bad');
        this.progress.hidden = true;
        this.setup.setUpdating(false);
    }
}

export class PasswordView {
    constructor(setup) {
        this.setup = setup;
        this.airfrog = null;
        this.msg = message();
        this.state = h('div', { class: 'note' });
        this.set = h('button', { class: 'primary' }, PASSWORD.SET_PASSWORD);
        this.confirm = prompt();
        this.remove = button(PASSWORD.REMOVE_PASSWORD, () => this.confirm.ask(
            PASSWORD.CONFIRM_REMOVE, PASSWORD.REMOVE,
            () => this.form.run(() => this.setPassword('')), { danger: true }), { class: 'danger' });
        this.form = editable(h('form', { onsubmit: (e) => { e.preventDefault(); this.form.run(() => this.save()); } },
            this.state,
            field(PASSWORD.NEW_PASSWORD, input('password', { type: 'password', autocomplete: 'new-password' })),
            field(PASSWORD.CONFIRM_PASSWORD, input('repeat', { type: 'password', autocomplete: 'new-password' })),
            h('div', { class: 'row' }, this.set, this.remove), this.confirm.element, this.msg),
        (f) => f.elements.password.value !== '' && f.elements.repeat.value !== '');
        this.element = card(PASSWORD.TITLE, null, this.form);
    }

    update({ hasPassword }) {
        if (this.airfrog !== this.setup.link) {
            this.airfrog = this.setup.link;
            this.msg.say('');
            this.confirm.element.hidden = true;
        }
        this.state.textContent = hasPassword ? PASSWORD.SET : PASSWORD.NOT_SET;
        this.set.textContent = hasPassword ? PASSWORD.CHANGE_PASSWORD : PASSWORD.SET_PASSWORD;
        this.remove.hidden = !hasPassword;
    }

    async save() {
        const f = this.form.elements;
        if (!showErrors(this.form, this.msg, checkNewPassword(f.password.value, f.repeat.value))) {
            return;
        }
        const password = f.password.value;
        f.password.value = '';
        f.repeat.value = '';
        this.form.refresh();
        await this.setPassword(password);
    }

    // On the WebSocket Airfrog closes every connection after SET_PASSWORD,
    // and the session logs in again with the new password.
    async setPassword(password) {
        const done = password ? PASSWORD.SET : PASSWORD.REMOVED;
        this.setup.expectClose({ message: `${done} ${RECONNECTING}`, password: password || null });
        this.msg.say(SETTINGS.SAVING);
        this.confirm.element.hidden = true;
        this.remove.disabled = true;
        try {
            await this.setup.setPassword(password);
        } catch (e) {
            this.setup.cancelExpected();
            this.msg.say(`${SETTINGS.SAVE_FAILED} ${errorText(e)}`, 'bad');
            return;
        } finally {
            this.remove.disabled = false;
        }
        if (!this.setup.closes) {
            this.msg.say(done, 'ok');
        }
    }
}

/** Whether e is ERROR code, which doesn't have its own AirfrogError code. */
function isError(e, code) {
    return e?.code === 'CODE' && e.detail === code;
}

/**
 * The authorised websites: one row each with Revoke, and a field to add one.
 * Airfrog checks a website against the list, so this card doesn't.
 */
export class AuthorisedWebsitesView {
    constructor(setup) {
        this.setup = setup;
        this.airfrog = null;
        this.msg = message();
        this.list = h('table', { class: 'websites' });
        this.none = h('div', { hidden: true }, h('p', { class: 'note' }, AUTHORISED_WEBSITES.NONE), h('hr', { class: 'sep' }));
        this.confirm = prompt();
        // The website Revoke's prompt asks about.
        this.asking = null;
        this.form = editable(h('form', { onsubmit: (e) => { e.preventDefault(); this.run(() => this.add()); } },
            field(AUTHORISED_WEBSITES.WEBSITE,
                Object.assign(input('website', { autocapitalize: 'off' }), { spellcheck: false })),
            h('div', { class: 'row' }, h('button', { class: 'primary' }, AUTHORISED_WEBSITES.ADD)), this.msg),
        (f) => f.elements.website.value.trim() !== '');
        this.element = card(AUTHORISED_WEBSITES.TITLE, AUTHORISED_WEBSITES.TIP, this.list, this.none,
            this.confirm.element, this.form);
        this.shown = null;
        this.busy = false;
    }

    /** Runs Add or Revoke with Add and every Revoke disabled, and the prompt closed. */
    async run(fn) {
        this.confirm.element.hidden = true;
        this.busy = true;
        this.list.querySelectorAll('button').forEach(b => { b.disabled = true; });
        try {
            await this.form.run(fn);
        } finally {
            this.busy = false;
            this.list.querySelectorAll('button').forEach(b => { b.disabled = false; });
        }
    }

    update({ websites }) {
        if (this.airfrog !== this.setup.link) {
            this.airfrog = this.setup.link;
            this.msg.say('');
            this.confirm.element.hidden = true;
        }
        if (!websites || websites === this.shown) {
            return;
        }
        this.shown = websites;
        if (!websites.includes(this.asking)) {
            this.confirm.element.hidden = true;
        }
        const revoke = (w) => button(AUTHORISED_WEBSITES.REVOKE, () => {
            this.asking = w;
            this.confirm.ask(AUTHORISED_WEBSITES.CONFIRM_REVOKE(siteName(w)), AUTHORISED_WEBSITES.REVOKE,
                () => this.run(() => this.revoke(w)), { danger: true });
        }, { class: 'danger', disabled: this.busy });
        this.list.replaceChildren(...websites.map(w => h('tr', {}, h('td', {}, siteName(w)),
            h('td', { class: 'acts' }, revoke(w)))));
        this.list.hidden = websites.length === 0;
        this.none.hidden = websites.length > 0;
    }

    async add() {
        const typed = this.form.elements.website.value.trim();
        const { errors, fields, website } = checkWebsite(typed);
        if (!showErrors(this.form, this.msg, errors)) {
            return;
        }
        this.msg.say(SETTINGS.SAVING);
        try {
            await this.setup.command(Command.ADD_AUTHORISED_WEBSITE, fields);
            this.form.elements.website.value = '';
            this.msg.say('');
        } catch (e) {
            if (e.code === 'NO_SPACE') {
                this.msg.say(AUTHORISED_WEBSITES.TOO_MANY, 'bad');
            } else if (isError(e, ERROR_EXISTS)) {
                this.msg.say(AUTHORISED_WEBSITES.EXISTS(siteName(website)), 'bad');
            } else if (e.code === 'OUT_OF_RANGE') {
                this.msg.say(AUTHORISED_WEBSITES.INVALID(typed), 'bad');
            } else {
                this.msg.say(`${SETTINGS.SAVE_FAILED} ${errorText(e)}`, 'bad');
            }
        }
        await this.read();
    }

    /** A website another client revoked first is gone from the list too, so isn't a failure. */
    async revoke(website) {
        this.msg.say(SETTINGS.SAVING);
        try {
            await this.setup.command(Command.REMOVE_AUTHORISED_WEBSITE, encodeAuthorisedWebsite(website));
            this.msg.say('');
        } catch (e) {
            if (isError(e, ERROR_NO_ENTRY)) {
                this.msg.say('');
            } else {
                this.msg.say(`${SETTINGS.SAVE_FAILED} ${errorText(e)}`, 'bad');
            }
        }
        await this.read();
    }

    /** Reads the list again, displaying a failure when there isn't one already. */
    async read() {
        try {
            await this.setup.reload('websites');
        } catch (e) {
            if (!this.msg.classList.contains('bad')) {
                this.msg.say(`${SETTINGS.READ_FAILED} ${errorText(e)}`, 'bad');
            }
        }
    }
}

export class AboutView {
    constructor() {
        this.rows = rows([['serial', ABOUT.SERIAL_NUMBER], ['model', ABOUT.MODEL], ['mcu', ABOUT.MCU],
            ['flash', ABOUT.FLASH], ['psram', ABOUT.PSRAM], ['ui', UI_VERSION_ROW]]);
        this.rows.values.serial.classList.add('mono');
        this.element = card(ABOUT.TITLE, null, this.rows.element);
        showRow(this.rows, 'ui', false);
    }

    /** Adds the Restart button and its messages below the rows. */
    addRestart(element) {
        this.element.append(element);
    }

    /** Displays the full user interface's version, when it is loaded. */
    setUiVersion(text) {
        this.rows.values.ui.textContent = text;
        showRow(this.rows, 'ui', true);
    }

    update({ hw }) {
        if (!hw) {
            return;
        }
        const v = this.rows.values;
        v.serial.textContent = hw.serial ?? VALUES.NONE;
        v.model.textContent = modelName(hw.model);
        v.mcu.textContent = mcuText(hw);
        v.flash.textContent = sizeText(hw.flash);
        v.psram.textContent = hw.psram ? sizeText(hw.psram) : VALUES.NONE;
        showRow(this.rows, 'psram', hw.psram > 0);
    }
}
