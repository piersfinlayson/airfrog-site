// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Fills airfrog.org/cli's Downloads table from the CLI manifest, with a row for
// each architecture that has a latest release, in CLI_TARGETS' order.

import { AIRFROG_MANIFEST, MANIFEST_KEY } from '../commissioning/manifest-key.js';
import { sentence } from '../commissioning/explain.js';
import { COMMISSIONING_FIRMWARE } from '../js/messages.js';
import { CLI_TARGETS } from '../js/schema.js';
import { latestDownloads } from './releases.js';

const table = document.getElementById('downloads-table');
const message = document.getElementById('downloads-message');

function show(target, { version, url, file }) {
  const link = document.createElement('a');
  link.href = url;
  link.textContent = file;
  const row = table.insertRow();
  row.dataset.target = target;
  row.append(...[CLI_TARGETS[target] ?? target, version, link].map((content) => {
    const cell = document.createElement('td');
    cell.append(content);
    return cell;
  }));
}

try {
  const downloads = await latestDownloads(AIRFROG_MANIFEST, MANIFEST_KEY);
  const order = Object.keys(CLI_TARGETS);
  const place = (target) => (order.includes(target) ? order.indexOf(target) : order.length);
  [...downloads].sort(([a], [b]) => place(a) - place(b)).forEach(([target, download]) => show(target, download));
} catch (err) {
  message.textContent = [sentence(err), MANIFEST_KEY ? COMMISSIONING_FIRMWARE.RELOAD : ''].filter((t) => t).join(' ');
  message.hidden = false;
}
