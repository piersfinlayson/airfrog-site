#!/usr/bin/env bash
#
# Run the tests of js/ with the Node.js pinned in ci/node-version, and
# ci/urls.py's and ci/schema.py's checks of this site, its names check
# included, tests/models_test.py, tests/signing_test.py and tests/dev_test.py,
# with the Python pinned in ci/python-version.
#
# Usage: tests/js/run.sh
#
# tests/js/chrome/bridge-qemu.test.mjs, which needs Chrome and QEMU Airfrog,
# isn't run here. Its header says how to run it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PATH="$("${ROOT}/ci/install-node.sh"):${PATH}"
cd "${ROOT}"
PYTHON="$("${ROOT}/ci/install-python.sh")/python3"
"${PYTHON}" ci/urls.py check .
"${PYTHON}" ci/schema.py check site
"${PYTHON}" ci/schema.py check names .
"${PYTHON}" tests/models_test.py
"${PYTHON}" tests/signing_test.py
"${PYTHON}" tests/dev_test.py
node tests/js/airfrog.test.mjs
node tests/js/bridge.test.mjs
node --test tests/js/tool-css.test.mjs tests/js/palette.test.mjs tests/js/cli.test.mjs tests/js/address.test.mjs
