"""Publish Airfrog's full user interface and sign the UI manifest.

Copies build/ui/ui.js (ci/build-ui.sh) to FULL_UI in an images.airfrog.org
checkout, builds the UI manifest from it and the files in build/ui/files.json,
has Airfrog's signing server sign it, checks the signature and writes the UI
manifest and its signature file to UI_MANIFEST. urls.toml defines FULL_UI and
UI_MANIFEST. Fails when ui.js contains a name of a model not released, or
doesn't contain the manifest key from commissioning/manifest-key.js.

Usage: python3 ci/release-ui.py --images DIR --signer URL
  --images    the images.airfrog.org directory, for example ../images.airfrog.org
  --signer    the signing server, for example https://HOST:8444
  --cacert    a CA certificate for the signing server's TLS
  --min-home-page  the oldest Airfrog home page the full user interface
              runs from (default: 1)

The signing key must be the one in commissioning/manifest-key.js. The PIN is
read from the terminal. Use the Python ci/install-python.sh installs.
"""
import argparse
import json
import os
import shutil

from schema import check_names, load
from signing import MANIFEST_VERSION, entry, fail, fetch, manifest_key, sign
from urls import path, url

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    p.add_argument('--images', required=True)
    p.add_argument('--signer', required=True)
    p.add_argument('--cacert')
    p.add_argument('--min-home-page', type=int, default=1)
    args = p.parse_args()

    out = os.path.join(args.images, path('UI_MANIFEST'))
    ui_version = open(os.path.join(ROOT, 'ui', 'ui-version')).read().strip()

    built = os.path.join(ROOT, 'build', 'ui', 'ui.js')
    if check_names(load(), [built]):
        fail('%s contains a name of a model not released' % built)
    ui = open(built, 'rb').read()
    key = manifest_key(ROOT)
    if key.encode() not in ui:
        fail("%s doesn't contain commissioning/manifest-key.js's manifest key. Run ci/build-ui.sh." % built)
    target = os.path.join(args.images, path('FULL_UI', ui_version=ui_version))
    if os.path.exists(target) and open(target, 'rb').read() != ui:
        fail('%s exists with another full user interface. Raise ui/ui-version.' % target)
    entry_url = url('FULL_UI', ui_version=ui_version)
    files = {entry_url: entry(ui)}
    for file in json.load(open(os.path.join(ROOT, 'build', 'ui', 'files.json'))):
        files[file] = entry(fetch(file))

    manifest = {
        'type': 'ui',
        'version': MANIFEST_VERSION,
        'ui_version': ui_version,
        'min_home_page': args.min_home_page,
        'entry': entry_url,
        'files': files,
    }
    os.makedirs(os.path.dirname(target), exist_ok=True)
    shutil.copyfile(built, target)
    public = sign(manifest, args.signer, args.cacert, out, key)
    print('UI manifest, full user interface %s, signed by %s' % (ui_version, public.hex()))


if __name__ == '__main__':
    main()
