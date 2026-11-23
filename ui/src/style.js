// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Airfrog's full user interface's own styles, added to those of Airfrog's
// internal JS setup module.

/** The connector drawings' label font. Names are bold. */
export const CONNECTOR_FONT = '13px system-ui, sans-serif';
/** The connector drawings' pin number font. */
export const CONNECTOR_NUM_FONT = '13px ui-monospace, monospace';

export const UI_CSS = `
.board-render svg { max-width: 100%; height: auto; display: block; margin: 0 auto 16px; }
.board-render .box { fill: none; stroke: var(--highlight); }
.board-render .label { font: 700 24px system-ui, sans-serif; fill: var(--fg); }
.connectors { display: grid; grid-template-columns: max-content max-content; justify-content: center;
              align-items: center; gap: 16px 24px; }
.connector-row { display: contents; }
.connector-row table { justify-self: start; }
.connector-row svg { justify-self: center; max-width: 100%; height: auto; font: ${CONNECTOR_FONT}; fill: var(--fg); }
.connector-row .body { fill: var(--bg); stroke: var(--line); }
.connector-row .pin { fill: var(--muted); }
.connector-row .num { font: ${CONNECTOR_NUM_FONT}; fill: var(--muted); }
.connector-row .name { font-weight: 600; }
@media (max-width: 520px) {
  .connectors { grid-template-columns: max-content; }
  .connector-row svg, .connector-row table { justify-self: center; }
}
dd ul.plain { margin: 0; }
table.exts { width: 100%; }
table.exts td.handle { cursor: grab; color: var(--muted); user-select: none; width: 18px; }
table.exts tr.dragging { opacity: 0.4; }
table.exts td.acts { text-align: right; white-space: nowrap; }
table.exts td.acts button + button { margin-left: 4px; }
button.small { padding: 4px 10px; font-size: 14px; }
.card-head .right { margin-left: auto; }
.muted { color: var(--muted); }
.ver { font-variant-numeric: tabular-nums; white-space: nowrap; }
.drag-note { margin-top: 8px; }
.filters { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; margin: 12px 0; }
.count { color: var(--muted); font-size: 14px; margin-bottom: 4px; }
/* One line is kept for the message so a message doesn't move the rows. */
.add-status { min-height: 1.45em; }
ul.avail { list-style: none; padding: 0; margin: 0; }
ul.avail li { display: flex; gap: 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--line); }
ul.avail .body { flex: 1; min-width: 0; }
ul.avail .acts { white-space: nowrap; }
ul.avail .acts button + button { margin-left: 4px; }
ul.avail .top { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }
ul.avail .name { font-weight: 600; }
ul.avail .desc { color: var(--muted); font-size: 14px; }
.for { font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.for.this { border-color: var(--accent); color: var(--accent); }
.ext-pane .msg { margin-bottom: 12px; }
/* In dark mode a frame whose page doesn't declare a dark color-scheme gets an opaque light background.
   connectExtension() posts the page's height, which replaces this one. */
.ext-frame iframe { display: block; width: 100%; height: max(480px, calc(100vh - 200px)); border: 0;
                   color-scheme: light dark; }
`;
