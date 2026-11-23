#!/usr/bin/env bash
#
# Install the Node.js pinned in ci/node-version, which runs the tests and
# vendors esptool-js.
#
# Usage: ci/install-node.sh [install-dir]
#   install-dir  where to install (default: build/ in the site)
#
# Node goes to <install-dir>/node-v<version>. Progress goes to stderr and
# Node's bin directory to stdout, so the caller can do:
#
#   export PATH="$(ci/install-node.sh):$PATH"
#
# Re-running with the version already present doesn't reinstall.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

INSTALL_DIR="${1:-${ROOT}/build}"
VERSION="$(tr -d '[:space:]' < "${SCRIPT_DIR}/node-version")"

case "$(uname -s)/$(uname -m)" in
    Linux/x86_64)   PLATFORM="linux-x64" ;;
    Linux/aarch64)  PLATFORM="linux-arm64" ;;
    Linux/arm64)    PLATFORM="linux-arm64" ;;
    Darwin/arm64)   PLATFORM="darwin-arm64" ;;
    Darwin/x86_64)  PLATFORM="darwin-x64" ;;
    *)
        echo "Unsupported host $(uname -s)/$(uname -m)" >&2
        exit 1
        ;;
esac

NAME="node-v${VERSION}-${PLATFORM}"
TARBALL="${NAME}.tar.gz"
BASE_URL="https://nodejs.org/dist/v${VERSION}"
TARGET="${INSTALL_DIR}/node-v${VERSION}"

if [ ! -x "${TARGET}/bin/node" ]; then
    echo "Installing Node.js ${VERSION} (${PLATFORM}) into ${TARGET}..." >&2
    mkdir -p "${INSTALL_DIR}"

    tmp="$(mktemp -d "${INSTALL_DIR}/node-download.XXXXXX")"
    trap 'rm -rf "${tmp}"' EXIT

    curl -fsSL -o "${tmp}/${TARBALL}" "${BASE_URL}/${TARBALL}"
    curl -fsSL -o "${tmp}/SHASUMS256.txt" "${BASE_URL}/SHASUMS256.txt"
    echo "Verifying checksum..." >&2
    awk -v f="${TARBALL}" '$2 == f' "${tmp}/SHASUMS256.txt" > "${tmp}/${TARBALL}.sha256"
    if [ ! -s "${tmp}/${TARBALL}.sha256" ]; then
        echo "${TARBALL} isn't in the release's SHASUMS256.txt" >&2
        exit 1
    fi
    (cd "${tmp}" && shasum -a 256 -c "${TARBALL}.sha256" >&2)

    # Unpack to a temporary name and move into place, so an interrupted
    # install can't leave a partial tree that the next run takes as good.
    tar -xzf "${tmp}/${TARBALL}" -C "${tmp}"
    rm -rf "${TARGET}"
    mv "${tmp}/${NAME}" "${TARGET}"
else
    echo "Node.js ${VERSION} already present in ${TARGET}" >&2
fi

echo "${TARGET}/bin"
