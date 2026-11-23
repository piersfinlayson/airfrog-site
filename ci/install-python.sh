#!/usr/bin/env bash
#
# Install the Python pinned in ci/python-version, which runs ci/urls.py,
# ci/schema.py and the release scripts.
#
# CI and a developer's machine both install through this script, so every
# script runs on the same Python. It is a python-build-standalone build, which
# installs at an exact version without a package manager. The pin is
# python-build-standalone's name for the build, <python version>+<release date>.
#
# Usage: ci/install-python.sh [install-dir]
#   install-dir  where to install (default: build/ in the site)
#
# Python goes to <install-dir>/python-<pin>. Progress goes to stderr and
# Python's bin directory to stdout, so the caller can do:
#
#   export PATH="$(ci/install-python.sh):$PATH"
#
# Re-running with the version already present doesn't reinstall.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

INSTALL_DIR="${1:-${ROOT}/build}"
PIN="$(cat "${SCRIPT_DIR}/python-version")"
VERSION="${PIN%%+*}"
RELEASE="${PIN#*+}"

case "$(uname -s)/$(uname -m)" in
    Linux/x86_64)   ARCH="x86_64-unknown-linux-gnu" ;;
    Linux/aarch64)  ARCH="aarch64-unknown-linux-gnu" ;;
    Linux/arm64)    ARCH="aarch64-unknown-linux-gnu" ;;
    Darwin/arm64)   ARCH="aarch64-apple-darwin" ;;
    Darwin/x86_64)  ARCH="x86_64-apple-darwin" ;;
    *)
        echo "Unsupported host $(uname -s)/$(uname -m) - no python-build-standalone build for it" >&2
        exit 1
        ;;
esac

TARBALL="cpython-${PIN}-${ARCH}-install_only.tar.gz"
BASE_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}"
TARGET="${INSTALL_DIR}/python-${PIN}"

if [ ! -x "${TARGET}/bin/python3" ]; then
    mkdir -p "${INSTALL_DIR}"
    echo "Installing Python ${PIN} (${ARCH}) into ${TARGET}..." >&2

    tmp="$(mktemp -d)"
    trap 'rm -rf "${tmp}"' EXIT

    curl -fsSL -o "${tmp}/${TARBALL}" "${BASE_URL}/${TARBALL}"
    curl -fsSL -o "${tmp}/SHA256SUMS" "${BASE_URL}/SHA256SUMS"
    echo "Verifying checksum..." >&2
    awk -v f="${TARBALL}" '$2 == f' "${tmp}/SHA256SUMS" > "${tmp}/${TARBALL}.sha256"
    if [ ! -s "${tmp}/${TARBALL}.sha256" ]; then
        echo "${TARBALL} isn't in the release's SHA256SUMS" >&2
        exit 1
    fi
    if command -v sha256sum >/dev/null 2>&1; then
        ( cd "${tmp}" && sha256sum -c "${TARBALL}.sha256" >&2 )
    else
        ( cd "${tmp}" && shasum -a 256 -c "${TARBALL}.sha256" >&2 )
    fi

    # Unpack to a temporary name and move into place, so an interrupted install
    # can't leave a half-extracted tree that the next run uses.
    tar -xzf "${tmp}/${TARBALL}" -C "${tmp}"
    rm -rf "${TARGET}.partial"
    mv "${tmp}/python" "${TARGET}.partial"
    rm -rf "${TARGET}"
    mv "${TARGET}.partial" "${TARGET}"
else
    echo "Python ${PIN} already present in ${TARGET}" >&2
fi

actual="$("${TARGET}/bin/python3" --version)"
if [ "${actual}" != "Python ${VERSION}" ]; then
    echo "${TARGET} contains ${actual}, not ${VERSION}" >&2
    exit 1
fi
echo "${actual}" >&2

echo "${TARGET}/bin"
