#!/usr/bin/env bash
#
# Bundle esptool-js and its dependencies into one ES module,
# commissioning/vendor/esptool.js, with their licences in
# commissioning/vendor/LICENSES.md.
#
# The versions of esptool-js, pako, atob-lite and esbuild are pinned in
# ci/<package>-version. npm runs from the Node.js pinned in ci/node-version,
# with install scripts disabled. Downloads go to build/esptool-js/.
#
# Usage: ci/vendor-esptool.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORK="${ROOT}/build/esptool-js"
OUT="${ROOT}/commissioning/vendor"

pin() {
    tr -d '[:space:]' < "${SCRIPT_DIR}/$1-version"
}

ESPTOOL_JS="$(pin esptool-js)"
PAKO="$(pin pako)"
ATOB_LITE="$(pin atob-lite)"
ESBUILD="$(pin esbuild)"

export PATH="$("${SCRIPT_DIR}/install-node.sh"):${PATH}"

rm -rf "${WORK}"
mkdir -p "${WORK}" "${OUT}"
cat > "${WORK}/package.json" <<EOF
{
  "private": true,
  "dependencies": { "esptool-js": "${ESPTOOL_JS}" },
  "devDependencies": { "esbuild": "${ESBUILD}" },
  "overrides": { "pako": "${PAKO}", "atob-lite": "${ATOB_LITE}" }
}
EOF

echo "Installing esptool-js ${ESPTOOL_JS}, pako ${PAKO}, atob-lite ${ATOB_LITE} and esbuild ${ESBUILD}..." >&2
(cd "${WORK}" && npm install --ignore-scripts --no-audit --no-fund --loglevel=error >&2)

# Fail if npm installed anything other than the pinned versions.
check() {
    local got
    got="$(node -p "require('${WORK}/node_modules/$1/package.json').version")"
    if [ "${got}" != "$2" ]; then
        echo "npm installed $1 ${got}, not the pinned $2" >&2
        exit 1
    fi
}
check esptool-js "${ESPTOOL_JS}"
check pako "${PAKO}"
check atob-lite "${ATOB_LITE}"
check esbuild "${ESBUILD}"

banner="// esptool-js ${ESPTOOL_JS} with pako ${PAKO} and atob-lite ${ATOB_LITE}, bundled by
// esbuild ${ESBUILD} with ci/vendor-esptool.sh. Licences: LICENSES.md."

"${WORK}/node_modules/.bin/esbuild" "${WORK}/node_modules/esptool-js/lib/index.js" \
    --bundle --format=esm --platform=browser --target=es2022 \
    --banner:js="${banner}" --log-level=warning \
    --outfile="${OUT}/esptool.js"

licence() {
    local dir="${WORK}/node_modules/$1" file
    file="$(find "${dir}" -maxdepth 1 -iname 'licen[cs]e*' | head -n 1)"
    if [ -z "${file}" ]; then
        echo "$1 doesn't have a licence file" >&2
        exit 1
    fi
    printf '## %s %s\n\n%s\n\n```\n%s\n```\n\n' "$1" "$2" "$3" "$(cat "${file}")"
}

{
    printf '# Licences\n\n'
    printf '`esptool.js` contains these packages, bundled by `ci/vendor-esptool.sh`.\n\n'
    licence esptool-js "${ESPTOOL_JS}" "Apache License 2.0."
    licence pako "${PAKO}" "MIT License, and the zlib licence for its port of zlib."
    printf 'The zlib licence, from pako'"'"'s port of zlib:\n\n```\n%s\n```\n\n' "$(awk '/\(C\) 1995/,/3\. This notice/' \
        "${WORK}/node_modules/pako/lib/zlib/deflate.js" | sed 's|^// \{0,1\}||')"
    licence atob-lite "${ATOB_LITE}" "MIT License."
    licence esbuild "${ESBUILD}" "MIT License. esbuild adds its module helpers to the bundle."
} > "${OUT}/LICENSES.md"

echo "Wrote ${OUT}/esptool.js and ${OUT}/LICENSES.md" >&2
