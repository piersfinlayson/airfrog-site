// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Writes commissioning/tool.css, the stylesheet of the commissioning tool on
// airfrog.org/commissioning: the stylesheet of Airfrog's internal JS setup
// module, js/setup/style.js, then the rules only the tool uses.
// tests/js/tool-css.test.mjs fails when tool.css is out of date.
//
// Usage: node ci/tool-css.mjs

import { writeFileSync } from 'node:fs';
import { toolCss } from './tool-css-source.mjs';

writeFileSync(new URL('../commissioning/tool.css', import.meta.url), toolCss());
