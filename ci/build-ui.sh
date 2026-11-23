#!/usr/bin/env bash
#
# Build Airfrog's full user interface, ui/src/main.js, into one ES module,
# build/ui/ui.js, with every import bundled. build/ui/files.json lists the
# UI manifest's other files, as URLs, and is empty.
#
# esbuild, Node.js, noble-ed25519 and noble-hashes are pinned in
# ci/<name>-version. Downloads go to build/ui-deps/.
#
# Usage: ci/build-ui.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEPS="${ROOT}/build/ui-deps"
OUT="${ROOT}/build/ui"

pin() {
    tr -d '[:space:]' < "${SCRIPT_DIR}/$1-version"
}

ESBUILD="$(pin esbuild)"
ED25519="$(pin noble-ed25519)"
HASHES="$(pin noble-hashes)"

export PATH="$("${SCRIPT_DIR}/install-node.sh"):${PATH}"
PYTHON="$("${SCRIPT_DIR}/install-python.sh")/python3"
"${PYTHON}" "${SCRIPT_DIR}/urls.py" write
"${PYTHON}" "${SCRIPT_DIR}/schema.py" write site
mkdir -p "${DEPS}" "${OUT}"

# esbuild
ESBUILD_DIR="${DEPS}/esbuild-${ESBUILD}"
if [ ! -x "${ESBUILD_DIR}/node_modules/.bin/esbuild" ]; then
    echo "Installing esbuild ${ESBUILD}..." >&2
    rm -rf "${ESBUILD_DIR}"
    mkdir -p "${ESBUILD_DIR}"
    printf '{ "private": true, "devDependencies": { "esbuild": "%s" } }\n' "${ESBUILD}" \
        > "${ESBUILD_DIR}/package.json"
    (cd "${ESBUILD_DIR}" && npm install --ignore-scripts --no-audit --no-fund --loglevel=error >&2)
fi
got="$(node -p "require('${ESBUILD_DIR}/node_modules/esbuild/package.json').version")"
if [ "${got}" != "${ESBUILD}" ]; then
    echo "esbuild ${got} is installed, not the pinned ${ESBUILD}" >&2
    exit 1
fi

# noble-ed25519 and noble-hashes
NOBLE_DIR="${DEPS}/noble"
installed() {
    node -p "try { require('${NOBLE_DIR}/node_modules/$1/package.json').version } catch (e) { '' }"
}
if [ "$(installed @noble/ed25519)" != "${ED25519}" ] || [ "$(installed @noble/hashes)" != "${HASHES}" ]; then
    echo "Installing @noble/ed25519 ${ED25519} and @noble/hashes ${HASHES}..." >&2
    rm -rf "${NOBLE_DIR}"
    mkdir -p "${NOBLE_DIR}"
    printf '{ "private": true, "dependencies": { "@noble/ed25519": "%s", "@noble/hashes": "%s" } }\n' \
        "${ED25519}" "${HASHES}" > "${NOBLE_DIR}/package.json"
    (cd "${NOBLE_DIR}" && npm install --ignore-scripts --no-audit --no-fund --loglevel=error >&2)
fi
if [ "$(installed @noble/ed25519)" != "${ED25519}" ] || [ "$(installed @noble/hashes)" != "${HASHES}" ]; then
    echo "npm didn't install @noble/ed25519 ${ED25519} and @noble/hashes ${HASHES}" >&2
    exit 1
fi

node "${ROOT}/ui/build.mjs" \
    --esbuild "${ESBUILD_DIR}/node_modules/esbuild/lib/main.js" \
    --node-modules "${NOBLE_DIR}/node_modules" \
    --ui-version "$(tr -d '[:space:]' < "${ROOT}/ui/ui-version")" \
    --banner "// Airfrog's full user interface, bundled by esbuild ${ESBUILD} with ci/build-ui.sh." \
    --out "${OUT}/ui.js"

printf '[]\n' > "${OUT}/files.json"
echo "Wrote ${OUT}/ui.js and ${OUT}/files.json" >&2
