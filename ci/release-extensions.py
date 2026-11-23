"""Sign the signed list of the Airfrog Extension Repository.

Has Airfrog's signing server sign REPOSITORY/manifest.json, the signed list
that airfrog-ext publish and airfrog-ext depublish write, checks the
signature and writes the list and its signature file. The repository is
published at the directory of EXTENSIONS_MANIFEST in urls.toml. Fails when an
extension image in the list is at another address, or when a UI address
isn't https://.

Usage: python3 ci/release-extensions.py --repository DIR --signer URL
  --repository  the airfrog-extensions directory, for example ../airfrog-extensions
  --signer      the signing server, for example https://HOST:8444
  --cacert      a CA certificate for the signing server's TLS

The signing key must be the one in commissioning/manifest-key.js. The PIN is
read from the terminal. Use the Python ci/install-python.sh installs.
"""
import argparse
import json
import os

from signing import fail, manifest_key, sign
from urls import url

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    p.add_argument('--repository', required=True)
    p.add_argument('--signer', required=True)
    p.add_argument('--cacert')
    args = p.parse_args()

    out = os.path.join(args.repository, 'manifest.json')
    manifest = json.load(open(out))
    if manifest.get('type') != 'extensions':
        fail('%s isn\'t a signed list of extensions.' % out)
    base = url('EXTENSIONS_MANIFEST').rsplit('/', 1)[0] + '/'
    for name, extension in manifest.get('extensions', {}).items():
        for version in extension.get('versions', []):
            ui = version.get('metadata', {}).get('ui')
            if ui is not None and not str(ui).startswith('https://'):
                fail('%s %s has the UI address %s, which isn\'t https://. Publish it with an https:// UI.'
                     % (name, version.get('metadata', {}).get('version'), ui))
            for image in version.get('images', []):
                if not image.get('url', '').startswith(base):
                    fail('%s %s has an extension image at %s, outside %s. Publish it without --url.'
                         % (name, version.get('metadata', {}).get('version'), image.get('url'), base))
    key = sign(manifest, args.signer, args.cacert, out, manifest_key(ROOT))
    print('Extensions manifest signed by %s' % key.hex())


if __name__ == '__main__':
    main()
