// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The target's state and MCU for display, from TARGET. js/messages.js
// exports firmwareState() and targetState().

import { FIRMWARE, RUNNING, STOPPED, TARGET_STATE, VALUES } from './messages.js';
import { SWD_RESPONDED, TARGET_MCUS } from './schema.js';

/** TARGETID's part, as Airfrog's rules take it. */
const part = (targetid) => (targetid >>> 12) & 0xffff;

/**
 * @param {number} targetid - TARGET's targetid
 * @returns {string|null} the MCU's name, or null when Airfrog's rules don't
 *          include it
 */
export function mcuName(targetid) {
    const designer = (targetid >>> 1) & 0x7ff;
    return TARGET_MCUS.find(m => m.designer === designer && m.parts.includes(part(targetid)))?.name ?? null;
}

/**
 * The firmware Airfrog found and its state, for example "One ROM: Stopped".
 * @param {import('./awp.js').TargetInfo} target - identified, with a firmware
 */
export function firmwareState(target) {
    const name = FIRMWARE[target.firmware]?.name ?? VALUES.FIRMWARE(target.firmware);
    return `${name}: ${target.running() ? RUNNING : STOPPED}`;
}

/**
 * The target's state for display.
 * @param {import('./awp.js').TargetInfo} target
 * @returns {{text: string, ok: boolean}} ok when its firmware runs
 */
export function targetState(target) {
    if (!target.identified()) {
        return { text: TARGET_STATE.IDENTIFYING, ok: false };
    }
    if (target.firmware) {
        return { text: firmwareState(target), ok: target.running() };
    }
    return { text: target.swd & SWD_RESPONDED ? TARGET_STATE.NO_FIRMWARE : TARGET_STATE.NO_TARGET, ok: false };
}
