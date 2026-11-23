// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Airfrog's connectors J1 and J2 boxed on a render of the board, and each
// connector's pins as a drawing and a table, with the target's names for them
// from the active pin map.

import { card, h } from '../../../js/setup/dom.js';
import { MODELS, modelName } from '../names.js';
import { PINS, VALUES } from '../../../js/messages.js';
import { CONNECTOR_FONT, CONNECTOR_NUM_FONT } from '../style.js';
import { RENDERS } from '../../images/renders.js';
import BOARDS from '../../images/boards.json' with { type: 'json' };

/**
 * Airfrog v0.2.0's connectors. Each pin has Airfrog's own name, or null
 * where it is a line to the target, and J2-2 and J2-3 are the same lines as
 * J1-3 and J1-5.
 */
export const CONNECTORS = {
    J1: { pins: ['GND', '5V', null, null, null, null, 'GND', null, 'GND', null] },
    J2: { pins: ['GND', null, null, 'DTR', 'RTS', 'BOOT', 'RXD0', 'TXD0', 'EN'], same: { 2: 'J1-3', 3: 'J1-5' } },
};

/**
 * A connector's box's line width, and the margins outside the board that hold
 * the labels, in render pixels. J1 is on the board's top edge and J2 on its
 * left edge, so their labels go above and to the left of the board.
 */
const BOX = { line: 3, top: 34, left: 52, gap: 8 };
/** The board's displayed width in px, without the label margin. */
const BOARD_PX = 240;

/**
 * Every pin of J1 and J2.
 * @param {Array<{name: string, pin: string}>} entries - the active pin map's
 * @returns {Array<{pin: string, name: string}>} name is the target's names
 *          for the pin, or Airfrog's own name, or empty
 */
export function connectorPins(entries) {
    const out = [];
    for (const [connector, { pins, same = {} }] of Object.entries(CONNECTORS)) {
        pins.forEach((own, i) => {
            const pin = `${connector}-${i + 1}`;
            const line = same[i + 1] ?? pin;
            out.push({ pin, name: own ?? entries.filter(e => e.pin === line).map(e => e.name).join(' / ') });
        });
    }
    return out;
}

const SVG = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, text = null) {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) {
        e.setAttribute(k, v);
    }
    if (text !== null) {
        e.textContent = text;
    }
    return e;
}

const PITCH = 26;
/** A label's width where text can't be measured. */
const LABEL = 135;
/** Space between a label and the drawing's edge. */
const LABEL_MARGIN = 2;

let measure;

/** A pin's label's width in px, in the drawing's fonts. */
function labelWidth(p) {
    measure ??= document.createElement('canvas').getContext?.('2d') ?? null;
    if (!measure) {
        return LABEL;
    }
    measure.font = CONNECTOR_NUM_FONT;
    const num = measure.measureText(`${p.pin} `).width;
    measure.font = `600 ${CONNECTOR_FONT}`;
    return Math.ceil(num + measure.measureText(p.name).width) + LABEL_MARGIN;
}

/**
 * A connector drawn as a header, pin 1 square, with each pin's label beside
 * it: odd pins on the left and even on the right for J1's two rows. J1 is
 * then turned 90 degrees counter-clockwise, its labels running vertically.
 */
function drawing(connector, pins) {
    const two = connector === 'J1';
    const rows = two ? pins.length / 2 : pins.length;
    const cols = two ? 2 : 1;
    const onLeft = (i) => two && i % 2 === 0;
    const widest = (left) => Math.max(0, ...pins.filter((_, i) => onLeft(i) === left).map(labelWidth));
    const left = two ? widest(true) + 6 : 0;
    const innerWidth = left + cols * PITCH + 18 + widest(false);
    const innerHeight = rows * PITCH + 14;
    const [width, height] = two ? [innerHeight, innerWidth] : [innerWidth, innerHeight];
    const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, role: 'img',
        'aria-label': PINS.CONNECTOR(connector), class: 'connector' });
    const bx = left + 6;
    const header = svg('g', two ? { transform: `translate(0 ${height}) rotate(-90)` } : {});
    header.append(svg('rect', { x: bx - 6, y: 0, width: cols * PITCH + 12, height: rows * PITCH + 8, rx: 4,
        class: 'body' }));
    pins.forEach((p, i) => {
        const col = two ? i % 2 : 0;
        const row = two ? Math.floor(i / 2) : i;
        const cx = bx + col * PITCH + PITCH / 2;
        const cy = 4 + row * PITCH + PITCH / 2;
        header.append(i === 0
            ? svg('rect', { x: cx - 7, y: cy - 7, width: 14, height: 14, class: 'pin' })
            : svg('circle', { cx, cy, r: 7, class: 'pin' }));
        const x = onLeft(i) ? bx - 12 : bx + cols * PITCH + 12;
        const label = svg('text', { x, y: cy + 4, 'text-anchor': onLeft(i) ? 'end' : 'start' });
        const parts = onLeft(i) ? [[p.name, 'name'], [`${p.pin} `, 'num']].reverse() : [[`${p.pin} `, 'num'], [p.name, 'name']];
        for (const [t, cls] of parts) {
            label.append(svg('tspan', { class: cls }, t));
        }
        header.append(label);
    });
    root.append(header);
    return root;
}

/**
 * The model's board render, from ci/render-boards.py, with a box around
 * each connector and its label outside the board, J1's above its box and
 * J2's to the left of its box, or null for a model without a render.
 */
function render(model) {
    const key = MODELS[model]?.key;
    const b = BOARDS[key];
    if (!RENDERS[key] || !b) {
        return null;
    }
    const { line, top, left, gap } = BOX;
    // The margin is on both sides so the board itself is centred.
    const width = b.width + 2 * left;
    const root = svg('svg', { viewBox: `${-left} ${-top} ${width} ${b.height + top}`, role: 'img',
        width: Math.round(BOARD_PX * width / b.width), 'aria-label': PINS.BOARD(modelName(model)), class: 'board' });
    root.append(svg('image', { href: RENDERS[key], width: b.width, height: b.height }));
    for (const connector of Object.keys(CONNECTORS)) {
        const [x, y, w, h] = b[connector];
        const above = connector === 'J1';
        root.append(
            svg('rect', { x: x + line / 2, y: y + line / 2, width: w - line, height: h - line, rx: 4,
                'stroke-width': line, class: 'box' }),
            svg('text', above
                ? { x: x + w / 2, y: -gap, 'text-anchor': 'middle', class: 'label' }
                : { x: -gap, y: y + h / 2, 'text-anchor': 'end', 'dominant-baseline': 'central', class: 'label' },
            connector));
    }
    return root;
}

export class PinsView {
    constructor() {
        this.board = h('div', { class: 'board-render' });
        this.connectors = h('div', { class: 'connectors' });
        this.element = card(PINS.TITLE, PINS.TIP, this.board, this.connectors);
        this.key = null;
        this.model = null;
    }

    update({ pinMap, target, hw }) {
        const model = hw?.model ?? null;
        if (model !== this.model) {
            this.model = model;
            this.board.replaceChildren(...[render(model)].filter(e => e));
        }
        const entries = target?.identified() ? pinMap?.entries ?? [] : [];
        const key = JSON.stringify(entries);
        if (key === this.key) {
            return;
        }
        this.key = key;
        const pins = connectorPins(entries);
        this.connectors.replaceChildren(...Object.keys(CONNECTORS).map((c) => {
            const own = pins.filter(p => p.pin.startsWith(`${c}-`));
            return h('div', { class: 'connector-row' }, drawing(c, own),
                h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, PINS.PIN), h('th', {}, PINS.NAME))),
                    h('tbody', {}, ...own.map(p => h('tr', {},
                        h('td', { class: 'mono' }, p.pin), h('td', {}, p.name || VALUES.NONE))))));
        }));
    }
}
