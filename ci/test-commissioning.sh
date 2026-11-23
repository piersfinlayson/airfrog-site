#!/usr/bin/env bash
#
# Run airfrog.org/commissioning's tests with the Node.js pinned in
# ci/node-version. js/schema.js resolves to the copy with the test models
# (`ci/schema.py --test`), as tests/ui/hooks.mjs does for the UI's tests.
#
# Usage: ci/test-commissioning.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

export PATH="$("${SCRIPT_DIR}/install-node.sh"):${PATH}"
PYTHON="$("${SCRIPT_DIR}/install-python.sh")/python3"
"${PYTHON}" "${SCRIPT_DIR}/schema.py" --test write site "${ROOT}/build/test-deps/schema"
cd "${ROOT}"
node --import ./tests/ui/hooks.mjs --test 'tests/commissioning/*.test.mjs'
