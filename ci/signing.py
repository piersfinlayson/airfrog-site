"""Signing a manifest with Airfrog's signing server, for the release scripts.

A signed manifest is two files: the manifest, manifest.json, and its
minisign signature file, manifest.json.minisig. The signature is minisign's
legacy Ed25519 signature of the manifest's bytes.
"""
import base64
import getpass
import hashlib
import json
import os
import re
import ssl
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

from schema import load

# Every manifest's version, its schema's.
MANIFEST_VERSION = load().manifest_version
# An Ed25519 public key's DER prefix (RFC 8410).
ED25519_DER = bytes.fromhex('302a300506032b6570032100')
# minisign's signature algorithm for an Ed25519 signature of the file itself.
LEGACY = b'Ed'


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
    """Checks an Ed25519 signature with openssl, which has Ed25519."""
    with tempfile.TemporaryDirectory() as d:
        paths = {n: os.path.join(d, n) for n in ('key', 'sig', 'body')}
        open(paths['key'], 'wb').write(ED25519_DER + key)
        open(paths['sig'], 'wb').write(signature)
        open(paths['body'], 'wb').write(body)
        r = subprocess.run(['openssl', 'pkeyutl', '-verify', '-rawin', '-pubin', '-keyform', 'DER',
                            '-inkey', paths['key'], '-sigfile', paths['sig'], '-in', paths['body']],
                           capture_output=True)
        return r.returncode == 0


def verify_minisig(key, text, body):
    """Whether text is a minisign signature file of body by key, with both
    its signatures valid. The key ID is the key's first 8 bytes."""
    lines = text.split('\n')
    if len(lines) < 4 or not lines[0].startswith('untrusted comment: ') \
            or not lines[2].startswith('trusted comment: '):
        return False
    try:
        signature = base64.b64decode(lines[1], validate=True)
        global_signature = base64.b64decode(lines[3], validate=True)
    except ValueError:
        return False
    trusted = lines[2][len('trusted comment: '):].encode()
    return (len(signature) == 74 and signature[:2] == LEGACY and signature[2:10] == key[:8]
            and len(global_signature) == 64 and verify(key, signature[10:], body)
            and verify(key, global_signature, signature[10:] + trusted))


def previous(path):
    """The manifest at path, or None without one."""
    if not path or not os.path.exists(path):
        return None
    return json.load(open(path))


def manifest_key(root):
    """The manifest key's public half, as commissioning/manifest-key.js
    contains it, in hex."""
    text = open(os.path.join(root, 'commissioning', 'manifest-key.js')).read()
    key = re.search(r"MANIFEST_KEY = '([0-9a-f]*)'", text).group(1)
    if len(key) != 64:
        fail('commissioning/manifest-key.js has no manifest key.')
    return key


def sign(manifest, signer, cacert, out, expected):
    """Has the signing server sign manifest, checks the signature and writes
    the manifest to out and its signature file beside it. The server's key
    must be expected, in hex, or nothing is signed or written. Returns the
    key's public half."""
    body = (json.dumps(manifest, indent=2) + '\n').encode()
    context = ssl.create_default_context(cafile=cacert)
    url = signer.rstrip('/') + '/v1/manifest'
    key = fetch(url + '/public-key', context)
    if key.hex() != expected:
        fail("The signing server's manifest key isn't commissioning/manifest-key.js's, which Airfrog's "
             "firmware, Airfrog's full user interface and airfrog.org/commissioning verify with.")
    pin = getpass.getpass('PIN: ')
    signature = fetch(url + '/sign', context, body,
                      {'Authorization': 'Bearer ' + pin, 'Content-Type': 'application/json'})
    if len(key) != 32 or not verify_minisig(key, signature.decode(errors='replace'), body):
        fail("The signing server's signature doesn't verify.")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    written = [(out, body), (out + '.minisig', signature)]
    for name, data in written:
        with open(name + '.new', 'wb') as f:
            f.write(data)
    for name, _ in written:
        os.replace(name + '.new', name)
    return key
