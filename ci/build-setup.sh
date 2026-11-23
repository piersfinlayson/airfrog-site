#!/usr/bin/env bash
#
# Bundle Airfrog's internal JS setup module, js/setup/index.js and what it imports, into
# one ES module, build/setup/setup.js. Airfrog's firmware embeds that file
# (airfrog-v2's ci/vendor-setup.sh) and serves it at /setup.js. Also write
# build/setup/base.css, js/setup/style.js's BASE_CSS, which the firmware puts
# in the Airfrog home page.
#
# esbuild and Node.js are pinned in ci/<name>-version. Downloads go to
# build/setup-deps/.
#
# Usage: ci/build-setup.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEPS="${ROOT}/build/setup-deps"
OUT="${ROOT}/build/setup"
ESBUILD="$(tr -d '[:space:]' < "${SCRIPT_DIR}/esbuild-version")"

export PATH="$("${SCRIPT_DIR}/install-node.sh"):${PATH}"
PYTHON="$("${SCRIPT_DIR}/install-python.sh")/python3"
"${PYTHON}" "${SCRIPT_DIR}/urls.py" write
"${PYTHON}" "${SCRIPT_DIR}/schema.py" write site
mkdir -p "${DEPS}" "${OUT}"

ESBUILD_DIR="${DEPS}/esbuild-${ESBUILD}"
if [ ! -x "${ESBUILD_DIR}/node_modules/.bin/esbuild" ]; then
    echo "Installing esbuild ${ESBUILD}..." >&2
    rm -rf "${ESBUILD_DIR}"
    mkdir -p "${ESBUILD_DIR}"
    printf '{ "private": true, "devDependencies": { "esbuild": "%s" } }\n' "${ESBUILD}" \
        > "${ESBUILD_DIR}/package.json"
    (cd "${ESBUILD_DIR}" && npm install --ignore-scripts --no-audit --no-fund --loglevel=error >&2)
fi

"${ESBUILD_DIR}/node_modules/.bin/esbuild" "${ROOT}/js/setup/index.js" --bundle --format=esm \
    --platform=browser --target=es2022 --minify --legal-comments=none --log-level=warning \
    "--banner:js=// Airfrog's internal JS setup module (MIT), bundled from airfrog-site's js/setup by ci/build-setup.sh." \
    --outfile="${OUT}/setup.js"
node --input-type=module -e "import { BASE_CSS } from '${ROOT}/js/setup/style.js'; \
process.stdout.write(BASE_CSS.trim() + '\n');" > "${OUT}/base.css"
echo "Wrote ${OUT}/setup.js and ${OUT}/base.css" >&2
