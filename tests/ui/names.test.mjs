// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Names for display, and the target and pin map descriptions.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TargetInfo } from '../../js/airfrog.js';
import { boardName, describeMcu, describeServices, ipv6, macText, mcuName, serviceNames, signalBars, sizeText,
    targetState, versionText } from '../../ui/src/names.js';
import { describeTarget } from '../../ui/src/ui/target.js';
import { connectorPins } from '../../ui/src/ui/pins.js';
import { TARGETS, targetPayload } from './fake-airfrog.mjs';

const target = (t) => TargetInfo.parse(targetPayload(t));
/** TARGETID in the format Airfrog reports an STM32's ROM table in. */
const st = (part) => ((part << 12) | (0x020 << 1) | 1) >>> 0;

test('MCUs from TARGETID', () => {
    assert.equal(mcuName(0x00040927), 'RP2350');
    assert.equal(mcuName(0x10040927), 'RP2350');
    assert.equal(mcuName(0x01002927), 'RP2040');
    assert.equal(mcuName(st(0x410)), 'STM32F103');
    assert.equal(mcuName(st(0x430)), 'STM32F103');
    assert.equal(mcuName(st(0x423)), 'STM32F401');
    assert.equal(mcuName(st(0x433)), 'STM32F401');
    assert.equal(mcuName(st(0x431)), 'STM32F411');
    assert.equal(mcuName(0x0ba02477), null);
    assert.equal(describeMcu(0x0ba02477), 'Unknown MCU (ID 0x0ba02477)');
    assert.equal(describeMcu(0), 'Unknown');
});

/** GET_BOARDS's boards, as the firmware reports them. */
const BOARDS = [{ board: 1, target: 'Pico', name: '' }, { board: 4, target: 'Black Pill', name: '' },
    { board: 0x100, target: 'One ROM', name: 'fire-24-c' }, { board: 0x102, target: 'One ROM', name: 'fire-24-e' }];

test("boards from GET_BOARDS: the target, then the board's name within it", () => {
    assert.equal(boardName(0, BOARDS), '-');
    assert.equal(boardName(1, BOARDS), 'Pico');
    assert.equal(boardName(4, BOARDS), 'Black Pill');
    assert.equal(boardName(0x100, BOARDS), 'One ROM fire-24-c');
    assert.equal(boardName(0x200, BOARDS), 'Board 0x200');
    assert.equal(boardName(1, null), 'Board 0x1', 'before GET_BOARDS is read');
});

test('services by their AWP names, with operations where only some are supported', () => {
    assert.deepEqual(serviceNames(target(TARGETS.running).services),
        ['RESET', 'SWD_MEMORY', 'PICOBOOT_ORICP', 'RBCP_ORICP', 'GPIO']);
    assert.deepEqual(serviceNames([{ service: 1, operation: 1 }, { service: 1, operation: 3 }, { service: 9, operation: 0 }]),
        ['RESET: RESET, RESET_PINS', 'Service 9']);
    assert.deepEqual(describeServices([{ service: 1, operation: 0 }, { service: 3, operation: 0 }]),
        [{ text: 'RESET', description: "Resets the target using Airfrog's GPIOs." },
            { text: 'PICOBOOT_RP2350_SWD', description: null }]);
});

test('versions, signal, sizes and MAC addresses for display', () => {
    assert.equal(versionText('0.2.0'), 'v0.2.0');
    assert.equal(versionText('v0.2.0', '1a2b3c4d'), 'v0.2.0 (1a2b3c4d)');
    assert.deepEqual([-40, -55, -56, -67, -70, -78, -90].map(signalBars), [4, 4, 3, 3, 2, 2, 1]);
    assert.equal(sizeText(4 << 20), '4 MB');
    assert.equal(sizeText(512 << 10), '512 KB');
    assert.equal(macText(new Uint8Array([0x24, 0x0a, 0xc4, 1, 2, 3])), '24:0A:C4:01:02:03');
});

test('IPv6 addresses', () => {
    const a = new Uint8Array(16);
    a.set([0xfe, 0x80]);
    a[15] = 1;
    assert.equal(ipv6(a), 'fe80::1');
    assert.equal(ipv6(new Uint8Array(16)), '::');
    assert.equal(ipv6(new Uint8Array([0x20, 1, 0xd, 0xb8, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1])), '2001:db8:0:1::1');
});

test("the target's state as TARGET: STATE", () => {
    assert.deepEqual(targetState(target(TARGETS.identifying)), { text: 'Target: Identifying', ok: false });
    assert.deepEqual(targetState(target(TARGETS.running)), { text: 'One ROM: Running', ok: true });
    assert.deepEqual(targetState(target(TARGETS.bootloader)), { text: 'One ROM: Stopped', ok: false });
    assert.deepEqual(targetState(target({ ...TARGETS.bootloader, firmware: 2 })),
        { text: 'One ROM Lab: Stopped', ok: false });
    assert.deepEqual(targetState(target({ ...TARGETS.running, firmware: 2 })),
        { text: 'One ROM Lab: Running', ok: true });
    assert.deepEqual(targetState(target(TARGETS.pico)), { text: 'Target: No firmware found', ok: false });
    assert.deepEqual(targetState(target({ ...TARGETS.pico, swd: 1 })), { text: 'Target: Not found', ok: false });
});

test('what Airfrog found, on any target', () => {
    assert.deepEqual(describeTarget(target(TARGETS.pico), { board: 1 }, BOARDS),
        { mcu: 'RP2040', firmware: 'Target: No firmware found', board: 'Pico' });
    const d = describeTarget(target(TARGETS.running), { board: 0x102 }, BOARDS);
    assert.equal(d.firmware, 'One ROM: Running');
    assert.equal(d.board, 'One ROM fire-24-e');
    assert.equal(describeTarget(target(TARGETS.bootloader), null, BOARDS).firmware, 'One ROM: Stopped');
    assert.deepEqual(describeTarget(target(TARGETS.identifying), { board: 0x102 }, BOARDS),
        { mcu: '-', firmware: 'Target: Identifying', board: '-' }, 'the board isn\'t displayed while identifying');
    assert.equal(describeTarget(target({ ...TARGETS.pico, swd: 1 }), null, BOARDS).mcu, 'No response');
});

test("every pin of J1 and J2, with the target's names from the pin map", () => {
    const entries = [{ name: 'SWDIO', pin: 'J1-3', role: 0 }, { name: 'SEL_D', pin: 'J1-3', role: 0 },
        { name: 'RUN', pin: 'J1-4', role: 1, activeLevel: 1 }, { name: 'SWCLK', pin: 'J1-5', role: 0 }];
    const pins = connectorPins(entries);
    assert.equal(pins.length, 19);
    const by = Object.fromEntries(pins.map(p => [p.pin, p]));
    assert.deepEqual(by['J1-1'], { pin: 'J1-1', name: 'GND' });
    assert.equal(by['J1-2'].name, '5V');
    assert.equal(by['J1-3'].name, 'SWDIO / SEL_D');
    assert.deepEqual(by['J1-4'], { pin: 'J1-4', name: 'RUN' });
    assert.equal(by['J1-10'].name, '');
    assert.equal(by['J2-2'].name, 'SWDIO / SEL_D', 'J2-2 is the same line as J1-3');
    assert.equal(by['J2-3'].name, 'SWCLK');
    assert.deepEqual(['J2-1', 'J2-4', 'J2-5', 'J2-6', 'J2-7', 'J2-8', 'J2-9'].map(p => by[p].name),
        ['GND', 'DTR', 'RTS', 'BOOT', 'RXD0', 'TXD0', 'EN']);
    assert.equal(connectorPins([]).find(p => p.pin === 'J1-3').name, '');
});
