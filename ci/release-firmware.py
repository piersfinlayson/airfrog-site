"""Add a release of one firmware to the manifest that lists it and sign the
manifest.

Reads release VERSION of firmware NAME from an images.airfrog.org checkout,
where airfrog-v2's ci/release.sh publishes it. NAME is the firmware's folder
on images.airfrog.org and its key in the manifest.

In the firmware manifest, FIRMWARE_MANIFEST:
- airfrog-MODEL, a released model's Airfrog firmware, MODEL being the
  model's key in schema.toml: FIRMWARE_UPDATE_IMAGE, FIRMWARE_FACTORY_FILES
  and SETUP_MODULE. The commit is commission.json's.

In the support firmware manifest, SUPPORT_FIRMWARE_MANIFEST:
- onerom-airfrog-recovery, ONEROM_RECOVERY_FIRMWARE.
- onerom-airfrog-serial-recovery, ONEROM_SERIAL_RECOVERY_FIRMWARE.
- pico-airfrog-serial-adapter, PICO_SERIAL_ADAPTER_FIRMWARE.

Adds the release to the firmware's list in version order, highest first, has
Airfrog's signing server sign the manifest, checks the signature and writes
the manifest and its signature file. The latest release isn't changed.
ci/promote-firmware.py changes it. urls.toml defines the names in capitals.

Usage: python3 ci/release-firmware.py --images DIR --signer URL --firmware NAME --version VERSION
  --images    the images.airfrog.org directory, for example ../images.airfrog.org
  --signer    the signing server, for example https://HOST:8444
  --cacert    a CA certificate for the signing server's TLS
  --firmware  the firmware, for example airfrog-mini
  --version   the release, for example 0.2.1
  --commit    the git commit support firmware was built from, required for
              support firmware
  --notes     the release notes' URL

The signing key must be the one in commissioning/manifest-key.js. The PIN is
read from the terminal. Use the Python ci/install-python.sh installs.
"""
import argparse
import json
import os

from releases import (
    AIRFROG_FIRMWARE, SCHEMA, add_arguments, add_release, firmware_type, load_manifest, write_manifest,
)
from signing import entry, fail
from urls import path, url

# Each support firmware's constant in schema.toml's [recovery_constants] and
# its urls.toml entry.
SUPPORT = {'RECOVERY_FIRMWARE': 'ONEROM_RECOVERY_FIRMWARE',
           'SERIAL_FIRMWARE': 'ONEROM_SERIAL_RECOVERY_FIRMWARE',
           'PICO_FIRMWARE': 'PICO_SERIAL_ADAPTER_FIRMWARE'}


def head(version, commit, notes):
    """A release's version, commit and notes."""
    return {'version': version, 'commit': commit, **({'notes': notes} if notes else {})}


def read(path):
    """The contents of a release's file."""
    if not os.path.isfile(path):
        fail('%s doesn\'t exist' % path)
    with open(path, 'rb') as f:
        return f.read()


def airfrog_release(images, model, version, notes):
    """Release version of model's Airfrog firmware."""
    def local(name):
        return os.path.join(images, path(name, release=version, model=model))

    commission_json = os.path.join(local('FIRMWARE_FACTORY_FILES'), 'commission.json')
    if not os.path.exists(commission_json):
        fail('%s doesn\'t exist' % commission_json)
    commission = json.load(open(commission_json))
    if commission['version'] != version:
        fail('%s is for version %s' % (commission_json, commission['version']))
    if not commission.get('commit'):
        fail('%s doesn\'t have a commit' % commission_json)
    for f in commission['files']:
        name = os.path.join(local('FIRMWARE_FACTORY_FILES'), f['file'])
        if entry(read(name)) != {'size': f['size'], 'sha256': f['sha256']}:
            fail('%s doesn\'t match %s' % (name, commission_json))
    base = url('FIRMWARE_FACTORY_FILES', release=version, model=model)
    return {
        **head(version, commission['commit'], notes),
        'image': {'url': url('FIRMWARE_UPDATE_IMAGE', release=version, model=model),
                  **entry(read(local('FIRMWARE_UPDATE_IMAGE')))},
        'setup': {'url': url('SETUP_MODULE', release=version, model=model),
                  **entry(read(local('SETUP_MODULE')))},
        'flash_size': commission['flash_size'],
        'files': [{'offset': f['offset'], 'url': base + f['file'], 'size': f['size'], 'sha256': f['sha256']}
                  for f in commission['files']],
    }


def support_release(images, name, version, commit, notes):
    """Release version of support firmware at urls.toml entry name, built from
    commit."""
    data = read(os.path.join(images, path(name, release=version)))
    return {**head(version, commit, notes), 'image': {'url': url(name, release=version), **entry(data)}}


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    add_arguments(p)
    p.add_argument('--firmware', required=True)
    p.add_argument('--version', required=True)
    p.add_argument('--commit')
    p.add_argument('--notes')
    args = p.parse_args()

    kind = firmware_type(args.firmware)
    if kind == 'firmware':
        if args.commit:
            fail('--commit is for support firmware. Airfrog firmware\'s commit is in commission.json.')
        release = airfrog_release(args.images, AIRFROG_FIRMWARE[args.firmware], args.version, args.notes)
    else:
        if not args.commit:
            fail('Support firmware requires --commit')
        names = {SCHEMA.data['recovery_constants'][k]['value']: name for k, name in SUPPORT.items()}
        release = support_release(args.images, names[args.firmware], args.version, args.commit, args.notes)

    manifest = load_manifest(args.images, kind)
    firmware = manifest['firmware']
    firmware[args.firmware] = add_release(firmware.get(args.firmware, []), release)
    key = write_manifest(args.images, manifest, args.signer, args.cacert)
    print('%s release %s added to the %s manifest, signed by %s' % (args.firmware, args.version, kind, key.hex()))


if __name__ == '__main__':
    main()
