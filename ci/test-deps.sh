#!/usr/bin/env bash
#
# Write what the tests use that Airfrog's full user interface doesn't, in
# build/test-deps/:
# - schema/js/schema.js: js/schema.js with the test models
#   (`ci/schema.py --test`)
# - setup/setup.js: Airfrog's internal JS setup module built as
#   ci/build-setup.sh builds it, with schema/js/schema.js in place of
#   js/schema.js
# - ui/ui.js: Airfrog's full user interface built by ui/build.mjs with
#   schema/js/schema.js in place of js/schema.js, and AIRFROG_MANIFEST and
#   AIRFROG_KEYS set to ui/release-keys.js's. ui/release-keys.js contains
#   https://manifest.test/manifest.json and the public halves of the test
#   keys 'release' and 'backup' (tests/ui/minisign.mjs). ci/build-ui.sh runs
#   first and installs esbuild and noble.
#
# Usage: ci/test-deps.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT="${ROOT}/build/test-deps"

ESBUILD="$(tr -d '[:space:]' < "${SCRIPT_DIR}/esbuild-version")"

"${SCRIPT_DIR}/build-ui.sh"
"${SCRIPT_DIR}/build-setup.sh"
export PATH="$("${SCRIPT_DIR}/install-node.sh"):${PATH}"
mkdir -p "${OUT}"

# The setup module with the test models, from a copy of js/
"$("${SCRIPT_DIR}/install-python.sh")/python3" "${SCRIPT_DIR}/schema.py" --test write site "${OUT}/schema"
rm -rf "${OUT}/setup-src"
mkdir -p "${OUT}/setup-src" "${OUT}/setup"
cp -R "${ROOT}/js" "${OUT}/setup-src/"
cp "${OUT}/schema/js/schema.js" "${OUT}/setup-src/js/schema.js"
"${ROOT}/build/setup-deps/esbuild-${ESBUILD}/node_modules/.bin/esbuild" "${OUT}/setup-src/js/setup/index.js" \
    --bundle --format=esm --platform=browser --target=es2022 --minify --legal-comments=none --log-level=warning \
    "--banner:js=// Airfrog's internal JS setup module with the test models, built by ci/test-deps.sh." \
    --outfile="${OUT}/setup/setup.js"

# The full user interface with the test keys and the test models
mkdir -p "${OUT}/ui"
manifest="https://manifest.test/manifest.json"
keys="$(node --input-type=module -e "import { TEST_KEY, BACKUP_KEY } from '${ROOT}/tests/ui/minisign.mjs'; console.log([TEST_KEY, BACKUP_KEY].join());")"
node --input-type=module -e "console.log('// Written by ci/test-deps.sh with the test keys.\\n'
    + 'export const RELEASE_KEYS = ' + JSON.stringify(process.argv[1].split(',')) + ';\\n'
    + 'export const AIRFROG_MANIFEST = ' + JSON.stringify(process.argv[2]) + ';')" "${keys}" "${manifest}" \
    > "${OUT}/ui/release-keys.js"
AIRFROG_MANIFEST="${manifest}" AIRFROG_KEYS="${keys}" node "${ROOT}/ui/build.mjs" \
    --esbuild "${ROOT}/build/ui-deps/esbuild-${ESBUILD}/node_modules/esbuild/lib/main.js" \
    --node-modules "${ROOT}/build/ui-deps/noble/node_modules" \
    --schema "${OUT}/schema/js/schema.js" \
    --ui-version "$(tr -d '[:space:]' < "${ROOT}/ui/ui-version")" \
    --banner "// Airfrog's full user interface with the test keys and the test models, built by ci/test-deps.sh." \
    --out "${OUT}/ui/ui.js"

echo "Wrote ${OUT}" >&2
