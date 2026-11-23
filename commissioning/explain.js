// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// airfrog.org/commissioning's message for an error and the step to take next,
// as [message, next].

import { COMMISSIONING_FIRMWARE } from '../js/messages.js';

export function sentence(e) {
  const s = e?.message || String(e);
  return /[.!?]$/.test(s) ? s : s + '.';
}

// An error starting Airfrog's firmware and reading its settings. setup is
// Airfrog's internal JS setup module, whose serial client's errors these are.
export function explainStart(err, setup) {
  if (setup && err instanceof setup.HelloTimeoutError) {
    return [COMMISSIONING_FIRMWARE.NO_SERIAL_RESPONSE, COMMISSIONING_FIRMWARE.CHECK_TX];
  }
  if (err instanceof DOMException || (setup && err instanceof setup.ClosedError)) {
    return [COMMISSIONING_FIRMWARE.SERIAL_FAILED(sentence(err)), COMMISSIONING_FIRMWARE.CHECK_ADAPTER];
  }
  return [sentence(err), COMMISSIONING_FIRMWARE.KEEP_TO_RETRY];
}
