// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// The stylesheet of Airfrog's home page and airfrog.org/commissioning.

/**
 * The colour variables. The ones airfrog.org's site.css also defines have its
 * values.
 */
export const COLOURS = `
:root { --bg: #fff; --card: #f4f6f8; --fg: #1c2026; --muted: #5d6672; --line: #e2e5e9; --accent: #0b76a0;
        --accent-fg: #fff; --link: #0b76a0; --bad: #b3261e; --bad-fg: #fff; --warn: #8a5a00;
        --warn-bg: #fff6e0; --tip-bg: #1d1d1f; --tip-fg: #f5f5f7;
        --bar-bg: #161617; --bar-fg: #f5f5f7; --bar-muted: #a1a1a6; --bar-line: #3a3a3c;
        --bar-warn: #f0b350; --bar-warn-line: #9a6200; --highlight: #ffd60a; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #111417; --card: #181c20; --fg: #e5e8eb; --muted: #9aa3ad; --line: #2a2f35; --link: #4fb3dc;
          --bad: #f2827a; --bad-fg: #0e0e10; --warn: #f0c060; --warn-bg: #2b2412; --tip-bg: #f5f5f7;
          --tip-fg: #1d1d1f; }
}
`;

/** The page's font size, line height and family. */
export const FONT = '15px/1.45 system-ui, sans-serif';

/**
 * The colour variables and the page's font and colours. Airfrog's firmware
 * build puts them in the Airfrog home page as @BASE_CSS@, for the text it
 * displays before this module loads.
 */
export const BASE_CSS = `${COLOURS}body { margin: 0; background: var(--bg); color: var(--fg); font: ${FONT}; }
#loading { max-width: 720px; margin: 0 auto; padding: 16px; }
#loading.bad { color: var(--bad); }
`;

/** The rules for the page's content, after BASE_CSS. */
export const RULES = `* { box-sizing: border-box; }
a { color: var(--link); }
.bar { background: var(--bar-bg); color: var(--bar-fg); }
.bar-in { max-width: 720px; margin: 0 auto; padding: 8px 16px; display: flex; flex-wrap: wrap; align-items: center;
          gap: 4px 12px; }
.bar img { height: 56px; width: 56px; object-fit: contain; }
.bar .host { font-weight: 600; font-size: 17px; overflow-wrap: anywhere; }
.bar .sub { color: var(--bar-muted); font-size: 13px; }
.bar .sub .part { white-space: nowrap; }
.bar .pill { margin-left: auto; color: var(--bar-muted); border-color: var(--bar-line); }
.bar .pill.ok { color: var(--accent); border-color: var(--accent); }
.bar .pill.warn { color: var(--bar-warn); border-color: var(--bar-warn-line); }
nav.tabs { background: var(--card); border-bottom: 1px solid var(--line); }
nav.tabs .in { max-width: 720px; margin: 0 auto; padding: 0 8px; display: flex; flex-wrap: wrap; gap: 0 4px; }
nav.tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; padding: 10px 12px;
                  color: var(--muted); font-weight: 500; }
nav.tabs button[aria-selected=true] { color: var(--fg); border-bottom-color: var(--accent); }
main { max-width: 720px; margin: 0 auto; padding: 16px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
.card.warn { background: var(--warn-bg); border-color: var(--warn); }
.card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.card-head h2 { font-size: 17px; margin: 0; }
.card-head .pill { margin-left: auto; }
h3 { font-size: 14px; margin: 14px 0 6px; color: var(--muted); font-weight: 600; }
.pill { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; padding: 2px 10px; border-radius: 999px;
        border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
.pill::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.pill.ok { color: var(--accent); border-color: var(--accent); }
.pill.warn { color: var(--warn); border-color: var(--warn); }
.pill.bad { color: var(--bad); border-color: var(--bad); }
dl.kv { display: grid; grid-template-columns: minmax(7em, max-content) 1fr; gap: 6px 16px; margin: 0; }
dl.kv dt { color: var(--muted); }
dl.kv dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.mono { font-family: ui-monospace, monospace; font-size: 14px; }
form { display: grid; gap: 12px; }
label { display: grid; gap: 4px; color: var(--muted); font-size: 14px; }
label.check { display: flex; gap: 8px; align-items: center; color: var(--fg); font-size: 15px; }
.field { display: flex; gap: 8px; align-items: center; }
.field input { flex: 1; min-width: 0; }
.field .suffix { color: var(--muted); }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.actions { margin-top: 14px; }
.stack { display: grid; gap: 12px; }
button, input, select { font: inherit; padding: 7px 12px; border: 1px solid var(--line); border-radius: 8px;
                        background: var(--bg); color: var(--fg); }
input, select { width: 100%; max-width: 420px; }
input[type=checkbox] { width: auto; padding: 0; margin: 0; accent-color: var(--accent); }
input::placeholder { color: var(--muted); opacity: 0.7; }
input[aria-invalid] { border-color: var(--bad); }
button { cursor: pointer; white-space: nowrap; font-weight: 600; border-color: var(--accent); background: var(--accent);
         color: var(--accent-fg); }
button.danger { background: var(--bad); color: var(--bad-fg); border-color: var(--bad); }
button.cancel { background: var(--bg); color: var(--fg); border-color: var(--line); }
.file-name { color: var(--muted); overflow-wrap: anywhere; }
.file-check { display: inline-flex; align-items: center; gap: 6px; }
.file-check .bad { color: var(--bad); }
.file-check .warn { color: var(--warn); }
.spinner { width: 14px; height: 14px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%;
           animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.tick { width: 6px; height: 11px; margin: 0 4px 3px; border: solid var(--accent); border-width: 0 2px 2px 0;
        transform: rotate(45deg); }
.cross { position: relative; width: 12px; height: 12px; }
.cross::before, .cross::after { content: ""; position: absolute; left: 5px; top: 0; width: 2px; height: 12px;
                                background: var(--bad); transform: rotate(45deg); }
.cross::after { transform: rotate(-45deg); }
button:disabled, input:disabled, select:disabled { opacity: 0.5; cursor: default; }
.sep { border: 0; border-top: 1px solid var(--line); margin: 16px 0; }
.msg { min-height: 1.45em; color: var(--muted); }
.msg:empty { display: none; }
.msg.bad { color: var(--bad); }
.msg.ok { color: var(--accent); }
p.msg { margin: 0; }
.actions + .msg { margin-top: 10px; }
.msg a { color: var(--link); }
.note { color: var(--muted); font-size: 14px; margin: 0; }
.rule ul { margin: 2px 0 0; padding-left: 20px; }
.rule-intro.bad { color: var(--bad); }
.content[inert] { opacity: 0.45; }
progress { width: 100%; max-width: 420px; height: 10px; accent-color: var(--accent); }
pre.log { margin: 8px 0 0; max-height: 320px; overflow: auto; padding: 8px 10px; background: var(--card);
          border: 1px solid var(--line); border-radius: 8px; font: 12px/1.35 ui-monospace, monospace;
          white-space: pre-wrap; overflow-wrap: anywhere; }
pre.log .ok { color: var(--accent); }
pre.log .bad { color: var(--bad); }
.drop { display: grid; gap: 10px; justify-items: center; margin: 8px 0 12px; padding: 22px 16px; border: 2px dashed var(--line);
        border-radius: 8px; color: var(--muted); text-align: center; }
.drop.over { border-color: var(--accent); color: var(--fg); }
.actions.spaced { margin-top: 24px; }
details { margin-top: 12px; }
details summary { cursor: pointer; color: var(--muted); font-size: 14px; }
table { border-collapse: separate; border-spacing: 0; border-radius: 8px; overflow: hidden; }
table.websites { width: 100%; margin-bottom: 16px; }
table.websites td:first-child { overflow-wrap: anywhere; }
table.websites td.acts { text-align: right; white-space: nowrap; }
th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
tr:has(> th) { background: var(--accent); }
th { color: var(--accent-fg); font-weight: 700; font-size: 14px; border-bottom: 0; }
ul.plain { list-style: none; padding: 0; margin: 6px 0 0; }
ul.nets { list-style: none; padding: 0; margin: 0; border: 1px solid var(--line); border-radius: 8px; max-width: 420px;
          max-height: 260px; overflow-y: auto; }
ul.nets li { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--line); cursor: pointer; }
ul.nets li:last-child { border-bottom: 0; }
ul.nets li:hover { background: var(--bg); }
ul.nets li[aria-disabled] { cursor: default; opacity: 0.5; }
ul.nets .name { flex: 1; overflow-wrap: anywhere; }
ul.nets .lock { color: var(--muted); font-size: 14px; }
.padlock { position: relative; display: inline-block; width: 10px; height: 8px; margin-top: 6px; border-radius: 2px;
           background: var(--muted); }
.padlock::before { content: ""; position: absolute; left: 2px; top: -6px; width: 6px; height: 7px;
                   border: 2px solid var(--muted); border-bottom: 0; border-radius: 4px 4px 0 0; }
.bars { display: inline-flex; align-items: flex-end; gap: 2px; height: 14px; vertical-align: -1px; margin-right: 6px; }
.bars i { width: 4px; background: var(--line); border-radius: 1px; }
.bars i:nth-child(1) { height: 25%; } .bars i:nth-child(2) { height: 50%; }
.bars i:nth-child(3) { height: 75%; } .bars i:nth-child(4) { height: 100%; }
.bars.b1 i:nth-child(-n+1), .bars.b2 i:nth-child(-n+2), .bars.b3 i:nth-child(-n+3), .bars.b4 i { background: var(--fg); }
.tip { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; margin-left: 5px;
       border: 1px solid var(--muted); border-radius: 50%; color: var(--muted); font: 600 11px/1 system-ui, sans-serif;
       cursor: help; position: relative; vertical-align: 1px; flex: none; }
.tip-box { display: none; position: fixed; z-index: 10; width: max-content; max-width: min(280px, calc(100vw - 16px));
           padding: 7px 9px; border-radius: 6px; background: var(--tip-bg); color: var(--tip-fg);
           font: 13px/1.4 system-ui, sans-serif; text-align: left; white-space: normal; cursor: auto; }
.tip.open .tip-box { display: block; }
.prompt { border: 1px solid var(--warn); background: var(--warn-bg); border-radius: 8px; padding: 10px 12px;
          display: grid; gap: 8px; margin-top: 10px; }
footer { max-width: 720px; margin: 0 auto; padding: 0 16px 24px; color: var(--muted); font-size: 13px; text-align: center; }
footer a { color: var(--muted); }
[hidden] { display: none !important; }
`;

export const CSS = `${BASE_CSS}${RULES}`;
