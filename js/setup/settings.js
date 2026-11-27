// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The target settings: board, boot window, change checks and recovery.

import { boardName } from './format.js';
import { BOOT_WINDOW_AUTO, Command, recoveryAllowed } from './protocol.js';
import { checkSettings } from './validate.js';
import { card, changed, check, editable, field, h, input, message, showErrors } from './dom.js';
import { SETTINGS, TARGET_SETTINGS } from '../messages.js';

export class TargetSettingsView {
    constructor(setup) {
        this.setup = setup;
        this.airfrog = null;
        this.msg = message();
        this.board = h('select', { name: 'board', id: 'board' },
            h('option', { value: '0' }, TARGET_SETTINGS.AUTOMATIC));
        this.boards = null;
        this.bootWindowAuto = check('bootWindowAuto', TARGET_SETTINGS.AUTOMATIC, null, {
            onchange: () => { this.bootWindowMs.disabled = this.bootWindowAuto.box.checked; },
        });
        this.bootWindowMs = input('bootWindowMs', { inputMode: 'numeric' });
        this.recovery = check('recovery', TARGET_SETTINGS.RECOVERY, TARGET_SETTINGS.RECOVERY_TIP);
        this.recoveryNote = h('p', { class: 'note', hidden: true }, TARGET_SETTINGS.RECOVERY_NOT_HERE);
        this.form = editable(h('form', { onsubmit: (e) => { e.preventDefault(); this.form.run(() => this.save()); } },
            field(TARGET_SETTINGS.BOARD_TYPE, this.board, TARGET_SETTINGS.BOARD_TYPE_TIP),
            field(TARGET_SETTINGS.BOOT_WINDOW,
                h('div', { class: 'field' }, this.bootWindowMs, this.bootWindowAuto.element),
                TARGET_SETTINGS.BOOT_WINDOW_TIP),
            field(TARGET_SETTINGS.CHANGE_CHECK, input('changeCheckMs', { inputMode: 'numeric' }),
                TARGET_SETTINGS.CHANGE_CHECK_TIP),
            this.recovery.element, this.recoveryNote,
            h('div', { class: 'row' }, h('button', { class: 'primary' }, SETTINGS.SAVE)),
            this.msg), (f) => changed(f) && Boolean(this.setup.state.settings));
        this.element = card(TARGET_SETTINGS.TITLE, null, this.form);
    }

    /**
     * Whether this connection can't turn recovery on. Turning it off, and
     * leaving it on, are allowed on every connection.
     */
    recoveryRefused(on) {
        return on && !this.setup.state.settings?.recovery && !recoveryAllowed(this.setup.state.interface);
    }

    update({ settings, pinMap, boards }) {
        if (this.airfrog !== this.setup.link) {
            this.airfrog = this.setup.link;
            this.msg.say('');
        }
        const refused = this.recoveryRefused(true);
        this.recovery.box.disabled = refused;
        this.recoveryNote.hidden = !refused;
        if (!settings || !boards || this.form.dirty) {
            return;
        }
        const f = this.form.elements;
        if (boards !== this.boards) {
            this.boards = boards;
            this.board.replaceChildren(this.board.options[0],
                ...boards.map(b => h('option', { value: String(b.board) }, boardName(b.board, boards))));
        }
        if (![...this.board.options].some(o => o.value === String(settings.board))) {
            this.board.append(h('option', { value: String(settings.board) }, boardName(settings.board, boards)));
        }
        this.board.options[0].textContent = settings.board === 0 && pinMap?.board
            ? TARGET_SETTINGS.AUTOMATIC_BOARD(boardName(pinMap.board, boards)) : TARGET_SETTINGS.AUTOMATIC;
        this.board.value = String(settings.board);
        const auto = settings.bootWindowMs === BOOT_WINDOW_AUTO;
        this.bootWindowAuto.box.checked = auto;
        f.bootWindowMs.value = auto ? String(settings.bootWindowAutoMs ?? '') : String(settings.bootWindowMs);
        f.bootWindowMs.disabled = auto;
        f.changeCheckMs.value = String(settings.changeCheckMs);
        this.recovery.box.checked = settings.recovery;
        this.form.filled();
    }

    async save() {
        const f = this.form.elements;
        const { errors, fields } = checkSettings({ board: this.board.value,
            bootWindowAuto: this.bootWindowAuto.box.checked, bootWindowMs: f.bootWindowMs.value,
            changeCheckMs: f.changeCheckMs.value, flags: this.setup.state.settings?.flags, recovery: this.recovery.box.checked,
            wifiPowerSave: this.setup.state.settings?.wifiPowerSave, wifiRescanS: this.setup.state.settings?.wifiRescanS,
            wifiRescanDb: this.setup.state.settings?.wifiRescanDb });
        if (!showErrors(this.form, this.msg, errors)) {
            return;
        }
        if (this.recoveryRefused(this.recovery.box.checked)) {
            this.msg.say(TARGET_SETTINGS.RECOVERY_NOT_HERE, 'bad');
            return;
        }
        if (await this.setup.save(this.msg, Command.SET_SETTINGS, fields, SETTINGS.SAVED)) {
            this.form.dirty = false;
            await this.setup.reload('settings');
            await this.setup.reload('pinMap');
        }
    }
}
