// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The `@af ` line encoder and decoder.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LineDecoder, MAX_LINE, decodeLine, encodeLine } from '../../js/setup/serial.js';

const ascii = (s) => new TextEncoder().encode(s);
const lineText = (bytes) => new TextDecoder().decode(bytes);
// The 48-byte header in base64 is 64 characters. These are HELLO's and
// GET_HOSTNAME's requests, and an ERROR response.
const HELLO = '@af AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const GET_HOSTNAME = '@af EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwA=';
const ERROR = '@af BAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwA=';
const empty = new Uint8Array(0);

function decodeAll(chunks) {
  const lines = [];
  const decoder = new LineDecoder((line) => lines.push(line));
  for (const c of chunks) decoder.push(typeof c === 'string' ? ascii(c) : c);
  return lines;
}

test('encodes an empty HELLO with the header', () => {
  assert.equal(lineText(encodeLine(0x01)), HELLO + '\n');
});

test('encodes AIRFROG_CMD GET_HOSTNAME', () => {
  assert.equal(lineText(encodeLine(0x10, new Uint8Array([0x07, 0x00]))), GET_HOSTNAME + '\n');
});

test('encodes AIRFROG_CMD SET_HOSTNAME with a text field', () => {
  const payload = new Uint8Array([0x08, 0x00, 0x05, 0x00, ...ascii('bench')]);
  assert.equal(lineText(encodeLine(0x10, payload)),
    '@af EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAFAGJlbmNo\n');
});

test('encodes the flags', () => {
  assert.equal(lineText(encodeLine(0x04, new Uint8Array([7, 0]), 1)), ERROR + '\n');
});

test('decodes a message line with its flags', () => {
  assert.deepEqual(decodeLine(ascii(ERROR)), { type: 0x04, flags: 1, payload: new Uint8Array([7, 0]) });
});

test("doesn't check counter or hmac", () => {
  const message = new Uint8Array(50).fill(0xa5);
  message.set([0x10, 0, 1, 0]);
  const line = '@af ' + btoa(String.fromCharCode(...message));
  assert.deepEqual(decodeLine(ascii(line)), { type: 0x10, flags: 1, payload: new Uint8Array([0xa5, 0xa5]) });
});

test('ignores a carriage return before the newline', () => {
  assert.deepEqual(decodeAll([HELLO + '\r\n']), [{ type: 1, flags: 0, payload: empty }]);
  assert.deepEqual(decodeAll(['I (1) wifi: up\r\n']), [{ log: 'I (1) wifi: up' }]);
});

test('passes other lines as log', () => {
  assert.deepEqual(decodeAll(['ESP-ROM:esp32c3\n', '\n', '@AF AQA=\n', 'x @af AQA=\n']), [
    { log: 'ESP-ROM:esp32c3' }, { log: '' }, { log: '@AF AQA=' }, { log: 'x @af AQA=' },
  ]);
});

test('passes malformed message lines, and messages shorter than the header, as log', () => {
  for (const s of ['@af', '@af ', '@af AQA', '@af AQ=A', '@af !!!!', '@af AA==', '@af AQA= ', '@af AQA=',
    HELLO.slice(0, -4)]) {
    assert.deepEqual(decodeAll([s + '\n']), [{ log: s }], s);
  }
});

test('joins lines split across chunks', () => {
  const stream = `boot log\r\n${GET_HOSTNAME}\r\nI (2) more\n${HELLO}\n`;
  const want = [
    { log: 'boot log' },
    { type: 0x10, flags: 0, payload: new Uint8Array([7, 0]) },
    { log: 'I (2) more' },
    { type: 0x01, flags: 0, payload: empty },
  ];
  assert.deepEqual(decodeAll([...stream]), want);
  assert.deepEqual(decodeAll(['boot log\r', '\n' + GET_HOSTNAME.slice(0, 9), GET_HOSTNAME.slice(9) + '\r\nI (2) m',
    'ore\n' + HELLO + '\n']), want);
  assert.deepEqual(decodeAll([stream]), want);
});

test('holds a line until its newline', () => {
  assert.deepEqual(decodeAll([HELLO]), []);
});

test(`keeps a line of ${MAX_LINE} bytes and discards a longer one`, () => {
  const max = 'a'.repeat(MAX_LINE);
  assert.deepEqual(decodeAll([max + '\n']), [{ log: max }]);
  assert.deepEqual(decodeAll([max + '\r\n']), [{ log: max }]);
  assert.deepEqual(decodeAll([max + 'a\n', HELLO + '\n']), [{ type: 1, flags: 0, payload: empty }]);
  assert.deepEqual(decodeAll([max + 'a\r\n', 'next\n']), [{ log: 'next' }]);
});

test('discards a long line that arrives in pieces', () => {
  const piece = 'b'.repeat(1000);
  const chunks = Array(20).fill(piece);
  assert.deepEqual(decodeAll([...chunks, '\nafter\n']), [{ log: 'after' }]);
});
