"""Publish Airfrog's full user interface and sign the UI manifest.

Copies build/ui/ui.js (ci/build-ui.sh) to FULL_UI in an images.airfrog.org
checkout, builds the UI manifest from it and the files in build/ui/files.json,
has Airfrog's signing server sign it, checks the signature and writes the UI
manifest and its signature file to UI_MANIFEST. urls.toml defines FULL_UI and
UI_MANIFEST. Fails when ui.js contains a name of a model not released, or
when its release keys and Airfrog manifest address aren't exactly
commissioning/release-keys.js's.

Usage: python3 ci/release-ui.py --images DIR --signer URL
  --images    the images.airfrog.org directory, for example ../images.airfrog.org
  --signer    the signing server, for example https://HOST:8444
  --cacert    a CA certificate for the signing server's TLS
  --min-home-page  the oldest Airfrog home page the full user interface
              runs from (default: 1)

The signing server's key must be one of commissioning/release-keys.js's
release keys. The PIN is read from the terminal. Use the Python
ci/install-python.sh installs.
"""
import argparse
import json
import os
import re
import shutil

from schema import check_names, load
from signing import MANIFEST_VERSION, entry, fail, fetch, keys, sign
from urls import path, url

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def built_keys(ui):
    """The release keys and the Airfrog manifest address the bundle ui, as
    text, was built with, or None unless each is there once."""
    keys = re.findall(r'\bRELEASE_KEYS\d* = \[([^\]]*)\]', ui)
    manifests = re.findall(r'\bAIRFROG_MANIFEST\d* = "([^"]*)"', ui)
    if len(keys) != 1 or len(manifests) != 1:
        return None
    return re.findall(r'"([^"]*)"', keys[0]), manifests[0]


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
    if built_keys(ui.decode()) != keys():
        fail("%s's release keys and Airfrog manifest address aren't exactly commissioning/release-keys.js's. "
             'Run ci/build-ui.sh without AIRFROG_MANIFEST and AIRFROG_KEYS.' % built)
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
    public = sign(manifest, args.signer, args.cacert, out)
    print('UI manifest, full user interface %s, signed by %s' % (ui_version, public.hex()))


if __name__ == '__main__':
    main()
