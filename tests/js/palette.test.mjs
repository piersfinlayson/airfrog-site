// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { COLOURS } from '../../js/setup/style.js';

/** A colour in lower case with a three digit form expanded. */
const normal = (value) => value.trim().toLowerCase().replace(/^#(.)(.)(.)$/, '#$1$1$2$2$3$3');

/** The variables a :root block declares. */
const variables = (block) => Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)]
    .map(([, name, value]) => [name, normal(value)]));

/** The light and dark variables of a stylesheet, the dark ones with the light ones they don't replace. */
function palette(css) {
    const dark = css.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/)[1];
    const light = css.replace(/@media[\s\S]*$/, '').match(/:root\s*\{([^}]*)\}/)[1];
    return { light: variables(light), dark: { ...variables(light), ...variables(dark) } };
}

test('a variable site.css and js/setup/style.js both define has the same value in light and dark', () => {
    const site = palette(readFileSync(new URL('../../site.css', import.meta.url), 'utf8'));
    const device = palette(COLOURS);
    let shared = 0;
    for (const mode of ['light', 'dark']) {
        for (const [name, value] of Object.entries(site[mode])) {
            if (name in device[mode]) {
                shared++;
                assert.equal(device[mode][name], value, `${name} in ${mode} mode`);
            }
        }
    }
    assert.ok(shared >= 16, `only ${shared} shared variables`);
});
