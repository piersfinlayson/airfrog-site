"""Sign the extension images and the signed list of the Airfrog Extension
Repository.

Reads REPOSITORY/manifest.json, the signed list that airfrog-ext publish and
airfrog-ext depublish write. Has Airfrog's signing server sign each
extension image the list contains that isn't signed yet, replaces the image
with its signed file and updates its size and SHA-256 in the list. Then has
the server sign the list, checks each signature and writes the list and its
signature file. The repository is published at the directory of
EXTENSIONS_MANIFEST in urls.toml. Fails, writing nothing, when an extension
image in the list is outside the repository, doesn't match its size and
SHA-256, or is signed with a key that isn't a release key, or when a UI
address isn't https://.

Usage: python3 ci/release-extensions.py --repository DIR --signer URL
  --repository  the airfrog-extensions directory, for example ../airfrog-extensions
  --signer      the signing server, for example https://HOST:8444
  --cacert      a CA certificate for the signing server's TLS

The signing server's key must be one of commissioning/release-keys.js's
release keys. The PIN is read from the terminal. Use the Python
ci/install-python.sh installs.
"""
import argparse

from releases import sign_extensions
from signing import Signer


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    p.add_argument('--repository', required=True)
    p.add_argument('--signer', required=True)
    p.add_argument('--cacert')
    args = p.parse_args()

    signer = Signer(args.signer, args.cacert)
    count = sign_extensions(args.repository, signer)
    print('%d extension images and the extensions manifest signed by %s' % (count, signer.key.hex()))


if __name__ == '__main__':
    main()
