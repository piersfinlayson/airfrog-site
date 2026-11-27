"""Signing with Airfrog's signing server, for the release scripts.

A signed manifest is two files: the manifest, manifest.json, and its
minisign signature file, manifest.json.minisig. The signature is minisign's
legacy Ed25519 signature of the manifest's bytes.

A signed file is a firmware or extension image followed by 0 to 3 zero bytes
to a 4-byte boundary, SIGNATURE_MAGIC and the image's signature.

The server signs with the release key. Each signature is used only when the
server's key is one of commissioning/release-keys.js's.

Signs one image and writes the signed file:

  python3 ci/signing.py sign-firmware IMAGE --out FILE --signer URL
  python3 ci/signing.py sign-extension IMAGE --out FILE --signer URL
    IMAGE       an unsigned ESP-IDF image of Airfrog firmware, or an
                unsigned extension image
    --out       the signed file to write. It may be IMAGE
    --signer    the signing server, for example https://HOST:8444
    --cacert    a CA certificate for the signing server's TLS

The PIN is read from the terminal. Use the Python ci/install-python.sh
installs.
"""
import argparse
import base64
import getpass
import hashlib
import json
import os
import ssl
import struct
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

from schema import SchemaError, load, release_keys

SCHEMA = load()
# Every manifest's version, its schema's.
MANIFEST_VERSION = SCHEMA.manifest_version
# An Ed25519 public key's DER prefix (RFC 8410).
ED25519_DER = bytes.fromhex('302a300506032b6570032100')
# minisign's signature algorithm for an Ed25519 signature of the file itself.
LEGACY = b'Ed'
SIGNATURE_LEN = 74
SIGNATURE_MAGIC = b'AFSG'
EXT_IMAGE_MAGIC = b'AFXI'
ESP_IMAGE_MAGIC = 0xE9
# esp_image_header_t's length and its hash_appended byte.
ESP_HEADER_LEN = 24
ESP_HASH_APPENDED = 23


def fail(message):
    sys.exit(message)


def entry(data):
    return {'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def fetch(url, context=None, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(req, context=context, timeout=60) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        fail('%s: HTTP %d %s' % (url, e.code, e.read().decode(errors='replace').strip()))
    except OSError as e:
        fail('%s: %s' % (url, e))


def verify(key, signature, body):
    """Checks an Ed25519 signature with openssl."""
    with tempfile.TemporaryDirectory() as d:
        paths = {n: os.path.join(d, n) for n in ('key', 'sig', 'body')}
        for name, data in (('key', ED25519_DER + key), ('sig', signature), ('body', body)):
            with open(paths[name], 'wb') as f:
                f.write(data)
        r = subprocess.run(['openssl', 'pkeyutl', '-verify', '-rawin', '-pubin', '-keyform', 'DER',
                            '-inkey', paths['key'], '-sigfile', paths['sig'], '-in', paths['body']],
                           capture_output=True)
        return r.returncode == 0


def minisig_signature(key, text, body):
    """The 74-byte signature in text, a minisign signature file of body by
    key, or None unless both its signatures are valid. The key ID is the
    key's first 8 bytes."""
    lines = text.split('\n')
    if len(lines) < 4 or not lines[0].startswith('untrusted comment: ') \
            or not lines[2].startswith('trusted comment: '):
        return None
    try:
        signature = base64.b64decode(lines[1], validate=True)
        global_signature = base64.b64decode(lines[3], validate=True)
    except ValueError:
        return None
    trusted = lines[2][len('trusted comment: '):].encode()
    valid = (len(signature) == SIGNATURE_LEN and signature[:2] == LEGACY and signature[2:10] == key[:8]
             and len(global_signature) == 64 and verify(key, signature[10:], body)
             and verify(key, global_signature, signature[10:] + trusted))
    return signature if valid else None


def read(path):
    """The bytes of the file at path."""
    with open(path, 'rb') as f:
        return f.read()


def previous(path):
    """The manifest at path, or None without one."""
    if not path or not os.path.exists(path):
        return None
    return json.loads(read(path))


def keys():
    """commissioning/release-keys.js's release keys in hex and the Airfrog
    manifest's address."""
    try:
        return release_keys()
    except SchemaError as e:
        fail(str(e))


def firmware_length(data):
    """The length of the ESP-IDF app image at the start of data, as ESP-IDF
    reads it, or None when data doesn't start with a whole image."""
    if len(data) < ESP_HEADER_LEN or data[0] != ESP_IMAGE_MAGIC:
        return None
    at = ESP_HEADER_LEN
    for _ in range(data[1]):
        if at + 8 > len(data):
            return None
        at += 8 + struct.unpack_from('<I', data, at + 4)[0]
        if at > len(data):
            return None
    at = at // 16 * 16 + 16
    if data[ESP_HASH_APPENDED] == 1:
        at += 32
    return at if at <= len(data) else None


def extension_length(data):
    """The length of the extension image at the start of data, or None when
    data doesn't start with a whole image."""
    if len(data) < 30 or data[:4] != EXT_IMAGE_MAGIC:
        return None
    metadata_offset, metadata_len, module_offset, module_len = struct.unpack_from('<IIII', data, 12)
    end = module_offset + module_len
    return end if end <= len(data) and metadata_offset + metadata_len <= end else None


def read_signed_file(data, kind):
    """(image, signature) of a firmware or extension image file, signature
    None when it is unsigned, or None when it isn't a valid file of kind."""
    end = (firmware_length if kind == 'firmware' else extension_length)(data)
    if end is None:
        return None
    if end == len(data):
        return data, None
    block = end + (-end % 4)
    if len(data) != block + len(SIGNATURE_MAGIC) + SIGNATURE_LEN or any(data[end:block]) \
            or data[block:block + len(SIGNATURE_MAGIC)] != SIGNATURE_MAGIC:
        return None
    return data[:end], data[block + len(SIGNATURE_MAGIC):]


def release_signed(data, kind):
    """Whether data is a signed file of kind whose signature is by one of
    the release keys, selected by its key ID."""
    split = read_signed_file(data, kind)
    if split is None or split[1] is None or split[1][:2] != LEGACY:
        return False
    image, signature = split
    key = next((k for k in keys()[0] if bytes.fromhex(k)[:8] == signature[2:10]), None)
    return key is not None and verify(bytes.fromhex(key), signature[10:], image)


def signed_file(image, signature):
    """The signed file of image."""
    return image + bytes(-len(image) % 4) + SIGNATURE_MAGIC + signature


def write_files(files):
    """Writes each (path, data) of files, replacing them only once all are
    written."""
    for name, data in files:
        os.makedirs(os.path.dirname(os.path.abspath(name)), exist_ok=True)
        with open(name + '.new', 'wb') as f:
            f.write(data)
    for name, _ in files:
        os.replace(name + '.new', name)


class Signer:
    """The signing server at url. Its key is checked against the release
    keys once, and the PIN read once, at the first signature."""

    def __init__(self, url, cacert=None):
        self.url = url.rstrip('/') + '/v1/release'
        self.context = ssl.create_default_context(cafile=cacert)
        self.key = None
        self.pin = None

    def public_key(self):
        """The server's key, which must be one of the release keys."""
        if self.key is None:
            key = fetch(self.url + '/public-key', self.context)
            if key.hex() not in keys()[0]:
                fail("The signing server's key isn't one of commissioning/release-keys.js's release keys, which "
                     "Airfrog's firmware, the Airfrog UI and the airfrog CLI verify with.")
            self.key = key
        return self.key

    def sign(self, endpoint, body, content_type):
        """The 74-byte signature of body by the server, checked."""
        key = self.public_key()
        if self.pin is None:
            self.pin = getpass.getpass('PIN: ')
        text = fetch('%s/%s' % (self.url, endpoint), self.context, body,
                     {'Authorization': 'Bearer ' + self.pin, 'Content-Type': content_type})
        signature = minisig_signature(key, text.decode(errors='replace'), body)
        if signature is None:
            fail("The signing server's signature doesn't verify.")
        return signature, text

    def sign_manifest(self, manifest, out, others=()):
        """Signs manifest and writes it to out and its signature file beside
        it, with others, more (path, data) files. Returns the server's key."""
        body = (json.dumps(manifest, indent=2) + '\n').encode()
        _, minisig = self.sign('sign-manifest', body, 'application/json')
        write_files([*others, (out, body), (out + '.minisig', minisig)])
        return self.key

    def sign_image(self, image, kind):
        """The signed file of image, an unsigned image of kind 'firmware' or
        'extension'."""
        signature, _ = self.sign('sign-' + kind, image, 'application/octet-stream')
        return signed_file(image, signature)


def sign(manifest, signer, cacert, out):
    """Has the signing server sign manifest and writes the manifest to out
    and its signature file beside it. Returns the server's key."""
    return Signer(signer, cacert).sign_manifest(manifest, out)


def main():
    p = argparse.ArgumentParser(description='Sign one image with the signing server and write the signed file.')
    p.add_argument('kind', choices=['sign-firmware', 'sign-extension'])
    p.add_argument('image')
    p.add_argument('--out', required=True)
    p.add_argument('--signer', required=True)
    p.add_argument('--cacert')
    args = p.parse_args()

    kind = args.kind.removeprefix('sign-')
    data = read(args.image)
    split = read_signed_file(data, kind)
    if split is None:
        fail("%s isn't %s." % (args.image, 'an ESP-IDF image' if kind == 'firmware' else 'an extension image'))
    if split[1] is not None:
        fail('%s is already signed.' % args.image)
    signer = Signer(args.signer, args.cacert)
    write_files([(args.out, signer.sign_image(data, kind))])
    print('%s signed by %s' % (args.out, signer.key.hex()))


if __name__ == '__main__':
    main()
