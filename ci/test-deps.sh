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
#   ui/manifest-key.js in place of commissioning/manifest-key.js and
#   schema/js/schema.js in place of js/schema.js. ui/manifest-key.js
#   contains the public half of airfrog-v2's test key, test/keys/manifest.pem.
#   ci/build-ui.sh runs first and installs esbuild and noble.
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

# The full user interface with the test key and the test models
mkdir -p "${OUT}/ui"
key="$(node --input-type=module -e "import { TEST_KEY } from '${ROOT}/tests/ui/minisign.mjs'; console.log(TEST_KEY);")"
printf "// Written by ci/test-deps.sh with airfrog-v2's test key.\nexport const MANIFEST_KEY = '%s';\nexport const AIRFROG_MANIFEST = '%s';\n" \
    "${key}" "https://manifest.test/manifest.json" > "${OUT}/ui/manifest-key.js"
node "${ROOT}/ui/build.mjs" \
    --esbuild "${ROOT}/build/ui-deps/esbuild-${ESBUILD}/node_modules/esbuild/lib/main.js" \
    --node-modules "${ROOT}/build/ui-deps/noble/node_modules" \
    --manifest-key "${OUT}/ui/manifest-key.js" \
    --schema "${OUT}/schema/js/schema.js" \
    --ui-version "$(tr -d '[:space:]' < "${ROOT}/ui/ui-version")" \
    --banner "// Airfrog's full user interface with airfrog-v2's test key and the test models, built by ci/test-deps.sh." \
    --out "${OUT}/ui/ui.js"

echo "Wrote ${OUT}" >&2
