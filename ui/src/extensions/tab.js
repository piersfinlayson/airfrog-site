// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The Airfrog Extensions tab: the installed extensions, Install extensions and
// Install from file. Repository images are signed. A package from a file is
// unsigned, and an extension image from a file is either. An image signed with
// a key Airfrog doesn't have is sent unsigned. Airfrog installs an unsigned
// image only over serial or the access point started with the recovery
// button, so elsewhere the tab displays why and doesn't send it.

import { button, check, h, link, message, prompt } from '../../../js/setup/dom.js';
import { download } from '../../../js/setup/download.js';
import { Command, EMPTY, errorText, parseFwInfo, parseHwInfo } from '../../../js/setup/protocol.js';
import { ExtensionFlag, Interface, SetExtensionFlag, WasmReason, WasmState } from '../../../js/schema.js';
import { ERRORS, EXTENSIONS, FIRMWARE, SETTINGS, VALUES } from '../../../js/messages.js';
import {
    ExtensionError, checkDownload, checkList, checkMetadata, findVersion, firmwareText, isLocal, latest, targetGroup,
    uiAddress,
} from './list.js';
import { downloadText } from '../download.js';
import { compare } from './semver.js';
import { readExtensionFile } from './package.js';
import { signatureFor } from '../../../js/signed.js';

/** The number of extensions with a UI whose Tab checkbox is ticked at install. */
export const DEFAULT_TABS = 3;

const CMD_MS = 5000;

/** list with the item at from moved to to. */
export function moved(list, from, to) {
    const out = [...list];
    const [item] = out.splice(from, 1);
    out.splice(to, 0, item);
    return out;
}

/** The text for GET_EXTENSIONS's wasm_state. */
export function stateText(wasmState) {
    if (wasmState === WasmState.NO_MODULE) {
        return EXTENSIONS.UI_ONLY;
    }
    return wasmState === WasmState.RUNNING ? EXTENSIONS.RUNNING : EXTENSIONS.STOPPED;
}

/**
 * @typedef {object} Installed
 * @property {string} name
 * @property {number} flags - GET_EXTENSIONS's
 * @property {number} wasmState
 * @property {number} wasmReason
 * @property {object|null} metadata - null when it can't be read
 * @property {string} displayName
 * @property {string|null} version
 * @property {string|null} ui - the checked extension UI address, null for none
 * @property {boolean} unsigned - installed without a signature
 * @property {boolean} tab
 */

export class ExtensionsTab {
    /** @type {Array<Installed>} */
    installed = [];
    /** @type {Map<string, object>|null} the checked extensions manifest */
    list = null;
    listError = null;
    busy = false;
    #listLoad = null;
    #dragFrom = null;

    /**
     * @param {object} options
     * @param {function(): object|null} options.airfrog - the open connection
     * @param {function(): object} options.state - Airfrog's state the Page read
     * @param {function(): Promise<{url: string, manifest: object}>} options.loadExtensions -
     *        loads and verifies the extensions manifest
     * @param {string|null} options.extensionsUrl - the extensions manifest's
     *        address, or null when it isn't known
     * @param {function(Array<Installed>)} options.onChange - called after the
     *        installed extensions change
     * @param {function(string)} options.onUpdated - called after an extension
     *        is installed again
     * @param {function(string)} options.open - displays an extension UI
     */
    constructor({ airfrog, state, loadExtensions, extensionsUrl, onChange, onUpdated, open }) {
        this.airfrog = airfrog;
        this.state = state;
        this.loadExtensions = loadExtensions;
        this.extensionsUrl = extensionsUrl;
        this.onChange = onChange;
        this.onUpdated = onUpdated;
        this.openUi = open;

        this.rows = h('tbody');
        this.none = h('p', { class: 'note', hidden: true }, EXTENSIONS.NONE_INSTALLED);
        this.msg = message();
        this.confirm = prompt();
        this.file = h('input', { type: 'file', accept: '.afx,.bin', hidden: true, onchange: () => this.#chosen() });
        this.addButton = button(EXTENSIONS.ADD, () => this.#showAdd(true));
        this.fileButton = button(EXTENSIONS.FROM_FILE, () => this.file.click());
        this.table = h('table', { class: 'exts' },
            h('thead', {}, h('tr', {}, h('th'), h('th', {}, EXTENSIONS.EXTENSION), h('th', {}, EXTENSIONS.VERSION),
                h('th', {}, EXTENSIONS.STATE), h('th', {}, EXTENSIONS.TAB_COLUMN), h('th'))),
            this.rows);
        this.installedView = h('section', { class: 'card' },
            h('div', { class: 'card-head' }, h('h2', {}, EXTENSIONS.INSTALLED_TITLE)),
            this.table, this.none, h('p', { class: 'note drag-note' }, EXTENSIONS.DRAG_NOTE),
            h('div', { class: 'row actions' }, this.addButton, this.fileButton, this.file),
            this.msg, this.confirm.element);

        this.search = h('input', { type: 'search', name: 'search', autocomplete: 'off', oninput: () => this.render() });
        this.fAny = check('any', EXTENSIONS.ANY_TARGET, null, { checked: true, onchange: () => this.render() });
        this.fThis = check('this', '', null, { checked: true, onchange: () => this.render() });
        this.fOther = check('other', EXTENSIONS.OTHER_TARGETS, null, { onchange: () => this.render() });
        this.count = h('div', { class: 'count' });
        this.addMsg = message();
        this.addConfirm = prompt();
        this.avail = h('ul', { class: 'avail' });
        this.addView = h('section', { class: 'card', hidden: true },
            h('div', { class: 'card-head' }, h('h2', {}, EXTENSIONS.ADD),
                button(EXTENSIONS.BACK, () => this.#showAdd(false), { class: 'cancel right' })),
            h('label', {}, h('span', {}, EXTENSIONS.SEARCH), this.search),
            h('div', { class: 'filters' }, h('span', { class: 'muted' }, EXTENSIONS.FOR), this.fAny.element,
                this.fThis.element, this.fOther.element),
            this.count, h('div', { class: 'add-status' }, this.addMsg), this.avail, this.addConfirm.element);
        this.element = h('div', {}, this.installedView, this.addView);
    }

    get connected() {
        return Boolean(this.airfrog()) && Boolean(this.state().connected);
    }

    /** The model and WAMR version from the state the Page read, or null. */
    #info() {
        const { hw, fw } = this.state();
        return hw && fw ? { model: hw.model, wamr: fw.wamr } : null;
    }

    /** Reads GET_HW_INFO and GET_FW_INFO for an install. */
    async #readInfo(airfrog) {
        const hw = parseHwInfo(await airfrog.airfrogCmd(Command.GET_HW_INFO, EMPTY, CMD_MS));
        const fw = parseFwInfo(await airfrog.airfrogCmd(Command.GET_FW_INFO, EMPTY, CMD_MS));
        return { model: hw.model, wamr: fw.wamr };
    }

    /** Called when the tab is displayed. */
    shown() {
        this.loadList();
        this.refresh();
    }

    /**
     * Loads the extensions manifest. A call while one loads waits for that
     * load. A failure is displayed and the extensions manifest loaded before
     * is kept.
     */
    loadList() {
        this.#listLoad ??= (async () => {
            try {
                const { url, manifest } = await this.loadExtensions();
                this.list = checkList(manifest);
                this.extensionsUrl = url;
                if (this.listError) {
                    this.addMsg.say('');
                }
                this.listError = null;
            } catch (e) {
                this.listError = `${EXTENSIONS.LIST_NOT_LOADED} ${errorText(e)}`;
                this.addMsg.say(this.listError, 'bad');
            } finally {
                this.#listLoad = null;
            }
            this.#changed();
        })();
        return this.#listLoad;
    }

    /** Reads the installed extensions and their metadata from Airfrog. */
    async refresh() {
        const airfrog = this.airfrog();
        if (!airfrog) {
            return;
        }
        try {
            const entries = await airfrog.getExtensions();
            const items = [];
            for (const e of entries) {
                const name = e.name;
                let metadata = null;
                try {
                    metadata = checkMetadata(await airfrog.getExtensionMetadata(name));
                } catch (err) {
                    if (airfrog.isClosed()) {
                        throw err;
                    }
                }
                const unsigned = Boolean(e.flags & ExtensionFlag.UNSIGNED);
                items.push({
                    name, flags: e.flags, wasmState: e.wasmState, wasmReason: e.wasmReason, metadata,
                    displayName: metadata?.display_name ?? name, version: metadata?.version ?? null,
                    ui: null,
                    unsigned, tab: Boolean(e.flags & ExtensionFlag.TAB),
                });
            }
            this.installed = items;
        } catch (e) {
            if (!airfrog.isClosed()) {
                (this.addView.hidden ? this.msg : this.addMsg).say(`${EXTENSIONS.READ_FAILED} ${errorText(e)}`, 'bad');
            }
            return;
        }
        this.#changed();
    }

    /**
     * Passes on the installed extensions, each with its UI address checked
     * against the extensions manifest's address as it is now (D1a).
     */
    #changed() {
        const local = isLocal(this.extensionsUrl);
        this.installed = this.installed.map(x => ({ ...x, ui: uiAddress(x.metadata?.ui, x.unsigned || local) }));
        this.onChange(this.installed);
        this.render();
    }

    render() {
        const disabled = !this.connected || this.busy;
        this.addButton.disabled = disabled;
        this.fileButton.disabled = disabled;
        this.none.hidden = this.installed.length > 0;
        this.table.hidden = this.installed.length === 0;
        this.rows.replaceChildren(...this.installed.map((x, i) => this.#row(x, i, disabled)));
        this.#renderAvail(disabled);
    }

    /** The installed version's note, in brackets after it: latest version, unsigned or depublished. */
    #note(x) {
        if (x.unsigned) {
            return EXTENSIONS.UNSIGNED;
        }
        const entry = this.list?.get(x.name);
        if (!entry) {
            return null;
        }
        if (entry.depublished) {
            return EXTENSIONS.DEPUBLISHED;
        }
        const info = this.#info();
        const newest = info ? latest(entry, info.model, info.wamr) : null;
        return EXTENSIONS.LATEST(VALUES.VERSION((newest?.metadata ?? entry.versions[0].metadata).version));
    }

    /** The newer version Update installs, or null. */
    #newer(x) {
        const entry = this.list?.get(x.name);
        const info = this.#info();
        if (x.unsigned || !entry || entry.depublished || !info || !x.version) {
            return null;
        }
        const newest = latest(entry, info.model, info.wamr);
        return newest && compare(newest.metadata.version, x.version) > 0 ? newest.metadata.version : null;
    }

    /** An installed extension's buttons in the installed list and in Install extensions. */
    #actions(x, disabled, msg, confirm) {
        const newer = this.#newer(x);
        const reinstall = !x.unsigned && x.wasmReason === WasmReason.OTHER_WAMR_VERSION
            && (x.wasmState === WasmState.STOPPED || x.wasmState === WasmState.NOT_STARTED);
        return [
            x.ui ? button(EXTENSIONS.OPEN, () => this.openUi(x.name), { class: 'small', disabled: !this.connected })
                : null,
            newer ? this.#button(EXTENSIONS.UPDATE, () => this.#fromRepository(x.name, null, msg),
                { class: 'small', disabled }) : null,
            reinstall ? this.#button(EXTENSIONS.REINSTALL, () => this.#fromRepository(x.name, x.version, msg),
                { class: 'small', disabled }) : null,
            this.#button(EXTENSIONS.REMOVE, () => {
                msg.say('');
                confirm.ask(EXTENSIONS.REMOVE_CONFIRM(x.displayName), EXTENSIONS.REMOVE,
                    () => this.#remove(x, msg), { danger: true });
            }, { class: 'small danger', disabled }),
        ];
    }

    /** A button that acts on a single click and not while an operation runs. */
    #button(text, onclick, attrs) {
        return button(text, (e) => {
            if (e.detail <= 1 && !this.busy) {
                onclick();
            }
        }, attrs);
    }

    #row(x, i, disabled) {
        const note = this.#note(x);
        const tab = x.ui ? h('input', { type: 'checkbox', checked: x.tab, disabled,
            'aria-label': EXTENSIONS.TAB_CHECKBOX(x.displayName),
            onchange: (e) => this.#save(this.installed.map(y => (y === x ? { ...y, tab: e.target.checked } : y))) })
            : null;
        const tr = h('tr', { draggable: !disabled, class: 'ext-row', 'data-name': x.name },
            h('td', { class: 'handle', 'aria-hidden': 'true' }, '⠿'),
            h('td', {}, x.displayName),
            h('td', { class: 'ver' }, note ? VALUES.WITH_NOTE(x.version ? VALUES.VERSION(x.version) : VALUES.NONE, note)
                : x.version ? VALUES.VERSION(x.version) : VALUES.NONE),
            h('td', {}, stateText(x.wasmState)),
            h('td', {}, tab),
            h('td', { class: 'acts' }, ...this.#actions(x, disabled, this.msg, this.confirm)));
        tr.addEventListener('dragstart', (e) => {
            this.#dragFrom = i;
            e.dataTransfer?.setData('text/plain', x.name);
            tr.classList.add('dragging');
        });
        tr.addEventListener('dragend', () => tr.classList.remove('dragging'));
        tr.addEventListener('dragover', (e) => e.preventDefault());
        tr.addEventListener('drop', (e) => {
            e.preventDefault();
            const from = this.#dragFrom;
            this.#dragFrom = null;
            if (from !== null && from !== i && !this.busy) {
                this.#save(moved(this.installed, from, i));
            }
        });
        return tr;
    }

    #renderAvail(disabled) {
        const target = this.state().target;
        const found = target?.identified() && FIRMWARE[target.firmware] ? target.firmware : 0;
        this.fThis.element.hidden = !found;
        this.fThis.element.lastChild.textContent = found ? FIRMWARE[found].name : '';
        const info = this.#info();
        const installed = new Map(this.installed.map(x => [x.name, x]));
        const all = [...(this.list?.values() ?? [])].filter(e => !e.depublished).map(e => {
            const newest = (info && latest(e, info.model, info.wamr)) ?? { metadata: e.versions[0].metadata };
            return { name: e.name, metadata: newest.metadata };
        });
        const q = this.search.value.trim().toLowerCase();
        const groups = { any: this.fAny.box.checked, this: found && this.fThis.box.checked, other: this.fOther.box.checked };
        const shown = all.filter(({ name, metadata: m }) => groups[targetGroup(m.firmware, found)]
            && (!q || [name, m.display_name, m.description, m.author].join(' ').toLowerCase().includes(q)))
            .sort((a, b) => a.metadata.display_name.localeCompare(b.metadata.display_name));
        this.count.textContent = this.list ? EXTENSIONS.COUNT(shown.length, all.length) : '';
        this.avail.replaceChildren(...shown.map(({ name, metadata: m }) => h('li', {},
            h('div', { class: 'body' },
                h('div', { class: 'top' },
                    nameLink(m),
                    h('span', { class: 'ver muted' }, VALUES.VERSION(m.version)),
                    ...(m.firmware.length ? m.firmware : [null]).map(f => h('span',
                        { class: f !== null && targetGroup([f], found) === 'this' ? 'for this' : 'for' },
                        f === null ? EXTENSIONS.ANY_TARGET : firmwareText(f)))),
                h('div', { class: 'desc' }, m.description, ' · ', h('span', { class: 'muted' }, m.author))),
            h('div', { class: 'acts' }, ...(installed.get(name)
                ? this.#actions(installed.get(name), disabled, this.addMsg, this.addConfirm)
                : [this.#button(EXTENSIONS.INSTALL, () => this.#fromRepository(name, null, this.addMsg),
                    { class: 'small', disabled })])))));
    }

    #showAdd(on) {
        this.installedView.hidden = on;
        this.addView.hidden = !on;
        this.addMsg.say('');
        this.addConfirm.element.hidden = true;
        this.confirm.element.hidden = true;
        if (on) {
            this.loadList();
            this.search.focus?.();
        }
        this.render();
    }

    /** Runs fn as the tab's one operation, with buttons disabled. */
    async #run(fn) {
        if (this.busy) {
            return;
        }
        this.busy = true;
        this.confirm.element.hidden = true;
        this.addConfirm.element.hidden = true;
        this.render();
        try {
            await fn();
        } finally {
            this.busy = false;
            this.render();
        }
    }

    /** Saves the order and Tab checkboxes of list with SET_EXTENSIONS. */
    #save(list) {
        this.#run(async () => {
            const airfrog = this.airfrog();
            this.installed = list;
            this.#changed();
            this.msg.say(SETTINGS.SAVING);
            try {
                await airfrog.setExtensions(list.map(x => ({ name: x.name, flags: x.tab ? SetExtensionFlag.TAB : 0 })));
                await this.refresh();
                this.msg.say(SETTINGS.SAVED, 'ok');
            } catch (e) {
                this.msg.say(`${SETTINGS.SAVE_FAILED} ${errorText(e)}`, 'bad');
                await this.refresh();
            }
        });
    }

    /**
     * Installs, updates or reinstalls name from the repository.
     * @param {string|null} version - the version to install, null for the latest
     */
    #fromRepository(name, version, msg) {
        this.#run(async () => {
            const existing = this.installed.find(x => x.name === name);
            const failed = existing ? EXTENSIONS.UPDATE_FAILED : EXTENSIONS.INSTALL_FAILED;
            try {
                await this.loadList();
                if (this.listError) {
                    throw new ExtensionError(this.listError);
                }
                const airfrog = this.airfrog();
                const info = await this.#readInfo(airfrog);
                const entry = this.list.get(name);
                const chosen = version ? findVersion(entry, version, info.model, info.wamr)
                    : latest(entry, info.model, info.wamr);
                if (!chosen) {
                    throw new ExtensionError(ERRORS.EXTENSION_UNSUPPORTED());
                }
                msg.say(this.#progress(existing, chosen.metadata));
                const file = checkDownload(await downloadImage(chosen.image.url), name, chosen.image);
                await this.#install(airfrog, file.image, signatureFor(file.signature, airfrog.getReleaseKeys()),
                    chosen.metadata, msg);
            } catch (e) {
                msg.say(`${failed} ${errorText(e)}`, 'bad');
            }
        });
    }

    #progress(existing, metadata) {
        const version = VALUES.VERSION(metadata.version);
        return existing ? EXTENSIONS.UPDATING(metadata.display_name, version)
            : EXTENSIONS.INSTALLING(metadata.display_name, version);
    }

    /** Whether an image with signature, null for unsigned, can be installed over airfrog's connection. */
    static #allowed(airfrog, signature) {
        return Boolean(signature) || airfrog.getInterface() === Interface.AP_BUTTON;
    }

    async #install(airfrog, image, signature, metadata, msg) {
        if (!ExtensionsTab.#allowed(airfrog, signature)) {
            throw new ExtensionError(EXTENSIONS.UNSIGNED_NOT_HERE);
        }
        const existing = this.installed.find(x => x.name === metadata.name);
        const local = !signature || isLocal(this.extensionsUrl);
        const withUi = this.installed.filter(x => x.ui).length;
        const tab = !existing && uiAddress(metadata.ui, local) && withUi < DEFAULT_TABS;
        msg.say(this.#progress(existing, metadata));
        await airfrog.installExtension(image, tab ? SetExtensionFlag.TAB : 0, signature);
        await this.refresh();
        const version = VALUES.VERSION(metadata.version);
        msg.say(existing ? EXTENSIONS.UPDATED(metadata.display_name, version)
            : EXTENSIONS.INSTALLED(metadata.display_name, version), 'ok');
        if (existing) {
            this.onUpdated(metadata.name);
        }
    }

    #remove(x, msg) {
        this.#run(async () => {
            msg.say(EXTENSIONS.REMOVING(x.displayName));
            try {
                await this.airfrog().removeExtension(x.name);
                await this.refresh();
                msg.say(EXTENSIONS.REMOVED(x.displayName), 'ok');
            } catch (e) {
                msg.say(`${EXTENSIONS.REMOVE_FAILED} ${errorText(e)}`, 'bad');
                await this.refresh();
            }
        });
    }

    /**
     * A file was chosen with Install from file: a package or an extension
     * image. An unsigned one is confirmed first.
     */
    async #chosen() {
        const file = this.file.files?.[0];
        this.file.value = '';
        if (!file || this.busy) {
            return;
        }
        let chosen;
        try {
            const airfrog = this.airfrog();
            const info = await this.#readInfo(airfrog);
            chosen = await readExtensionFile(new Uint8Array(await file.arrayBuffer()), info.model, info.wamr);
            chosen.signature = signatureFor(chosen.signature, airfrog.getReleaseKeys());
            if (!ExtensionsTab.#allowed(airfrog, chosen.signature)) {
                throw new ExtensionError(EXTENSIONS.UNSIGNED_NOT_HERE);
            }
        } catch (e) {
            this.msg.say(`${EXTENSIONS.INSTALL_FAILED} ${errorText(e)}`, 'bad');
            return;
        }
        this.msg.say('');
        const install = () => this.#run(async () => {
            const existing = this.installed.some(x => x.name === chosen.metadata.name);
            try {
                await this.#install(this.airfrog(), chosen.image, chosen.signature, chosen.metadata, this.msg);
            } catch (e) {
                const failed = existing ? EXTENSIONS.UPDATE_FAILED : EXTENSIONS.INSTALL_FAILED;
                this.msg.say(`${failed} ${errorText(e)}`, 'bad');
            }
        });
        if (chosen.signature) {
            install();
        } else {
            this.confirm.ask(EXTENSIONS.UNSIGNED_CONFIRM, EXTENSIONS.INSTALL, install);
        }
    }
}

/** An extension's name, linked to its source repository when that is on https. */
function nameLink(m) {
    const e = /^https:\/\//.test(m.source ?? '') ? link(m.source, m.display_name, { newTab: true })
        : h('span', {}, m.display_name);
    e.classList.add('name');
    return e;
}

/** Downloads an extension image. */
async function downloadImage(url) {
    try {
        return await download(url, { cache: 'no-store' });
    } catch (e) {
        throw new ExtensionError(downloadText(e));
    }
}
