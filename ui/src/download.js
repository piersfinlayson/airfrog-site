// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The text of a failed download in Airfrog's full user interface.

import { HOME_PAGE } from '../../js/messages.js';

/** @returns {string} the text of e, js/setup/download.js's error */
export function downloadText(e) {
    if (e.timedOut) {
        return HOME_PAGE.DOWNLOAD_TIMED_OUT;
    }
    return e.status === null ? HOME_PAGE.DOWNLOAD_FAILED : HOME_PAGE.DOWNLOAD_HTTP(e.status);
}
