"""Airfrog's manifests that list releases, for the release scripts: the
firmware manifest, the support firmware manifest and the CLI manifest.
"""
import os
import re

from schema import load, support_firmware
from signing import MANIFEST_VERSION, fail, manifest_key, previous, sign
from urls import path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = re.compile(r'\d+\.\d+\.\d+')
SCHEMA = load()
# Each released model's Airfrog firmware's key in the firmware manifest, and
# the model's key.
AIRFROG_FIRMWARE = {'airfrog-' + v['key']: v['key'] for v in SCHEMA.released()}
# The support firmware manifest's keys.
SUPPORT_FIRMWARE = support_firmware(SCHEMA)
# Each manifest's urls.toml entry, by its type.
MANIFESTS = {'firmware': 'FIRMWARE_MANIFEST', 'support-firmware': 'SUPPORT_FIRMWARE_MANIFEST',
             'cli': 'CLI_MANIFEST'}
# Each manifest's releases field, by its type.
RELEASES = {'firmware': 'firmware', 'support-firmware': 'firmware', 'cli': 'releases'}


def firmware_type(name):
    """The type of the manifest that lists firmware name."""
    if name in AIRFROG_FIRMWARE:
        return 'firmware'
    if name in SUPPORT_FIRMWARE:
        return 'support-firmware'
    fail('%s isn\'t a released model\'s Airfrog firmware or support firmware' % name)


def manifest_path(images, kind):
    return os.path.join(images, path(MANIFESTS[kind]))


def load_manifest(images, kind):
    """The manifest of type kind in images, or a new one without releases."""
    file = manifest_path(images, kind)
    last = previous(file)
    field = RELEASES[kind]
    for name in ('latest', field):
        if last and name not in last:
            fail('%s doesn\'t have %s' % (file, name))
    return {
        'type': kind,
        'version': MANIFEST_VERSION,
        'latest': dict(last['latest']) if last else {},
        field: last[field] if last else ([] if kind == 'cli' else {}),
    }


def add_release(releases, release):
    """releases with release in place of any with its version, in version
    order, highest first."""
    if not VERSION.fullmatch(release['version']):
        fail('%s isn\'t a version' % release['version'])
    others = [r for r in releases if r['version'] != release['version']]
    return sorted(others + [release], key=lambda r: tuple(int(n) for n in r['version'].split('.')), reverse=True)


def find_release(releases, version):
    """Release version of releases."""
    for release in releases:
        if release['version'] == version:
            return release
    fail('Release %s isn\'t listed' % version)


def write_manifest(images, manifest, signer, cacert):
    """Has the signing server sign manifest and writes it. Returns the key's
    public half."""
    return sign(manifest, signer, cacert, manifest_path(images, manifest['type']), manifest_key(ROOT))


def add_arguments(p):
    """The arguments every release script of these manifests has."""
    p.add_argument('--images', required=True)
    p.add_argument('--signer', required=True)
    p.add_argument('--cacert')
