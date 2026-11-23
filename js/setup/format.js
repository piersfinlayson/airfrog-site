// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Names and formats for display: boards, firmware, models, versions,
// sizes and addresses.

import { FIRMWARE, VALUES, firmwareState, targetState } from '../messages.js';
import { CHIPS, MODELS } from '../schema.js';

export { MODELS, firmwareState, targetState };

/**
 * A board's name: its target, then its name within the target when it has
 * one, for example "One ROM fire-24-f" or "Pico".
 * @param {number} board - a board ID
 * @param {Array<{board: number, target: string, name: string}>|null} boards - GET_BOARDS's
 * @returns {string} the name, - for 0, or the ID in hex for a board not in boards
 */
export function boardName(board, boards) {
    if (!board) {
        return VALUES.NONE;
    }
    const b = boards?.find(e => e.board === board);
    if (!b) {
        return VALUES.BOARD(board.toString(16));
    }
    return b.name ? `${b.target} ${b.name}` : b.target;
}

export function firmwareName(firmware) {
    return FIRMWARE[firmware]?.name ?? VALUES.FIRMWARE(firmware);
}

/** Names of models not released, from the firmware they run. */
const firmwareNames = {};

/**
 * Records a model's name from Airfrog's firmware, which names its own
 * model whether it is released or not.
 */
export function nameModel(model, name) {
    firmwareNames[model] = name;
}

/** A model's name, or Model N for one without a name here. */
export function modelName(model) {
    return MODELS[model]?.name ?? firmwareNames[model] ?? VALUES.MODEL(model);
}

/** Airfrog's MCU and its revision from GET_HW_INFO, for example "ESP32-C3, revision 0.4". */
export function mcuText(hw) {
    return VALUES.MCU_REVISION(CHIPS[hw.chip]?.name ?? VALUES.MCU(hw.chip),
        `${hw.chipRev.major}.${hw.chipRev.minor}`);
}

/**
 * A version for display, v0.2.0, with the commit in brackets when known:
 * v0.2.0 (1a2b3c4d).
 */
export function versionText(version, commit = '') {
    const v = /^v/.test(version) ? version : VALUES.VERSION(version);
    return commit ? VALUES.WITH_COMMIT(v, commit) : v;
}

/** Signal strength as 1 to 4 bars, as a phone shows it. */
export function signalBars(rssi) {
    return rssi >= -55 ? 4 : rssi >= -67 ? 3 : rssi >= -78 ? 2 : 1;
}

/** A size in bytes as MB or KB. */
export function sizeText(bytes) {
    return bytes >= 1 << 20 ? VALUES.MB(bytes / (1 << 20)) : VALUES.KB(Math.round(bytes / 1024));
}

export function macText(bytes) {
    return Array.from(bytes, b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

export function ipv4(bytes) {
    return Array.from(bytes).join('.');
}

export function isZero(bytes) {
    return bytes.every(b => b === 0);
}

/** An IPv6 address with the longest run of zero groups shortened to ::. */
export function ipv6(bytes) {
    const groups = Array.from({ length: 8 }, (_, i) => (bytes[2 * i] << 8) | bytes[2 * i + 1]);
    let best = { at: -1, len: 1 };
    for (let i = 0; i < 8;) {
        let j = i;
        while (j < 8 && groups[j] === 0) j++;
        if (j - i > best.len) best = { at: i, len: j - i };
        i = j === i ? i + 1 : j;
    }
    const text = groups.map(g => g.toString(16));
    if (best.at < 0) {
        return text.join(':');
    }
    return `${text.slice(0, best.at).join(':')}::${text.slice(best.at + best.len).join(':')}`;
}
