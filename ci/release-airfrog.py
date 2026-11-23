"""Sign the Airfrog manifest.

Builds the Airfrog manifest, which contains the other manifests' addresses and
the client library's directory from urls.toml, has Airfrog's signing server
sign it, checks the signature and writes the manifest and its signature file
to OUT/manifest.json. It is published at
https://meta.piers.rocks/airfrog/manifest.json, the address Airfrog's
firmware is built with.

Usage: python3 ci/release-airfrog.py --out DIR --signer URL
  --out       the directory published as https://meta.piers.rocks/airfrog/
  --signer    the signing server, for example https://HOST:8444
  --cacert    a CA certificate for the signing server's TLS

The signing key must be the one in commissioning/manifest-key.js. The PIN is
read from the terminal. Use the Python ci/install-python.sh installs.
"""
import argparse
import os

from signing import MANIFEST_VERSION, manifest_key, sign
from urls import url

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    p.add_argument('--out', required=True)
    p.add_argument('--signer', required=True)
    p.add_argument('--cacert')
    args = p.parse_args()

    out = os.path.join(args.out, 'manifest.json')
    manifest = {
        'type': 'airfrog',
        'version': MANIFEST_VERSION,
        'ui_manifest': url('UI_MANIFEST'),
        'firmware_manifest': url('FIRMWARE_MANIFEST'),
        'support_firmware_manifest': url('SUPPORT_FIRMWARE_MANIFEST'),
        'cli_manifest': url('CLI_MANIFEST'),
        'extensions_manifest': url('EXTENSIONS_MANIFEST'),
        'js_library': url('CLIENT_LIBRARIES'),
    }
    key = sign(manifest, args.signer, args.cacert, out, manifest_key(ROOT))
    print('Airfrog manifest signed by %s' % key.hex())


if __name__ == '__main__':
    main()
