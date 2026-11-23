#!/usr/bin/env bash
#
# Build Airfrog's full user interface and run its tests, tests/ui/*.test.mjs, with the
# Node.js pinned in ci/node-version. Fails when the full user interface
# contains a name of a model not released, and when it does once built with
# the test models (`ci/schema.py --test`), into build/test-deps/ui-models/.
# The tests run with js/schema.js written with the test models
# (tests/ui/hooks.mjs).
#
# Usage: ci/test-ui.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

"${SCRIPT_DIR}/build-ui.sh"
export PATH="$("${SCRIPT_DIR}/install-node.sh"):${PATH}"
PYTHON="$("${SCRIPT_DIR}/install-python.sh")/python3"
"${PYTHON}" "${SCRIPT_DIR}/schema.py" check names "${ROOT}/build/ui/ui.js"
"${PYTHON}" "${SCRIPT_DIR}/schema.py" --test write site "${ROOT}/build/test-deps/schema"
node "${ROOT}/ui/build.mjs" \
    --esbuild "${ROOT}/build/ui-deps/esbuild-$(tr -d '[:space:]' < "${SCRIPT_DIR}/esbuild-version")/node_modules/esbuild/lib/main.js" \
    --node-modules "${ROOT}/build/ui-deps/noble/node_modules" \
    --schema "${ROOT}/build/test-deps/schema/js/schema.js" \
    --ui-version "$(tr -d '[:space:]' < "${ROOT}/ui/ui-version")" \
    --banner "// Airfrog's full user interface with the test models, built by ci/test-ui.sh." \
    --out "${ROOT}/build/test-deps/ui-models/ui.js"
"${PYTHON}" "${SCRIPT_DIR}/schema.py" --test check names "${ROOT}/build/test-deps/ui-models/ui.js"
cd "${ROOT}"
node --import ./tests/ui/hooks.mjs --test 'tests/ui/*.test.mjs'
