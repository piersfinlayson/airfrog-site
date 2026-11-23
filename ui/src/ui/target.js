// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The target Airfrog is connected to, from TARGET, GET_PIN_MAP and GET_BOARDS:
// the Target card on the Target tab, with Reset target, and the target's
// details on the Advanced tab.

import { Operation, Service } from '../../../js/airfrog.js';
import { boardName, describeMcu, describeServices, firmwareName, targetState } from '../names.js';
import { errorText } from '../../../js/setup/protocol.js';
import { button, card, h, message, rows, tip } from '../../../js/setup/dom.js';
import { TARGET_CARD, VALUES } from '../../../js/messages.js';
import { SWD_RESPONDED } from '../../../js/schema.js';

const CLAIM_MS = 5000;
const RESET_MS = 35000;

/** @returns {Object<string, string>} TARGET and the board for display */
export function describeTarget(target, pinMap, boards) {
    const identified = target.identified();
    const responded = Boolean(target.swd & SWD_RESPONDED);
    return {
        mcu: !identified ? VALUES.NONE : responded ? describeMcu(target.targetid) : TARGET_CARD.MCU_NO_RESPONSE,
        firmware: targetState(target).text,
        board: identified && pinMap ? boardName(pinMap.board, boards) : VALUES.NONE,
    };
}

/**
 * The Target card's Connected row: what Airfrog is connected to.
 * @returns {string}
 */
export function connectedText(target) {
    if (!target.identified()) {
        return TARGET_CARD.IDENTIFYING;
    }
    if (target.firmware) {
        return firmwareName(target.firmware);
    }
    if (target.swd & SWD_RESPONDED) {
        return TARGET_CARD.NO_FIRMWARE(describeMcu(target.targetid));
    }
    return TARGET_CARD.NO_TARGET;
}

/** The Target card: what Airfrog is connected to, and Reset target. */
export class TargetCard {
    constructor(ui) {
        this.ui = ui;
        this.airfrog = null;
        this.rows = rows([['connected', TARGET_CARD.CONNECTED]]);
        this.msg = message();
        this.resetButton = button(TARGET_CARD.RESET, () => this.reset());
        this.buttons = h('div', { class: 'row actions' }, this.resetButton);
        this.element = card(TARGET_CARD.TITLE, null, this.rows.element, this.buttons, this.msg);
    }

    update(s) {
        if (this.airfrog !== this.ui.session.airfrog) {
            this.airfrog = this.ui.session.airfrog;
            this.msg.say('');
        }
        if (!s.target) {
            return;
        }
        this.rows.values.connected.textContent = connectedText(s.target);
        const identified = s.target.identified();
        this.resetButton.hidden = !identified || !s.target.supports(Service.RESET, Operation.RESET_RESET);
        this.buttons.hidden = this.resetButton.hidden;
        this.resetButton.disabled = this.ui.targetBusy() || !s.connected;
        if (identified && !(s.target.swd & SWD_RESPONDED) && !s.target.firmware && !this.busy) {
            this.msg.say(TARGET_CARD.NO_RESPONSE, 'bad');
        } else if (this.msg.textContent === TARGET_CARD.NO_RESPONSE) {
            this.msg.say('');
        }
    }

    async reset() {
        const airfrog = this.ui.session.airfrog;
        this.busy = true;
        this.ui.render();
        this.msg.say(TARGET_CARD.RESETTING);
        try {
            await airfrog.claim(CLAIM_MS);
            try {
                await airfrog.targetCmd(Service.RESET, Operation.RESET_RESET, new Uint8Array(0), RESET_MS);
            } finally {
                airfrog.release();
            }
            this.msg.say('');
        } catch (e) {
            this.msg.say(TARGET_CARD.RESET_FAILED(errorText(e)), 'bad');
        } finally {
            this.busy = false;
            this.ui.render();
        }
    }
}

/** The target's details: MCU, firmware, board and services. */
export class TargetView {
    constructor() {
        this.rows = rows([['mcu', TARGET_CARD.MCU], ['firmware', TARGET_CARD.FIRMWARE], ['board', TARGET_CARD.BOARD],
            ['services', TARGET_CARD.SERVICES, TARGET_CARD.SERVICES_TIP]]);
        this.change = h('a', { href: '#board', onclick: (e) => {
            e.preventDefault();
            const board = document.getElementById('board');
            board?.scrollIntoView({ block: 'center' });
            board?.focus();
        } }, TARGET_CARD.CHANGE);
        this.services = h('ul', { class: 'plain mono' });
        this.rows.values.services.replaceChildren(this.services);
        this.element = card(TARGET_CARD.TITLE, TARGET_CARD.TIP, this.rows.element);
    }

    update(s) {
        if (!s.target) {
            return;
        }
        const d = describeTarget(s.target, s.pinMap, s.boards);
        for (const key of ['mcu', 'firmware']) {
            this.rows.values[key].textContent = d[key];
        }
        this.rows.values.board.replaceChildren(d.board, ' ', this.change);
        const services = s.target.identified() ? describeServices(s.target.services) : [];
        this.services.replaceChildren(...(services.length
            ? services.map(({ text, description }) => h('li', {}, text, description ? tip(description) : null))
            : [h('li', {}, VALUES.NONE)]));
    }
}
