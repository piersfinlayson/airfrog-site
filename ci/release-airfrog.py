"""Sign the Airfrog manifest.

Builds the Airfrog manifest, which contains the address and key of
each other manifest and the client library's directory from urls.toml, and
the websites whose extension UIs have full access, has Airfrog's signing
server sign it, checks the signature and writes the manifest and its
signature file to OUT/manifest.json. Each manifest's key is the signing
server's. It is published at commissioning/release-keys.js's
AIRFROG_MANIFEST, the address Airfrog's firmware is built with.

Usage: python3 ci/release-airfrog.py --out DIR --signer URL
  --out       the directory published as AIRFROG_MANIFEST's directory
  --signer    the signing server, for example https://HOST:8444
  --cacert    a CA certificate for the signing server's TLS

The signing server's key must be one of commissioning/release-keys.js's
release keys. The PIN is read from the terminal. Use the Python
ci/install-python.sh installs.
"""
import argparse
import os

from releases import airfrog_manifest, released_full_access
from signing import Signer


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    p.add_argument('--out', required=True)
    p.add_argument('--signer', required=True)
    p.add_argument('--cacert')
    args = p.parse_args()

    signer = Signer(args.signer, args.cacert)
    manifest = airfrog_manifest(signer.public_key().hex(), released_full_access())
    key = signer.sign_manifest(manifest, os.path.join(args.out, 'manifest.json'))
    print('Airfrog manifest signed by %s' % key.hex())


if __name__ == '__main__':
    main()
