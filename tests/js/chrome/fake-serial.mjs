// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// A fake serial port and a fake esptool-js for headless Chrome tests of
// airfrog.org/commissioning. A page gets the fake serial port from a script
// run in each new document (fakeSerial), and the fake esptool-js in place of
// commissioning/vendor/esptool.js (ESPTOOL).

import { OTADATA, OTA_0, app, otadata, regions } from '../../commissioning/flash.mjs';

/** The fake esptool-js: a board configured by window.__board, with every call recorded in window.__calls. */
export const ESPTOOL = `
const board = () => window.__board;
const calls = () => window.__calls;
export class Transport {
  constructor(port) { this.port = port; }
  async disconnect() { calls().push('disconnect'); }
}
export class ESPLoader {
  constructor({ transport }) {
    this.transport = transport;
    this.chip = { CHIP_NAME: board().name, getChipFeatures: async () => board().features };
  }
  async main() { calls().push('main'); return board().name + ' (revision v0.4)'; }
  async detectFlashSize() { return '4MB'; }
  async readFlash(address, size) {
    calls().push('readFlash');
    const out = new Uint8Array(size).fill(0xff);
    for (const [offset, hex] of board().regions) {
      const bytes = Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
      for (let i = Math.max(address, offset); i < Math.min(address + size, offset + bytes.length); i++) {
        out[i - address] = bytes[i - offset];
      }
    }
    return out;
  }
  async eraseFlash() { calls().push('eraseFlash'); }
  async writeFlash(options) {
    if (board().failWrite) throw new Error('Write failed');
    calls().push('writeFlash ' + options.fileArray.map((f) => f.address).join(','));
  }
}
`;

/** Defines navigator.serial with a port that records its calls, and the board. */
export const fakeSerial = (board) => `
window.__calls = [];
window.__board = ${JSON.stringify(board)};
const port = {
  readable: new ReadableStream(), writable: new WritableStream(),
  open: async () => window.__calls.push('port.open'),
  close: async () => window.__calls.push('port.close'),
  setSignals: async () => {},
};
Object.defineProperty(navigator, 'serial', { value: { requestPort: async () => port } });
`;

const hex = (bytes) => Buffer.from(bytes).toString('hex');

/** The board of an MCU. When installed is provided, its flash holds that model's firmware, selected by otadata. */
export function boardOf(name, features, installed) {
  const flashRegions = installed === undefined ? [] : regions([OTA_0, app(installed)], [OTADATA, otadata(1)]);
  return { name, features, regions: flashRegions.map(([offset, bytes]) => [offset, hex(bytes)]) };
}

