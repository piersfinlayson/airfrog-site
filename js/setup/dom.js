// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

import { CONTROLS, VALUES } from '../messages.js';

/**
 * Makes an element. attrs sets properties, except `class`, `for`, `data-*`
 * and `aria-*`, which are attributes, and `on*` functions, which are
 * listeners. Children are elements, text or null.
 */
export function h(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) {
        if (v === undefined || v === null || v === false) {
            continue;
        }
        if (k.startsWith('on') && typeof v === 'function') {
            e.addEventListener(k.slice(2), v);
        } else if (k === 'class' || k === 'for' || k.startsWith('data-') || k.startsWith('aria-')) {
            e.setAttribute(k, v === true ? '' : v);
        } else {
            e[k] = v;
        }
    }
    e.append(...children.flat().filter(c => c !== null && c !== undefined && c !== false));
    return e;
}

/**
 * Places a tip's box above its mark, so it doesn't cover the field below,
 * or below it near the top of the window. It stays inside the window.
 */
function placeTip(mark) {
    const box = mark.lastChild;
    const r = mark.getBoundingClientRect();
    box.style.top = '0px';
    box.style.left = '0px';
    const above = r.top - box.offsetHeight - 6;
    box.style.top = `${above >= 8 ? above : r.bottom + 6}px`;
    box.style.left = `${Math.max(8, Math.min(r.left - 8, window.innerWidth - box.offsetWidth - 8))}px`;
}

/** Opens or closes a tip. A pinned tip stays open until a click closes it. */
function setTip(mark, open, pinned = false) {
    mark.classList.toggle('open', open);
    mark.classList.toggle('pinned', open && pinned);
    if (open) {
        placeTip(mark);
    }
}

/** A help mark whose text appears on hover or focus, or on a tap. */
export function tip(text) {
    const mark = h('span', {
        class: 'tip', tabindex: 0, role: 'button', 'aria-label': text,
        // Hover with a mouse only: a tap opens a tip with the click.
        onpointerenter: (e) => e.pointerType === 'mouse' && setTip(mark, true, mark.classList.contains('pinned')),
        onpointerleave: (e) => e.pointerType === 'mouse'
            && setTip(mark, mark.classList.contains('pinned'), mark.classList.contains('pinned')),
        onfocus: () => setTip(mark, true, mark.classList.contains('pinned')),
        onblur: () => setTip(mark, false),
        onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            const pinned = mark.classList.contains('pinned');
            for (const other of document.querySelectorAll('.tip.open')) {
                if (other !== mark) {
                    setTip(other, false);
                }
            }
            setTip(mark, !pinned, !pinned);
            if (pinned) {
                mark.blur();
            }
        },
    }, '?', h('span', { class: 'tip-box', role: 'tooltip' }, text));
    return mark;
}

if (typeof document !== 'undefined') {
    // pointerdown, as iOS doesn't send click to the document.
    document.addEventListener('pointerdown', (e) => {
        for (const open of document.querySelectorAll('.tip.open')) {
            if (!open.contains(e.target)) {
                setTip(open, false);
            }
        }
    });
    document.addEventListener('scroll', () => {
        for (const open of document.querySelectorAll('.tip.open')) {
            placeTip(open);
        }
    }, true);
}

/**
 * A card with a title. Returns the card with its head's pill, for a state,
 * as card.pill.
 * @param {string} title
 * @param {string|null} help - the title's tooltip
 */
export function card(title, help, ...children) {
    const pill = h('span', { class: 'pill', hidden: true });
    const e = h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, title),
        help ? tip(help) : null, pill), ...children);
    e.pill = pill;
    return e;
}

/** Sets a pill's text and colour, ok, warn, bad or none. */
export function setPill(pill, text, tone = '') {
    pill.textContent = text ?? '';
    pill.className = tone ? `pill ${tone}` : 'pill';
    pill.hidden = !text;
}

/**
 * Label and value rows. Returns the list and its value elements by key.
 * @param {Array<[string, string, string?]>} rows - key, label and tooltip
 */
export function rows(list) {
    const values = {};
    const labels = {};
    const dl = h('dl', { class: 'kv' });
    for (const [key, label, help] of list) {
        values[key] = h('dd', {}, VALUES.NONE);
        labels[key] = h('dt', {}, label, help ? tip(help) : null);
        dl.append(labels[key], values[key]);
    }
    return { element: dl, values, labels };
}

/** Shows or hides a row made by rows(). */
export function showRow(r, key, on) {
    r.labels[key].hidden = !on;
    r.values[key].hidden = !on;
}

/**
 * A link displaying its URL. newTab opens it in a new tab, for a link to
 * another site, as leaving the page closes the connection.
 */
export function link(url, text = url, { newTab = false } = {}) {
    return h('a', { href: url, target: newTab ? '_blank' : null, rel: newTab ? 'noopener' : null }, text);
}

/**
 * A linked text from js/messages.js as nodes, each { url } a link displaying
 * its URL.
 */
export function linked(parts) {
    return parts.map(p => (typeof p === 'string' ? p : link(p.url)));
}

/**
 * A message line. say(text, tone) sets it. text is a string, or an array of
 * strings and elements. tone is '', 'ok' for a success or 'bad' for a failure.
 */
export function message() {
    const e = h('div', { class: 'msg', role: 'status' });
    e.say = (text, tone = '') => {
        e.replaceChildren(...[].concat(text ?? ''));
        e.className = tone ? `msg ${tone}` : 'msg';
    };
    return e;
}

/**
 * A file chooser: a Choose file button and the chosen file's name. The
 * browser's own file control is hidden.
 * @param {function()} onChange - called when a file is chosen
 * @param {string} [accept] - the file types accepted
 * @returns {{element: HTMLElement, input: HTMLInputElement, button: HTMLButtonElement, name: HTMLElement}}
 */
export function fileChooser(onChange, accept = '.bin') {
    const name = h('span', { class: 'file-name' });
    const input = h('input', { type: 'file', name: 'file', accept, hidden: true, onchange: () => {
        name.textContent = input.files?.[0]?.name ?? '';
        onChange();
    } });
    const choose = button(CONTROLS.CHOOSE_FILE, () => input.click());
    return { element: h('span', { class: 'row' }, input, choose, name), input, button: choose, name };
}

/** A labelled field. help is the label's tooltip. */
export function field(label, input, help = null) {
    return h('label', {}, h('span', {}, label, help ? tip(help) : null), input);
}

export function input(name, attrs = {}) {
    return h('input', { name, autocomplete: 'off', ...attrs });
}

export function button(text, onclick, attrs = {}) {
    return h('button', { type: 'button', onclick, ...attrs }, text);
}

/** A checkbox with its label. help is the label's tooltip. */
export function check(name, label, help = null, attrs = {}) {
    const box = h('input', { type: 'checkbox', name, ...attrs });
    return { box, element: h('label', { class: 'check' }, box, label, help ? tip(help) : null) };
}

/** A form's named field values. */
function snapshot(form) {
    return JSON.stringify([...form.elements].filter(e => e.name)
        .map(e => (e.type === 'checkbox' ? e.checked : e.value)));
}

/** Whether a form's fields differ from the values last filled from Airfrog. */
export function changed(form) {
    return snapshot(form) !== form.stored;
}

/**
 * A form whose fields are filled from Airfrog until the user edits one.
 * form.dirty is true from the first edit until it is saved. form.filled()
 * records the values just filled from Airfrog. The submit button is enabled
 * when ready(form) returns true, by default when a field differs from the
 * values filled, and form.run(fn) isn't running. form.refresh() sets it after
 * a change made in code.
 */
export function editable(form, ready = changed) {
    const submit = form.querySelector('button:not([type=button])');
    form.dirty = false;
    form.busy = false;
    form.stored = snapshot(form);
    form.refresh = () => { submit.disabled = form.busy || !ready(form); };
    form.run = async (fn) => {
        form.busy = true;
        form.refresh();
        try {
            return await fn();
        } finally {
            form.busy = false;
            form.refresh();
        }
    };
    form.filled = () => { form.stored = snapshot(form); form.refresh(); };
    form.addEventListener('input', () => {
        form.dirty = true;
        form.refresh();
        for (const msg of form.querySelectorAll('.msg.ok')) {
            msg.say('');
        }
    });
    form.addEventListener('change', () => form.refresh());
    form.refresh();
    return form;
}

/**
 * A prompt in place, with a confirming button and Cancel, which has the
 * focus.
 * @returns {{element: HTMLElement, ask: function(string, string, function(), {danger?: boolean}=)}}
 */
export function prompt() {
    const element = h('div', { class: 'prompt', role: 'alertdialog', hidden: true });
    const ask = (text, action, onConfirm, { danger = false } = {}) => {
        const cancel = button(CONTROLS.CANCEL, () => { element.hidden = true; }, { class: 'cancel' });
        element.replaceChildren(h('div', {}, text), h('div', { class: 'row' },
            button(action, () => { element.hidden = true; onConfirm(); }, { class: danger ? 'danger' : 'primary' }),
            cancel));
        element.hidden = false;
        cancel.focus?.();
    };
    return { element, ask };
}

/**
 * Displays a form check's errors on msg, and marks each field.
 * @returns {boolean} whether there were none
 */
export function showErrors(form, msg, errors) {
    for (const e of form.querySelectorAll('[aria-invalid]')) {
        e.removeAttribute('aria-invalid');
    }
    for (const { field: name } of errors) {
        form.elements[name]?.setAttribute('aria-invalid', 'true');
    }
    msg.say(errors.map(e => e.message).join(' '), errors.length ? 'bad' : '');
    return errors.length === 0;
}

/** Signal strength as bars, with its dBm. */
export function signal(rssi, bars) {
    return [h('span', { class: `bars b${bars}`, 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')),
        VALUES.DBM(rssi)];
}
