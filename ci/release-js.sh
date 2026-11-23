#!/usr/bin/env bash
#
# Publish the client library, js/*.js, in an images.airfrog.org checkout at
# CLIENT_LIBRARY (urls.toml), with the version in js/js-version. These
# versions are independent of firmware releases. Published files aren't
# changed, so this fails when the version's directory exists with other files.
# It also fails when a file contains a name of a model not released.
#
# Usage: ci/release-js.sh IMAGES
#   IMAGES  the images.airfrog.org directory, for example ../images.airfrog.org
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGES="$(cd "$1" && pwd)"
version="$(tr -d '[:space:]' < "${ROOT}/js/js-version")"
python="$("${ROOT}/ci/install-python.sh")/python3"
"${python}" "${ROOT}/ci/urls.py" write
"${python}" "${ROOT}/ci/schema.py" write site
out="${IMAGES}/$("${python}" "${ROOT}/ci/urls.py" path CLIENT_LIBRARY js_version="${version}")"
staged="$(mktemp -d)"
trap 'rm -rf "${staged}"' EXIT
cp "${ROOT}"/js/*.js "${staged}/"
"${python}" "${ROOT}/ci/schema.py" check names "${staged}"
if [ -d "${out}" ]; then
    if ! diff -r -q "${staged}" "${out}" >/dev/null; then
        echo "${out} exists with other files. Raise js/js-version." >&2
        exit 1
    fi
    echo "${out} is already published" >&2
    exit 0
fi
mkdir -p "${out}"
cp "${staged}"/* "${out}/"
echo "Published ${out}" >&2
