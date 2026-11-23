// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// An extension UI tab's content: the extension UI in a frame, with its
// connection to Airfrog (ac4-design.md section 6, "Tabs" and "Loading").

import { h, message } from '../../../js/setup/dom.js';
import { EXTENSIONS } from '../../../js/messages.js';
import { FrameLink } from './bridge.js';

/** How long an extension UI has to call connectExtension(). */
export const LOAD_MS = 10000;

/** How long an extension UI stays loaded while its tab is hidden. */
export const UNLOAD_MS = 10 * 60 * 1000;

/** The frame's permissions: it keeps its own origin, and can't navigate the Airfrog UI. */
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox '
    + 'allow-downloads allow-modals';

export class ExtensionPane {
    #frame = null;
    #link = null;
    #loadTimer = null;
    #unloadTimer = null;

    /**
     * @param {object} options
     * @param {string} options.name - the extension name
     * @param {string} options.displayName
     * @param {string} options.ui - the extension UI's address, checked
     * @param {function(): Promise<object>} options.open - opens a logged-in
     *        AwpSocket to Airfrog
     * @param {{loadMs?: number, unloadMs?: number}} [options.times]
     */
    constructor({ name, displayName, ui, open, times = {} }) {
        this.name = name;
        this.displayName = displayName;
        this.ui = ui;
        this.open = open;
        this.loadMs = times.loadMs ?? LOAD_MS;
        this.unloadMs = times.unloadMs ?? UNLOAD_MS;
        /** unloaded, loading, loaded or failed */
        this.state = 'unloaded';
        this.visible = false;
        this.msg = message();
        this.holder = h('div', { class: 'ext-frame' });
        this.element = h('div', { class: 'ext-pane' }, this.msg, this.holder);
    }

    get loaded() {
        return this.state !== 'unloaded';
    }

    /** Updates the name and address. A changed address loads the new one. */
    update(displayName, ui) {
        this.displayName = displayName;
        if (this.#frame) {
            this.#frame.title = displayName;
        }
        if (ui !== this.ui) {
            this.ui = ui;
            if (this.loaded) {
                this.reload();
            }
        }
    }

    /** The tab is displayed: loads the extension UI if it isn't loaded. */
    shown() {
        this.visible = true;
        clearTimeout(this.#unloadTimer);
        this.#unloadTimer = null;
        if (!this.loaded) {
            this.load();
        }
    }

    /** The tab is hidden: the extension UI is unloaded after UNLOAD_MS. */
    hidden() {
        if (!this.visible) {
            return;
        }
        this.visible = false;
        if (this.loaded && !this.#unloadTimer) {
            this.#unloadTimer = setTimeout(() => {
                this.#unloadTimer = null;
                this.unload();
            }, this.unloadMs);
        }
    }

    load() {
        this.unload();
        const origin = new URL(this.ui).origin;
        const frame = h('iframe', { src: this.ui, title: this.displayName, referrerPolicy: 'no-referrer',
            hidden: true });
        frame.setAttribute('sandbox', SANDBOX);
        this.#frame = frame;
        this.#link = new FrameLink({ name: this.name, origin, target: () => frame.contentWindow, open: this.open,
            onConnect: () => this.#connected(), onHeight: (height) => { frame.style.height = `${height}px`; } });
        this.state = 'loading';
        this.msg.say(EXTENSIONS.LOADING_UI(this.displayName));
        this.#loadTimer = setTimeout(() => {
            this.#loadTimer = null;
            if (this.state === 'loading') {
                this.state = 'failed';
                this.msg.say(EXTENSIONS.UI_FAILED(this.displayName), 'bad');
            }
        }, this.loadMs);
        this.holder.replaceChildren(frame);
    }

    unload() {
        clearTimeout(this.#loadTimer);
        clearTimeout(this.#unloadTimer);
        this.#loadTimer = null;
        this.#unloadTimer = null;
        this.#link?.close();
        this.#link = null;
        this.#frame = null;
        this.holder.replaceChildren();
        this.msg.say('');
        this.state = 'unloaded';
    }

    /** Loads the extension UI again if it is loaded. */
    reload() {
        if (this.loaded) {
            this.load();
            if (!this.visible) {
                this.visible = true;
                this.hidden();
            }
        }
    }

    /** @param {MessageEvent} event - a message event of the Airfrog UI's window */
    receive(event) {
        this.#link?.receive(event);
    }

    destroy() {
        this.unload();
        this.element.remove();
    }

    #connected() {
        clearTimeout(this.#loadTimer);
        this.#loadTimer = null;
        this.state = 'loaded';
        this.msg.say('');
        if (this.#frame) {
            this.#frame.hidden = false;
        }
    }
}
