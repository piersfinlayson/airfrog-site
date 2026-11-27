// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The Network tab: WiFi with WiFi power save and rescans, joining a network,
// and the hostname with host aliases.

import {
    button, card, changed, check, editable, field, h, input, linked, message, rows, setPill, showErrors, showRow,
    signal,
} from './dom.js';
import { NETWORK, PASSWORD, SETTINGS, VALUES, WIFI_AP } from '../messages.js';
import { ipv4, ipv6, isZero, macText, signalBars } from './format.js';
import {
    BOOT_WINDOW_AUTO, Command, Interface, Ipv4Mode, ScanState, ScanSecurity, StaReason, StaState, encodeWifiScan, errorText,
    overAp, parseWifiScan,
} from './protocol.js';
import { checkAliases, checkHostname, checkSettings, checkWifi, checkWifiAp } from './validate.js';
import { HOSTNAME_MAX, SSID_MAX, WIFI_PASSWORD_MAX } from '../schema.js';

/** The password field's value while a saved password is kept. */
export const KEPT_PASSWORD = '********';
const SCAN_POLL_MS = 1000;
const STATIC_FIELDS = ['address', 'netmask', 'gateway', 'dns'];
const SCAN_LIMIT_MS = 20000;
const FAILURES = {
    [StaReason.NETWORK_NOT_FOUND]: NETWORK.WIFI_NETWORK_NOT_FOUND,
    [StaReason.WRONG_PASSWORD]: NETWORK.WIFI_WRONG_PASSWORD,
    [StaReason.OTHER]: NETWORK.WIFI_FAILED,
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Clears a view's messages when the connection changes, and refills its
 * forms from what the new connection reads.
 */
class View {
    constructor(setup) {
        this.setup = setup;
        this.airfrog = null;
        this.forms = [];
    }

    /** Reads key again, displaying a failure on this view's message. */
    async read(key) {
        try {
            await this.setup.reload(key);
        } catch (e) {
            this.msg.say(`${SETTINGS.READ_FAILED} ${errorText(e)}`, 'bad');
        }
    }

    connection(...msgs) {
        if (this.airfrog !== this.setup.link) {
            this.airfrog = this.setup.link;
            msgs.forEach(m => m.say(''));
            this.forms.forEach(f => { f.dirty = false; });
        }
    }
}

export class WifiView extends View {
    constructor(setup) {
        super(setup);
        this.rows = rows([['network', NETWORK.NETWORK_ROW], ['signal', NETWORK.SIGNAL_ROW], ['ip', NETWORK.IP_ADDRESS],
            ['netmask', NETWORK.SUBNET_MASK], ['gateway', NETWORK.GATEWAY], ['dns', NETWORK.DNS_SERVER],
            ['assignment', NETWORK.IP_ASSIGNMENT], ['ipv6', NETWORK.IPV6_ADDRESS], ['mac', NETWORK.MAC_ADDRESS],
            ['ap', NETWORK.AP_MODE, NETWORK.AP_MODE_TIP]]);
        this.joinedMsg = h('div', { role: 'status' });
        this.stopButton = button(NETWORK.STOP_AP_MODE, () => this.stopAp());
        // A warning card at the top of the page while it is reached through
        // AP mode after Airfrog joined its network.
        this.joined = h('section', { class: 'card warn', id: 'ap-notice', hidden: true }, this.joinedMsg,
            h('div', { class: 'row actions' }, this.stopButton));
        this.powerMsg = message();
        this.powerSave = check('wifiPowerSave', NETWORK.POWER_SAVE, NETWORK.POWER_SAVE_TIP);
        this.power = editable(h('form', { onsubmit: (e) => { e.preventDefault(); this.power.run(() => this.savePower()); } },
            this.powerSave.element,
            field(NETWORK.RESCAN_INTERVAL, input('wifiRescanS', { inputMode: 'numeric' }),
                NETWORK.RESCAN_INTERVAL_TIP),
            field(NETWORK.RESCAN_THRESHOLD, input('wifiRescanDb', { inputMode: 'numeric' }),
                NETWORK.RESCAN_THRESHOLD_TIP),
            h('div', { class: 'row' }, h('button', { class: 'primary' }, SETTINGS.SAVE)),
            this.powerMsg), (f) => changed(f) && Boolean(this.setup.state.settings));
        this.element = card(NETWORK.WIFI_TITLE, null, this.rows.element, h('hr', { class: 'sep' }), this.power);
        this.forms = [this.power];
    }

    /**
     * Whether this page reaches Airfrog through AP mode while it stays on
     * after Airfrog joined its network. On AP mode every name resolves to
     * Airfrog, so only the network's own address is known not to be AP mode.
     * Not the recovery button's access point, which Airfrog starts while it
     * stays on its network.
     */
    onAp({ sta, ap }) {
        return Boolean(this.setup.closes && this.setup.state.interface !== Interface.AP_BUTTON
            && ap?.on && sta?.state === StaState.CONNECTED
            && location.hostname !== ipv4(sta.ipv4));
    }

    async stopAp() {
        const { sta } = this.setup.state;
        const url = `http://${ipv4(sta.ipv4)}/`;
        this.setup.expectClose({ message: linked(NETWORK.AP_STOPPED(sta.ssid, url)) });
        this.stopButton.disabled = true;
        try {
            await this.setup.command(Command.WIFI_AP_STOP);
        } catch (e) {
            // AP mode stopping closes the connection.
        } finally {
            this.stopButton.disabled = false;
        }
    }

    update({ sta, ap, hw, settings }) {
        this.connection(this.powerMsg);
        if (settings && !this.power.dirty) {
            const f = this.power.elements;
            this.powerSave.box.checked = settings.wifiPowerSave;
            f.wifiRescanS.value = String(settings.wifiRescanS);
            f.wifiRescanDb.value = String(settings.wifiRescanDb);
            this.power.filled();
        }
        if (!sta) {
            return;
        }
        this.joined.hidden = !this.setup.state.connected || !this.onAp({ sta, ap });
        if (!this.joined.hidden) {
            const url = `http://${ipv4(sta.ipv4)}/`;
            const text = () => linked(NETWORK.JOINED(sta.ssid, url));
            // Replaced only when it changes, so that it is announced once.
            const notice = JSON.stringify(NETWORK.AP_JOINED(sta.ssid, url));
            if (notice !== this.joinedNotice) {
                this.joinedNotice = notice;
                this.joinedMsg.replaceChildren(...linked(NETWORK.AP_JOINED(sta.ssid, url)));
            }
            // The connection closes when the device leaves AP mode or AP mode
            // stops. The status line then keeps the address. Once on each
            // connection, as a close uses it up.
            if (this.armedFor !== this.setup.link) {
                this.armedFor = this.setup.link;
                this.setup.expectClose({ message: text() });
            }
        } else if (this.armedFor) {
            if (this.armedFor === this.setup.link) {
                this.setup.cancelExpected();
            }
            this.armedFor = null;
        }
        const connected = sta.state === StaState.CONNECTED;
        const [state, tone] = connected ? [NETWORK.WIFI_CONNECTED, 'ok']
            : sta.state === StaState.CONNECTING ? [NETWORK.WIFI_CONNECTING, 'warn']
                : sta.state === StaState.FAILED ? [FAILURES[sta.reason] ?? NETWORK.WIFI_FAILED, 'bad']
                    : [sta.ssid ? NETWORK.WIFI_NOT_CONNECTED : NETWORK.WIFI_NOT_SET, ''];
        setPill(this.element.pill, state, tone);
        const v = this.rows.values;
        v.network.textContent = sta.ssid || VALUES.NONE;
        v.signal.replaceChildren(...(connected ? signal(sta.rssi, signalBars(sta.rssi)) : [VALUES.NONE]));
        v.ip.textContent = ipv4(sta.ipv4);
        v.netmask.textContent = ipv4(sta.netmask);
        v.gateway.textContent = isZero(sta.gateway) ? VALUES.NONE : ipv4(sta.gateway);
        v.dns.textContent = isZero(sta.dns) ? VALUES.NONE : ipv4(sta.dns);
        v.assignment.textContent = sta.ipv4Mode === Ipv4Mode.STATIC ? NETWORK.MANUAL : NETWORK.AUTOMATIC_DHCP;
        v.ipv6.textContent = isZero(sta.ipv6) ? VALUES.NONE : ipv6(sta.ipv6);
        v.mac.textContent = hw ? macText(hw.mac) : VALUES.NONE;
        v.ap.textContent = !ap?.on ? VALUES.NONE
            : overAp(this.setup.state.interface) ? `${ap.ssid}, ${ipv4(ap.ipv4)}` : ipv4(ap.ipv4);
        for (const key of ['signal', 'ip', 'netmask', 'gateway', 'dns', 'ipv6']) {
            showRow(this.rows, key, connected);
        }
        showRow(this.rows, 'ap', Boolean(ap?.on));
        showRow(this.rows, 'assignment', Boolean(sta.ssid));
    }

    async savePower() {
        const s = this.setup.state.settings;
        if (!s) {
            return;
        }
        const f = this.power.elements;
        const { errors, fields } = checkSettings({ ...s, board: String(s.board),
            bootWindowAuto: s.bootWindowMs === BOOT_WINDOW_AUTO,
            bootWindowMs: String(s.bootWindowMs), changeCheckMs: String(s.changeCheckMs),
            wifiPowerSave: this.powerSave.box.checked, wifiRescanS: f.wifiRescanS.value,
            wifiRescanDb: f.wifiRescanDb.value });
        if (!showErrors(this.power, this.powerMsg, errors)) {
            return;
        }
        if (await this.setup.save(this.powerMsg, Command.SET_SETTINGS, fields, SETTINGS.SAVED)) {
            this.power.dirty = false;
            await this.setup.reload('settings');
        }
    }
}

/**
 * The access point's name and password, displayed and changed only over the
 * access point. GET_WIFI_AP doesn't return the password, so it is always
 * entered.
 */
export class WifiApView extends View {
    constructor(setup) {
        super(setup);
        this.msg = message();
        this.form = editable(h('form', { onsubmit: (e) => { e.preventDefault(); this.form.run(() => this.save()); } },
            field(WIFI_AP.NAME, input('apSsid', { maxLength: SSID_MAX })),
            field(WIFI_AP.PASSWORD, input('apPassword', { type: 'password', autocomplete: 'new-password',
                maxLength: WIFI_PASSWORD_MAX })),
            h('div', { class: 'row' }, h('button', { class: 'primary' }, SETTINGS.SAVE)), this.msg),
        (f) => f.elements.apSsid.value !== '' && f.elements.apPassword.value !== '');
        this.element = card(WIFI_AP.TITLE, WIFI_AP.TIP, this.form);
        this.element.hidden = true;
        this.forms = [this.form];
    }

    update({ ap, interface: via }) {
        this.connection(this.msg);
        this.element.hidden = !overAp(via);
        if (ap && !this.form.dirty) {
            this.form.elements.apSsid.value = ap.ssid;
            this.form.filled();
        }
    }

    // Airfrog restarts the access point with the new settings, which drops
    // this page's connection until the computer joins the access point
    // again.
    async save() {
        const f = this.form.elements;
        const ssid = f.apSsid.value;
        const { errors, fields } = checkWifiAp(ssid, f.apPassword.value);
        if (!showErrors(this.form, this.msg, errors)) {
            return;
        }
        const saved = WIFI_AP.SAVED;
        this.setup.expectClose({ message: saved });
        f.apPassword.value = '';
        if (await this.setup.save(this.msg, Command.SET_WIFI_AP, fields, saved)) {
            this.form.dirty = false;
        } else {
            this.setup.cancelExpected();
        }
    }
}

/** A network's security mark: a padlock when it needs a password, nothing when it is open. */
function securityMark(security) {
    if (security === ScanSecurity.PASSWORD) {
        return h('span', { class: 'padlock', role: 'img', 'aria-label': NETWORK.REQUIRES_PASSWORD });
    }
    return security === ScanSecurity.UNSUPPORTED ? h('span', { class: 'lock' }, NETWORK.NOT_SUPPORTED) : null;
}

export class JoinView extends View {
    constructor(setup) {
        super(setup);
        this.msg = message();
        this.scanMsg = message();
        this.savedSsid = '';
        // Enter doesn't save a network before its password is typed.
        this.ssid = input('ssid', { maxLength: SSID_MAX, oninput: () => this.ssidEdited(),
            onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); } } });
        this.password = input('password', { type: 'password', maxLength: WIFI_PASSWORD_MAX });
        this.scanButton = button(NETWORK.SCAN, () => this.scan());
        this.networks = h('ul', { class: 'nets', hidden: true });
        this.staticIpv4 = check('staticIpv4', NETWORK.STATIC_IP, NETWORK.STATIC_IP_TIP, {
            onchange: () => this.showStatic(),
        });
        this.staticFields = h('div', { class: 'stack', hidden: true },
            field(NETWORK.IP_ADDRESS, input('address', { inputMode: 'decimal' })),
            field(NETWORK.SUBNET_MASK, input('netmask', { inputMode: 'decimal' })),
            field(NETWORK.GATEWAY_OPTIONAL, input('gateway', { inputMode: 'decimal' })),
            field(NETWORK.DNS_SERVER_OPTIONAL, input('dns', { inputMode: 'decimal' })));
        this.form = editable(h('form', { onsubmit: (e) => { e.preventDefault(); this.form.run(() => this.save()); } },
            field(NETWORK.NETWORK_NAME, h('div', { class: 'field' }, this.ssid, this.scanButton)),
            this.scanMsg, this.networks,
            field(NETWORK.PASSWORD_OPTIONAL, this.password, NETWORK.PASSWORD_TIP(KEPT_PASSWORD)),
            this.staticIpv4.element, this.staticFields,
            h('div', { class: 'row' }, h('button', { class: 'primary' }, NETWORK.SAVE_AND_CONNECT)),
            this.msg), (f) => changed(f) && this.ssid.value.trim() !== '');
        this.element = card(NETWORK.JOIN_TITLE, NETWORK.JOIN_TIP, this.form);
        this.forms = [this.form];
    }

    /** Shows the static fields, filled from the current DHCP lease when empty, as a router's are. */
    showStatic() {
        const on = this.staticIpv4.box.checked;
        this.staticFields.hidden = !on;
        const f = this.form.elements;
        // Hidden fields keep the values filled from Airfrog, so they don't
        // count as a change.
        if (!on && this.filledStatic) {
            STATIC_FIELDS.forEach((name, i) => { f[name].value = this.filledStatic[i]; });
        }
        const sta = this.setup.state.sta;
        if (on && !f.address.value && sta?.state === StaState.CONNECTED) {
            f.address.value = ipv4(sta.ipv4);
            f.netmask.value = ipv4(sta.netmask);
            f.gateway.value = isZero(sta.gateway) ? '' : ipv4(sta.gateway);
            f.dns.value = isZero(sta.dns) ? '' : ipv4(sta.dns);
        }
        if (on && !f.netmask.value) {
            f.netmask.value = '255.255.255.0';
        }
    }

    /** A new network name clears a kept password, which is the old network's. */
    ssidEdited() {
        if (this.password.value === KEPT_PASSWORD && this.ssid.value !== this.savedSsid) {
            this.password.value = '';
        }
    }

    update({ sta }) {
        this.connection(this.msg, this.scanMsg);
        if (this.joining && !this.setup.state.joining) {
            // Over serial the join watch has ended, joined or not.
            const joined = sta?.state === StaState.CONNECTED && sta.ssid === this.joining;
            this.msg.say(joined ? '' : NETWORK.NOT_JOINED(this.joining), joined ? '' : 'bad');
            this.joining = null;
        }
        this.scanButton.disabled = this.scanning || !this.setup.state.connected;
        if (!sta || this.form.dirty) {
            return;
        }
        const f = this.form.elements;
        this.savedSsid = sta.ssid;
        f.ssid.value = sta.ssid;
        f.password.value = sta.password ? KEPT_PASSWORD : '';
        this.staticIpv4.box.checked = sta.ipv4Mode === Ipv4Mode.STATIC;
        if (this.staticIpv4.box.checked) {
            f.address.value = ipv4(sta.ipv4);
            f.netmask.value = ipv4(sta.netmask);
            f.gateway.value = isZero(sta.gateway) ? '' : ipv4(sta.gateway);
            f.dns.value = isZero(sta.dns) ? '' : ipv4(sta.dns);
        }
        this.filledStatic = STATIC_FIELDS.map(name => f[name].value);
        this.showStatic();
        this.form.filled();
    }

    choose(net) {
        this.form.dirty = true;
        this.ssid.value = net.ssid;
        this.networks.hidden = true;
        if (net.ssid !== this.savedSsid || this.password.value !== KEPT_PASSWORD) {
            this.password.value = '';
        }
        if (net.security === ScanSecurity.PASSWORD && !this.password.value) {
            this.password.focus?.();
        }
        this.form.refresh();
    }

    async scan() {
        this.scanning = true;
        this.setup.render();
        this.networks.hidden = true;
        this.scanMsg.say(NETWORK.SCANNING);
        const deadline = Date.now() + SCAN_LIMIT_MS;
        let result = null;
        let start = true;
        // While AP mode is on a scan can drop this page's connection for a
        // moment, so a failed request is tried again.
        while (Date.now() < deadline) {
            try {
                result = parseWifiScan(await this.setup.command(Command.WIFI_SCAN, encodeWifiScan(start)));
                start = false;
                if (result.state !== ScanState.SCANNING) {
                    break;
                }
            } catch (e) {
                result = null;
            }
            await sleep(SCAN_POLL_MS);
        }
        this.scanning = false;
        this.setup.render();
        if (!result || result.state !== ScanState.DONE) {
            this.scanMsg.say(NETWORK.SCAN_FAILED, 'bad');
            return;
        }
        if (!result.networks.length) {
            this.scanMsg.say(NETWORK.NO_NETWORKS);
            return;
        }
        this.scanMsg.say('');
        this.networks.replaceChildren(...result.networks.map(net => {
            const usable = net.security !== ScanSecurity.UNSUPPORTED;
            return h('li', {
                tabindex: usable ? 0 : -1, role: 'option', 'aria-disabled': usable ? null : 'true',
                onclick: () => usable && this.choose(net),
                onkeydown: (e) => { if (usable && e.key === 'Enter') { e.preventDefault(); this.choose(net); } },
            }, h('span', { class: `bars b${signalBars(net.rssi)}`, role: 'img', 'aria-label': VALUES.DBM(net.rssi) },
                h('i'), h('i'), h('i'), h('i')),
            h('span', { class: 'name' }, net.ssid), securityMark(net.security));
        }));
        this.networks.hidden = false;
    }

    async save() {
        const setup = this.setup;
        const f = this.form.elements;
        const values = Object.fromEntries(['ssid', 'password', 'address', 'netmask', 'gateway', 'dns']
            .map(name => [name, f[name].value]));
        const keepPassword = values.password === KEPT_PASSWORD;
        const { errors, fields } = checkWifi({ ...values, password: keepPassword ? '' : values.password, keepPassword,
            staticIpv4: this.staticIpv4.box.checked });
        if (!showErrors(this.form, this.msg, errors)) {
            return;
        }
        // Airfrog saves a home network over the access point only once it
        // has a password.
        if (overAp(setup.state.interface) && !setup.state.hasPassword) {
            this.msg.say(PASSWORD.FIRST_SETUP, 'bad');
            return;
        }
        const host = setup.state.hostname ? `${setup.state.hostname}.local` : location.host;
        setup.expectClose({ message: linked(NETWORK.JOINING_RECONNECT(values.ssid, `http://${host}/`)) });
        // The form keeps what was saved until the next connection reads it.
        if (await setup.save(this.msg, Command.SET_WIFI_STA, fields, NETWORK.JOINING(values.ssid))) {
            setup.joined(values.ssid);
            if (!setup.closes) {
                this.joining = values.ssid;
                // Over serial nothing reconnects, so the form refills from a read.
                this.form.dirty = false;
                await this.read('sta');
            }
        } else {
            setup.cancelExpected();
        }
    }
}

export class HostnameView extends View {
    constructor(setup) {
        super(setup);
        this.msg = message();
        this.name = input('hostname', { maxLength: HOSTNAME_MAX });
        this.form = editable(h('form', { onsubmit: (e) => { e.preventDefault(); this.form.run(() => this.save()); } },
            field(NETWORK.HOSTNAME, h('div', { class: 'field' }, this.name, h('span', { class: 'suffix' }, '.local')),
                NETWORK.HOSTNAME_TIP),
            h('div', { class: 'row' }, h('button', { class: 'primary' }, SETTINGS.SAVE)),
            this.msg));
        this.aliasesMsg = message();
        this.aliases = editable(h('form', { onsubmit: (e) => { e.preventDefault(); this.aliases.run(() => this.saveAliases()); } },
            field(NETWORK.HOST_ALIASES, input('aliases'), NETWORK.HOST_ALIASES_TIP),
            h('div', { class: 'row' }, h('button', { class: 'primary' }, SETTINGS.SAVE)),
            this.aliasesMsg));
        this.element = card(NETWORK.HOSTNAME, null, this.form, h('hr', { class: 'sep' }), this.aliases);
        this.forms = [this.form, this.aliases];
    }

    update({ hostname, aliases }) {
        this.connection(this.msg, this.aliasesMsg);
        if (hostname !== null && !this.form.dirty) {
            this.name.value = hostname;
            this.form.filled();
        }
        if (aliases && !this.aliases.dirty) {
            this.aliases.elements.aliases.value = aliases.join(' ');
            this.aliases.filled();
        }
    }

    async save() {
        const setup = this.setup;
        const name = this.name.value.trim();
        const { errors, fields } = checkHostname(name);
        if (!showErrors(this.form, this.msg, errors)) {
            return;
        }
        setup.expectClose({ message: linked(NETWORK.HOSTNAME_RECONNECT(name, `http://${name}.local/`)) });
        if (!await setup.save(this.msg, Command.SET_HOSTNAME, fields, NETWORK.HOSTNAME_CHANGED(name))) {
            setup.cancelExpected();
        } else if (!setup.closes) {
            this.form.dirty = false;
            await this.read('hostname');
        }
    }

    async saveAliases() {
        const { errors, fields } = checkAliases(this.aliases.elements.aliases.value);
        if (!showErrors(this.aliases, this.aliasesMsg, errors)) {
            return;
        }
        if (await this.setup.save(this.aliasesMsg, Command.SET_HOST_ALIASES, fields, SETTINGS.SAVED)) {
            this.aliases.dirty = false;
            await this.setup.reload('aliases');
        }
    }
}
