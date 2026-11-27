"""Code the release scripts share to write Airfrog's manifests and the
signed list of extensions.
"""
import json
import os
import re

from schema import load, support_firmware
from signing import MANIFEST_VERSION, entry, fail, previous, read, read_signed_file, release_signed, sign
from urls import path, url

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


def airfrog_manifest(key, full_access):
    """The Airfrog manifest: each other manifest's address from
    urls.toml with key, the client library's directory, and full_access,
    the websites whose extension UIs have full access."""
    entry = {'url': None, 'key': key}
    return {
        'type': 'airfrog',
        'version': MANIFEST_VERSION,
        'ui_manifest': {**entry, 'url': url('UI_MANIFEST')},
        'firmware_manifest': {**entry, 'url': url('FIRMWARE_MANIFEST')},
        'support_firmware_manifest': {**entry, 'url': url('SUPPORT_FIRMWARE_MANIFEST')},
        'cli_manifest': {**entry, 'url': url('CLI_MANIFEST')},
        'extensions_manifest': {**entry, 'url': url('EXTENSIONS_MANIFEST')},
        'js_library': url('CLIENT_LIBRARIES'),
        'full_access_websites': full_access,
    }


def released_full_access():
    """The released Airfrog manifest's full_access_websites: AIRFROG_TLD's
    website."""
    return [url('AIRFROG_TLD').rstrip('/')]


# A path segment of an extension image in the repository.
SEGMENT = re.compile(r'[A-Za-z0-9_-][A-Za-z0-9._-]*')


def sign_extensions(repository, signer, https_ui=True):
    """Signs each extension image in repository's signed list that isn't
    signed yet, with signer, a signing.Signer. Replaces the image with its
    signed file and updates its size and SHA-256 in the list, then signs the
    list, and writes the images and the list together. Returns the number of
    images signed. Fails, writing nothing, when an image is outside the
    repository at EXTENSIONS_MANIFEST's directory, doesn't match its size and
    SHA-256, or is signed with a key that isn't a release key, or, with
    https_ui, when a UI address isn't https://."""
    out = os.path.join(repository, 'manifest.json')
    manifest = json.loads(read(out))
    if manifest.get('type') != 'extensions':
        fail('%s isn\'t a signed list of extensions.' % out)
    base = url('EXTENSIONS_MANIFEST').rsplit('/', 1)[0] + '/'
    unsigned = []
    for name, extension in manifest.get('extensions', {}).items():
        for version in extension.get('versions', []):
            label = '%s %s' % (name, version.get('metadata', {}).get('version'))
            ui = version.get('metadata', {}).get('ui')
            if https_ui and ui is not None and not str(ui).startswith('https://'):
                fail('%s has the UI address %s, which isn\'t https://. Publish it with an https:// UI.' % (label, ui))
            for image in version.get('images', []):
                address = str(image.get('url', ''))
                segments = address[len(base):].split('/') if address.startswith(base) else []
                if not segments or not all(SEGMENT.fullmatch(s) for s in segments):
                    fail('%s has an extension image at %s, which isn\'t a file in %s. Publish it with airfrog-ext '
                         'publish --url %s.' % (label, address, base, base))
                file = os.path.join(repository, *segments)
                data = read(file) if os.path.isfile(file) else None
                if data is None or entry(data) != {'size': image.get('size'), 'sha256': image.get('sha256')}:
                    fail("%s's extension image %s doesn't match its size and SHA-256." % (label, file))
                split = read_signed_file(data, 'extension')
                if split is None:
                    fail('%s isn\'t an extension image.' % file)
                if split[1] is None:
                    unsigned.append((image, file, data))
                elif not release_signed(data, 'extension'):
                    fail('%s is signed with a key that isn\'t a release key.' % file)

    signer.public_key()
    files = []
    for image, file, data in unsigned:
        signed = signer.sign_image(data, 'extension')
        image.update(entry(signed))
        files.append((file, signed))
    signer.sign_manifest(manifest, out, files)
    return len(unsigned)


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
    return sign(manifest, signer, cacert, manifest_path(images, manifest['type']))


def add_arguments(p):
    """The arguments every release script of these manifests has."""
    p.add_argument('--images', required=True)
    p.add_argument('--signer', required=True)
    p.add_argument('--cacert')
