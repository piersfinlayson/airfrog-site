"""Tests of ci/dev.py and the release code it shares. Each test of the
command runs it in a copy of this repository, with a stand-in
ci/build-ui.sh, beside a stand-in airfrog-v2. That has airfrog-v2's own
ci/release-app.sh, with stand-ins for its ci/release-files.py and ESP-IDF
scripts. The copy uses this repository's pinned Python.

Usage: python3 tests/dev_test.py
"""
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import unittest
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
V2 = os.path.join(os.path.dirname(ROOT), 'airfrog-v2')
sys.path.insert(0, os.path.join(ROOT, 'ci'))

import releases  # noqa: E402
import signing  # noqa: E402
import urls  # noqa: E402


def text(path):
    with open(path) as f:
        return f.read()


PYTHON = sys.executable
HOST = '127.0.0.1'
UI_VERSION = text(os.path.join(ROOT, 'ui', 'ui-version')).strip()
JS_VERSION = text(os.path.join(ROOT, 'js', 'js-version')).strip()
RELEASED = releases.released_full_access()

# A stand-in ci/build-ui.sh: writes build/ui/ui.js with the environment's
# address and keys, as ui/build.mjs bundles them, and an empty files.json.
BUILD_UI = r'''#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "${ROOT}/build/ui"
keys="$(echo "${AIRFROG_KEYS}" | sed 's/[^,]*/"&"/g')"
printf 'var RELEASE_KEYS = [%s];\nvar AIRFROG_MANIFEST = "%s";\n// developer change\n' \
    "${keys}" "${AIRFROG_MANIFEST}" > "${ROOT}/build/ui/ui.js"
printf '[]\n' > "${ROOT}/build/ui/files.json"
'''

# A stand-in for airfrog-v2's ci/release-files.py --app: the app, the factory
# image and the factory files, each the app, and commission.json.
RELEASE_FILES = r'''import hashlib, json, os, sys
if os.environ.get('RELEASE_FILES_FAIL'):
    sys.exit('release-files.py failed')
app, model, build, factory, out = sys.argv[2:]
name = 'airfrog-' + model
data = open(app, 'rb').read()
os.makedirs(os.path.join(out, name + '.factory'))
for path in (name + '.bin', name + '.factory.bin', os.path.join(name + '.factory', name + '.bin')):
    open(os.path.join(out, path), 'wb').write(data)
json.dump({'version': '0.2.0', 'commit': '1a2b3c4', 'model': model, 'flash_size': 4194304,
           'files': [{'offset': 327680, 'file': name + '.bin', 'size': len(data),
                      'sha256': hashlib.sha256(data).hexdigest()}]},
          open(os.path.join(out, name + '.factory', 'commission.json'), 'w'))
'''

# An openssl without Ed25519, as macOS's LibreSSL.
NO_ED25519 = '#!/bin/sh\necho "Algorithm ed25519 not found" >&2\nexit 1\n'
# An openssl that fails with -out, so making the key fails after the check.
FAILS_WITH_OUT = '#!/bin/sh\nfor a; do [ "$a" = -out ] && exit 1; done\nexec %s "$@"\n' % shutil.which('openssl')


def firmware_image(contents):
    """An ESP-IDF app image with one segment containing contents."""
    segment = contents + bytes(-len(contents) % 4)
    header = bytes([0xE9, 1]) + bytes(22)
    body = header + struct.pack('<II', 0x3f400020, len(segment)) + segment
    return body + bytes(len(body) // 16 * 16 + 16 - len(body))


def extension_image(module):
    """An extension image with the module and metadata {}."""
    header = b'AFXI' + bytes(8) + struct.pack('<IIII', 32, 2, 34, len(module))
    return header + bytes(32 - len(header)) + b'{}' + module


def entry(data):
    return {'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def free_port():
    with socket.socket() as s:
        s.bind((HOST, 0))
        return s.getsockname()[1]


def tree(path):
    """Each file under path and its contents."""
    out = {}
    for top, _, files in os.walk(path):
        for name in files:
            with open(os.path.join(top, name), 'rb') as f:
                out[os.path.relpath(os.path.join(top, name), path)] = f.read()
    return out


def load_dev():
    spec = importlib.util.spec_from_file_location('dev', os.path.join(ROOT, 'ci', 'dev.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def failure(fn, *args, **kwargs):
    """The message fn fails with, or None."""
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            fn(*args, **kwargs)
    except SystemExit as e:
        return str(e.code)
    return None


class DevTest(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.site = os.path.join(self.dir, 'airfrog-site')
        shutil.copytree(ROOT, self.site, ignore=shutil.ignore_patterns('build', '__pycache__', '.git'))
        os.makedirs(os.path.join(self.site, 'build'))
        pin = text(os.path.join(ROOT, 'ci', 'python-version')).strip()
        os.symlink(os.path.join(ROOT, 'build', 'python-' + pin), os.path.join(self.site, 'build', 'python-' + pin))
        self.write(os.path.join(self.site, 'ci', 'build-ui.sh'), BUILD_UI)
        self.v2 = os.path.join(self.dir, 'airfrog-v2')
        ci = os.path.join(self.v2, 'ci')
        os.makedirs(ci)
        shutil.copy(os.path.join(V2, 'ci', 'release-app.sh'), ci)
        idf = os.path.join(self.dir, 'idf')
        os.makedirs(idf)
        self.write(os.path.join(idf, 'export.sh'), '')
        self.write(os.path.join(ci, 'install-python.sh'), '#!/bin/sh\ndirname "%s"\n' % PYTHON)
        self.write(os.path.join(ci, 'install-esp-idf.sh'), '#!/bin/sh\necho "%s"\n' % idf)
        self.write(os.path.join(ci, 'release-files.py'), RELEASE_FILES)
        self.bin = os.path.join(self.dir, 'bin')
        os.makedirs(self.bin)
        self.env = {**os.environ, 'PATH': os.pathsep.join([self.bin, os.path.dirname(PYTHON), os.environ['PATH']])}
        self.server = None

    def tearDown(self):
        if self.server:
            self.server.terminate()
            self.server.wait()
            self.server.stdout.close()
        shutil.rmtree(self.dir)

    @staticmethod
    def write(path, contents, mode=0o755):
        with open(path, 'wb' if isinstance(contents, bytes) else 'w') as f:
            f.write(contents)
        os.chmod(path, mode)

    def path(self, *parts):
        return os.path.join(self.site, *parts)

    def dev(self, *args, fails=False):
        r = subprocess.run([PYTHON, self.path('ci', 'dev.py'), *args], capture_output=True, text=True,
                           env=self.env)
        if fails:
            self.assertNotEqual(r.returncode, 0, 'dev.py %s succeeded' % ' '.join(args))
            self.assertNotIn('Traceback', r.stderr)
        elif r.returncode != 0:
            self.fail('dev.py %s failed:\n%s%s' % (' '.join(args), r.stdout, r.stderr))
        return r

    def serve_fails(self, port, *args):
        return self.dev('serve', '--host', HOST, '--port', str(port), '--airfrog-v2', self.v2, *args, fails=True)

    def key(self):
        self.dev('keys')
        return bytes.fromhex(text(self.path('build', 'dev', 'keys', 'public.hex')))

    def sign(self, data):
        """data's signed file, signed with the developer key."""
        with tempfile.NamedTemporaryFile() as f:
            f.write(data)
            f.flush()
            signature = subprocess.run(['openssl', 'pkeyutl', '-sign', '-rawin', '-inkey',
                                        self.path('build', 'dev', 'keys', 'private.pem'), '-in', f.name],
                                       check=True, capture_output=True).stdout
        key = bytes.fromhex(text(self.path('build', 'dev', 'keys', 'public.hex')))
        return signing.signed_file(data, b'Ed' + key[:8] + signature)

    def build_firmware(self, key, manifest, model='mini'):
        """Writes model's release files as airfrog-v2's ci/build.sh does."""
        build = os.path.join(self.v2, 'build', 'airfrog', model)
        release = os.path.join(build, 'release')
        os.makedirs(os.path.join(release, 'airfrog-%s.factory' % model), exist_ok=True)
        self.write(os.path.join(release, 'airfrog-%s.bin' % model), firmware_image(key + manifest.encode()), 0o644)
        self.write(os.path.join(release, 'airfrog-%s.factory' % model, 'commission.json'),
                   json.dumps({'version': '0.2.0', 'model': model}), 0o644)
        self.write(os.path.join(build, 'setup.js'), '// setup module\n', 0o644)

    def repository(self, images, ui=None):
        """An extension repository listing images, (name, data, url) each."""
        repository = os.path.join(self.dir, 'extensions')
        os.makedirs(repository)
        listed = []
        for name, data, address in images:
            if name:
                os.makedirs(os.path.dirname(os.path.join(repository, name)), exist_ok=True)
                self.write(os.path.join(repository, name), data, 0o644)
            listed.append({'url': address, 'model': 1, **entry(data)})
        metadata = {'version': '1.0.0', **({'ui': ui} if ui else {})}
        self.write(os.path.join(repository, 'manifest.json'), json.dumps(
            {'type': 'extensions', 'version': 1, 'extensions': {'hello': {'versions': [
                {'metadata': metadata, 'images': listed}]}}}), 0o644)
        return repository

    def serve(self, port, *args):
        """Starts dev.py serve and waits until it serves. Returns its output."""
        self.server = subprocess.Popen(
            [PYTHON, self.path('ci', 'dev.py'), 'serve', '--host', HOST, '--port', str(port),
             '--airfrog-v2', self.v2, *args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            env=self.env)
        output = []
        for line in self.server.stdout:
            output.append(line)
            if line.startswith('Serving'):
                return ''.join(output)
        self.server.wait()
        self.fail('dev.py serve stopped:\n' + ''.join(output))

    def get(self, port, path):
        with urllib.request.urlopen('http://%s:%d/%s' % (HOST, port, path), timeout=5) as r:
            self.assertEqual(r.headers['Access-Control-Allow-Origin'], '*')
            return r.read()

    def signed_manifest(self, key, port, path):
        """The manifest at path, checked against its signature by key."""
        body = self.get(port, path)
        minisig = self.get(port, path + '.minisig').decode()
        self.assertIsNotNone(signing.minisig_signature(key, minisig, body), path)
        return json.loads(body)

    # keys

    def test_keys(self):
        key = self.key()
        self.assertEqual(len(key), 32)
        private = self.path('build', 'dev', 'keys', 'private.pem')
        self.assertEqual(os.stat(private).st_mode & 0o777, 0o600)
        der = subprocess.run(['openssl', 'pkey', '-in', private, '-pubout', '-outform', 'DER'],
                             check=True, capture_output=True).stdout
        self.assertEqual(der[-32:], key)
        self.assertEqual(os.listdir(self.path('build', 'dev')), ['keys'])

    def test_keys_exist(self):
        key = self.key()
        r = self.dev('keys', fails=True)
        self.assertIn('exists', r.stderr)
        self.assertEqual(bytes.fromhex(text(self.path('build', 'dev', 'keys', 'public.hex'))), key)

    def test_keys_without_ed25519(self):
        self.write(os.path.join(self.bin, 'openssl'), NO_ED25519)
        r = self.dev('keys', fails=True)
        self.assertIn('requires OpenSSL 3', r.stderr)
        self.assertFalse(os.path.exists(self.path('build', 'dev')))

    def test_keys_failing_leaves_nothing(self):
        """A key that isn't made leaves nothing, so the next run makes it."""
        self.write(os.path.join(self.bin, 'openssl'), FAILS_WITH_OUT)
        r = self.dev('keys', fails=True)
        self.assertIn("didn't make the key", r.stderr)
        self.assertEqual(os.listdir(self.path('build', 'dev')), [])
        os.remove(os.path.join(self.bin, 'openssl'))
        self.key()

    def test_damaged_public_key(self):
        self.key()
        self.write(self.path('build', 'dev', 'keys', 'public.hex'), 'not hex\n', 0o644)
        r = self.serve_fails(free_port())
        self.assertIn("isn't a public key in hex", r.stderr)

    def test_damaged_private_key(self):
        key = self.key()
        port = free_port()
        self.build_firmware(key, 'http://%s:%d/manifest.json' % (HOST, port))
        self.write(self.path('build', 'dev', 'keys', 'private.pem'), 'damaged\n', 0o600)
        r = self.serve_fails(port)
        self.assertIn("didn't sign", r.stderr)

    def test_serve_without_key(self):
        r = self.serve_fails(free_port())
        self.assertIn('ci/dev.py keys', r.stderr)

    def test_serve_without_ed25519(self):
        self.key()
        self.write(os.path.join(self.bin, 'openssl'), NO_ED25519)
        r = self.serve_fails(free_port())
        self.assertIn('requires OpenSSL 3', r.stderr)

    # serve

    def test_serve(self):
        key = self.key()
        port = free_port()
        base = 'http://%s:%d/' % (HOST, port)
        manifest = base + 'manifest.json'
        self.build_firmware(key, manifest)
        # Pro built for another address isn't served.
        self.build_firmware(key, 'http://other/manifest.json', 'pro')
        unsigned = extension_image(b'mod1')
        signed = self.sign(extension_image(b'mod2'))
        repository = self.repository([
            ('hello/1.0.0/unsigned.bin', unsigned, base + 'extensions/hello/1.0.0/unsigned.bin'),
            ('hello/1.0.0/signed.bin', signed, base + 'extensions/hello/1.0.0/signed.bin')],
            ui='http://localhost:8000/hello/')
        before = tree(repository)

        output = self.serve(port, '--full-access', 'http://localhost:8000/hello/', '--extensions', repository)
        self.assertIn('Skipped airfrog-pro', output)
        top = self.signed_manifest(key, port, 'manifest.json')
        self.assertEqual(top['type'], 'airfrog')
        self.assertEqual(top['full_access_websites'], RELEASED + ['http://localhost:8000'])
        self.assertEqual(top['js_library'], base + 'images/' + urls.path('CLIENT_LIBRARIES'))
        for name in ('ui_manifest', 'firmware_manifest', 'support_firmware_manifest', 'cli_manifest',
                     'extensions_manifest'):
            self.assertEqual(top[name]['key'], key.hex())
            self.assertTrue(top[name]['url'].startswith(base), top[name]['url'])

        ui = self.signed_manifest(key, port, top['ui_manifest']['url'][len(base):])
        self.assertEqual(ui['ui_version'], UI_VERSION)
        body = self.get(port, ui['entry'][len(base):])
        self.assertEqual(ui['files'], {ui['entry']: entry(body)})
        self.assertIn(b'developer change', body)
        self.assertIn(manifest.encode(), body)
        self.get(port, 'images/' + urls.path('CLIENT_LIBRARY', js_version=JS_VERSION) + 'airfrog.js')

        firmware = self.signed_manifest(key, port, top['firmware_manifest']['url'][len(base):])
        self.assertEqual(firmware['latest'], {'airfrog-mini': '0.2.0'})
        release = firmware['firmware']['airfrog-mini'][0]
        data = self.get(port, release['image']['url'][len(base):])
        self.assertEqual(entry(data), {k: release['image'][k] for k in ('size', 'sha256')})
        image, signature = signing.read_signed_file(data, 'firmware')
        self.assertEqual(image, firmware_image(key + manifest.encode()))
        self.assertEqual(signature[2:10], key[:8])
        self.assertTrue(signing.verify(key, signature[10:], image))
        self.assertEqual(self.get(port, release['setup']['url'][len(base):]), b'// setup module\n')
        for f in release['files']:
            self.assertEqual(entry(self.get(port, f['url'][len(base):])), {k: f[k] for k in ('size', 'sha256')})
        self.get(port, 'images/' + urls.path('FIRMWARE_FACTORY_IMAGE', model='mini', release='0.2.0'))

        for name, field in (('support_firmware_manifest', 'firmware'), ('cli_manifest', 'releases')):
            listed = self.signed_manifest(key, port, top[name]['url'][len(base):])
            self.assertFalse(listed[field])

        extensions = self.signed_manifest(key, port, top['extensions_manifest']['url'][len(base):])
        listed = extensions['extensions']['hello']['versions'][0]['images']
        for image, module in zip(listed, (b'mod1', b'mod2')):
            data = self.get(port, image['url'][len(base):])
            self.assertEqual(entry(data), {k: image[k] for k in ('size', 'sha256')})
            split, signature = signing.read_signed_file(data, 'extension')
            self.assertEqual(split, extension_image(module))
            self.assertTrue(signing.verify(key, signature[10:], split))
        self.assertEqual(self.get(port, listed[1]['url'][len(base):]), signed, 'a signed image is kept')
        self.assertEqual(tree(repository), before, "the repository's files aren't changed")

    def test_without_full_access(self):
        key = self.key()
        port = free_port()
        self.build_firmware(key, 'http://%s:%d/manifest.json' % (HOST, port))
        self.serve(port)
        top = self.signed_manifest(key, port, 'manifest.json')
        self.assertEqual(top['full_access_websites'], RELEASED)
        listed = self.signed_manifest(key, port, 'extensions/manifest.json')
        self.assertEqual(listed['extensions'], {})
        self.assertEqual(json.loads(text(self.path('build', 'dev', 'extensions', 'manifest.json')))['type'],
                         'extensions', 'the default repository is made')

    def test_signature_trusted_comment(self):
        """A manifest's minisign file is the signing server's format, with
        file:manifest in its trusted comment."""
        key = self.key()
        port = free_port()
        self.build_firmware(key, 'http://%s:%d/manifest.json' % (HOST, port))
        self.serve(port)
        lines = self.get(port, 'manifest.json.minisig').decode().split('\n')
        self.assertRegex(lines[2], r'^trusted comment: timestamp:\d+\tfile:manifest$')
        self.assertEqual(base64.b64decode(lines[1])[:10], b'Ed' + key[:8])

    # firmware

    def test_firmware_for_another_address(self):
        key = self.key()
        self.build_firmware(key, 'http://other/manifest.json')
        r = self.serve_fails(free_port())
        self.assertIn('Skipped airfrog-mini', r.stderr)
        self.assertIn("doesn't have firmware built", r.stderr)

    def test_firmware_without_key(self):
        self.key()
        port = free_port()
        self.build_firmware(bytes(32), 'http://%s:%d/manifest.json' % (HOST, port))
        r = self.serve_fails(port)
        self.assertIn("doesn't have firmware built", r.stderr)

    def test_release_files_failing(self):
        key = self.key()
        port = free_port()
        self.build_firmware(key, 'http://%s:%d/manifest.json' % (HOST, port))
        self.env['RELEASE_FILES_FAIL'] = '1'
        r = self.serve_fails(port)
        self.assertIn("airfrog-v2's ci/release-app.sh failed for airfrog-mini", r.stderr)
        self.assertNotIn('IDF_TOOLS_PATH', r.stderr)

    # the address

    def test_address(self):
        """A host or port that can't form the manifest's address fails before
        anything is built."""
        self.key()
        for host, port in (('127.0.0.1', '70000'), ('127.0.0.1', '0'), ('::1', '18561'), ('a b', '18561'),
                           ('host/x', '18561')):
            r = self.dev('serve', '--host', host, '--port', port, '--airfrog-v2', self.v2, fails=True)
            self.assertRegex(r.stderr, "isn't a (port|host name)")
        self.assertFalse(os.path.exists(self.path('build', 'ui')))

    def test_address_not_this_computers(self):
        self.key()
        r = self.dev('serve', '--host', '192.0.2.1', '--port', str(free_port()), '--airfrog-v2', self.v2,
                     fails=True)
        self.assertIn("Can't serve at http://192.0.2.1:", r.stderr)
        self.assertFalse(os.path.exists(self.path('build', 'ui')))

    def test_port_in_use(self):
        """A port in use fails before build/dev/serve/ is replaced."""
        self.key()
        os.makedirs(self.path('build', 'dev', 'serve'))
        self.write(self.path('build', 'dev', 'serve', 'marker'), 'served\n', 0o644)
        with socket.socket() as s:
            s.bind((HOST, 0))
            s.listen()
            r = self.serve_fails(s.getsockname()[1])
        self.assertIn("Can't serve at", r.stderr)
        self.assertEqual(text(self.path('build', 'dev', 'serve', 'marker')), 'served\n')
        self.assertFalse(os.path.exists(self.path('build', 'ui')))

    # --full-access

    def test_full_access_invalid(self):
        self.key()
        for address in ('ftp://localhost/', 'http://localhost:abc/x', 'http://user:pw@localhost:8000/',
                        'http://[::1]:8000/', 'http:///x', 'localhost:8000'):
            r = self.serve_fails(free_port(), '--full-access', address)
            self.assertIn("--full-access %s isn't" % address, r.stderr)
        self.assertFalse(os.path.exists(self.path('build', 'ui')))

    def test_website(self):
        dev = load_dev()
        for address, website in (('http://localhost:8000/hello/', 'http://localhost:8000'),
                                 ('HTTP://LocalHost:80/x', 'http://localhost'),
                                 ('https://example.com:443/', 'https://example.com'),
                                 ('http://127.0.0.1:8000', 'http://127.0.0.1:8000')):
            self.assertEqual(dev.website(address), website)
        self.assertIsNotNone(failure(dev.website, 'http://localhost:99999/'))

    # --extensions

    def test_extensions_missing(self):
        self.key()
        missing = os.path.join(self.dir, 'airfrog-extensoins')
        r = self.serve_fails(free_port(), '--extensions', missing)
        self.assertIn("isn't an extension repository", r.stderr)
        self.assertFalse(os.path.exists(missing))

    def test_extensions_not_a_repository(self):
        self.key()
        project = os.path.join(self.dir, 'project')
        os.makedirs(project)
        self.write(os.path.join(project, 'extension-meta.json'), '{}', 0o644)
        r = self.serve_fails(free_port(), '--extensions', project)
        self.assertIn("isn't an extension repository", r.stderr)
        self.assertEqual(os.listdir(project), ['extension-meta.json'])
        self.assertFalse(os.path.exists(self.path('build', 'ui')))

    def test_extension_elsewhere(self):
        key = self.key()
        port = free_port()
        self.build_firmware(key, 'http://%s:%d/manifest.json' % (HOST, port))
        repository = self.repository([(None, extension_image(b'mod1'), 'https://extensions.example/hello.bin')])
        r = self.serve_fails(port, '--extensions', repository)
        self.assertIn('airfrog-ext publish --url http://%s:%d/extensions/' % (HOST, port), r.stderr)

    def test_extension_outside_the_repository(self):
        """An image whose address leaves the repository fails, and the file
        at that address isn't written."""
        key = self.key()
        port = free_port()
        base = 'http://%s:%d/extensions/' % (HOST, port)
        self.build_firmware(key, 'http://%s:%d/manifest.json' % (HOST, port))
        data = extension_image(b'mod1')
        outside = os.path.join(self.dir, 'x.bin')
        self.write(outside, data, 0o644)
        for address in ('../../../x.bin', '/' + outside.lstrip('/'), 'a//b.bin', '%2e%2e/x.bin', 'a/./b.bin', ''):
            repository = self.repository([(None, data, base + address)])
            r = self.serve_fails(port, '--extensions', repository)
            self.assertIn("isn't a file in", r.stderr, address)
            self.assertEqual(signing.read(outside), data)
            shutil.rmtree(repository)

    def test_extension_changed(self):
        key = self.key()
        port = free_port()
        base = 'http://%s:%d/' % (HOST, port)
        self.build_firmware(key, base + 'manifest.json')
        repository = self.repository([('hello.bin', extension_image(b'mod1'), base + 'extensions/hello.bin')])
        listed = json.loads(text(os.path.join(repository, 'manifest.json')))
        listed['extensions']['hello']['versions'][0]['images'][0].update(entry(extension_image(b'mod2')))
        self.write(os.path.join(repository, 'manifest.json'), json.dumps(listed), 0o644)
        r = self.serve_fails(port, '--extensions', repository)
        self.assertIn("doesn't match its size and SHA-256", r.stderr)

    def test_extension_signed_with_another_key(self):
        key = self.key()
        port = free_port()
        base = 'http://%s:%d/' % (HOST, port)
        self.build_firmware(key, base + 'manifest.json')
        other = signing.signed_file(extension_image(b'mod1'), b'Ed' + bytes(72))
        repository = self.repository([('hello.bin', other, base + 'extensions/hello.bin')])
        r = self.serve_fails(port, '--extensions', repository)
        self.assertIn("signed with a key that isn't a release key", r.stderr)


class Signer:
    """A stand-in signing.Signer that records what it signs."""

    def __init__(self):
        self.key = bytes(32)
        self.signed = []

    def public_key(self):
        return self.key

    def sign_image(self, image, kind):
        self.signed.append(kind)
        return signing.signed_file(image, b'Ed' + bytes(72))

    def sign_manifest(self, manifest, out, others=()):
        self.signed.append('manifest')
        signing.write_files([*others, (out, json.dumps(manifest).encode())])
        return self.key


class SignExtensions(unittest.TestCase):
    """releases.sign_extensions, which ci/release-extensions.py and ci/dev.py
    call."""

    def setUp(self):
        self.repository = tempfile.mkdtemp()
        self.base = urls.url('EXTENSIONS_MANIFEST').rsplit('/', 1)[0] + '/'

    def tearDown(self):
        shutil.rmtree(self.repository)

    def list(self, address, ui='https://example.com/'):
        data = extension_image(b'mod1')
        with open(os.path.join(self.repository, 'hello.bin'), 'wb') as f:
            f.write(data)
        with open(os.path.join(self.repository, 'manifest.json'), 'w') as f:
            json.dump({'type': 'extensions', 'extensions': {'hello': {'versions': [
                {'metadata': {'version': '1.0.0', 'ui': ui}, 'images': [{'url': address, **entry(data)}]}]}}}, f)

    def test_signs_images_then_the_list(self):
        self.list(self.base + 'hello.bin')
        signer = Signer()
        self.assertEqual(releases.sign_extensions(self.repository, signer), 1)
        self.assertEqual(signer.signed, ['extension', 'manifest'])
        listed = json.loads(text(os.path.join(self.repository, 'manifest.json')))
        self.assertEqual(listed['extensions']['hello']['versions'][0]['images'][0]['size'],
                         len(signing.read(os.path.join(self.repository, 'hello.bin'))))

    def test_ui_address(self):
        """A UI that isn't https fails unless https_ui is false, as for
        ci/dev.py."""
        self.list(self.base + 'hello.bin', ui='http://localhost:8000/')
        self.assertIn("isn't https://", failure(releases.sign_extensions, self.repository, Signer()))
        self.assertEqual(releases.sign_extensions(self.repository, Signer(), https_ui=False), 1)

    def test_outside_the_repository(self):
        for address in ('../x.bin', '/x.bin', 'a//x.bin', '%2e%2e/x.bin', './x.bin', 'x.bin?q', ''):
            self.list(self.base + address)
            message = failure(releases.sign_extensions, self.repository, Signer())
            self.assertIn("isn't a file in", message or '', address)


if __name__ == '__main__':
    unittest.main()
