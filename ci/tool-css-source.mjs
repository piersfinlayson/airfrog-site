// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// commissioning/tool.css's contents, for ci/tool-css.mjs and its test.

import { COLOURS, FONT, RULES } from '../js/setup/style.js';

/**
 * css with every selector inside scope. The :root and body rules apply to
 * scope itself.
 * @param {string} css - rules, @media blocks and @keyframes blocks only
 * @param {string} scope - a selector
 * @returns {string}
 */
export function scopeCss(css, scope) {
    const scopeSelector = (selector) => {
        selector = selector.trim();
        if (selector === ':root' || selector === 'body') {
            return scope;
        }
        return selector === '*' ? `${scope}, ${scope} *` : `${scope} ${selector}`;
    };
    const splitSelectors = (list) => {
        const selectors = [];
        let depth = 0;
        let start = 0;
        for (let i = 0; i < list.length; i++) {
            if (list[i] === '(') depth++;
            else if (list[i] === ')') depth--;
            else if (list[i] === ',' && depth === 0) {
                selectors.push(list.slice(start, i));
                start = i + 1;
            }
        }
        selectors.push(list.slice(start));
        return selectors;
    };
    const out = [];
    let i = 0;
    while (i < css.length) {
        const open = css.indexOf('{', i);
        if (open < 0) {
            break;
        }
        const head = css.slice(i, open).trim();
        let depth = 1;
        let close = open + 1;
        while (depth > 0) {
            if (css[close] === '{') depth++;
            else if (css[close] === '}') depth--;
            close++;
        }
        const body = css.slice(open + 1, close - 1);
        if (head.startsWith('@keyframes')) {
            out.push(`${head} {${body}}`);
        } else if (head.startsWith('@')) {
            out.push(`${head} {\n${scopeCss(body, scope)}}`);
        } else {
            out.push(`${splitSelectors(head).map(scopeSelector).join(', ')} {${body}}`);
        }
        i = close;
    }
    return out.join('\n') + '\n';
}

/**
 * Properties airfrog.org's site.css sets on elements and classes the tool
 * also uses. They return to the browser's values so the tool's own rules
 * apply as they do on Airfrog's home page.
 */
const SITE_CSS_RESET = `
h2, h3 { margin: revert; font-size: revert; line-height: revert; letter-spacing: revert; }
p, ul, ol { margin: revert; padding: revert; }
li { margin: revert; }
code, pre { margin: revert; padding: revert; font: revert; background: revert; border-radius: revert; }
table { width: revert; margin: revert; font-size: revert; }
.warn { margin-top: revert; margin-bottom: revert; padding: revert; background: revert; border-left: revert; border-radius: revert; }
`;

/** The tool's own rules, after the stylesheet of Airfrog's internal JS setup module. */
const TOOL = `
.tool { font: ${FONT}; color: var(--fg); }
.tool > * { max-width: 720px; margin-left: auto; margin-right: auto; }
`;

export function toolCss() {
    return '/* Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>. MIT License. */\n'
        + '/* Written by ci/tool-css.mjs from js/setup/style.js. Every rule applies only inside .tool. */\n'
        + scopeCss(COLOURS, '.tool') + scopeCss(SITE_CSS_RESET, '.tool') + scopeCss(RULES, '.tool') + TOOL;
}
