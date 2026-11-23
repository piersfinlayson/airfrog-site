// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { scopeCss, toolCss } from '../../ci/tool-css-source.mjs';

test('commissioning/tool.css is current: run node ci/tool-css.mjs', () => {
    assert.equal(readFileSync(new URL('../../commissioning/tool.css', import.meta.url), 'utf8'), toolCss());
});

test('scopeCss puts every selector inside the scope', () => {
    const css = scopeCss(':root { --a: 1; }\n@media (x) { :root { --a: 2; } }\nbody { margin: 0; }\n* { b: 1; }\n'
        + 'a, .x:not(.y, .z) { c: 1; }\n@keyframes k { to { d: 1; } }\n', '.s');
    assert.equal(css, '.s { --a: 1; }\n@media (x) {\n.s { --a: 2; }\n}\n.s { margin: 0; }\n.s, .s * { b: 1; }\n'
        + '.s a, .s .x:not(.y, .z) { c: 1; }\n@keyframes k { to { d: 1; } }\n');
});

test('every rule of commissioning/tool.css is inside .tool', () => {
    const css = toolCss().replace(/\/\*.*?\*\//gs, '').replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    // The text before each "{" back to the last "{", "}" or ";" is a selector list or an at-rule.
    const heads = [...css.matchAll(/([^{};]+)\{/g)].map(m => m[1].trim()).filter(head => !head.startsWith('@'));
    assert.ok(heads.length > 100, `${heads.length} rules`);
    for (const head of heads) {
        for (const selector of head.split(/,(?![^(]*\))/)) {
            assert.ok(selector.trim().startsWith('.tool'), `${selector.trim()} isn't inside .tool`);
        }
    }
    assert.ok(heads.some(head => head === '.tool, .tool *'), '* is scoped');
});

test('the cards, direct children of .tool, keep the auto margins of .tool > *', () => {
    const css = toolCss().replace(/\/\*.*?\*\//gs, '');
    const rules = [...css.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map(m => [m[1].trim(), m[2]]);
    const cards = rules.filter(([head]) => head.split(/,(?![^(]*\))/).some(s => ['.tool .warn', '.tool .card', '.tool section'].includes(s.trim())));
    assert.ok(cards.some(([head]) => head.includes('.tool .warn')), '.tool .warn has a rule');
    for (const [head, body] of cards) {
        assert.ok(!/(^|[;\s])margin(-left|-right|-inline[a-z-]*)?\s*:/.test(body), `${head} sets a left or right margin`);
    }
});
