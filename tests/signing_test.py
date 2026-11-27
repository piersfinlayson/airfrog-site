"""Tests of ci/signing.py, ci/release-extensions.py and the Airfrog manifest
of ci/release-airfrog.py against a stand-in signing server, which signs with
the test keys in build/test-keys/ (tests/ui/minisign.mjs makes the same
keys).

Usage: python3 tests/signing_test.py
"""
import base64
import contextlib
import getpass
import hashlib
import http.server
import importlib.util
import io
import json
import os
import struct
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'ci'))

import signing  # noqa: E402
from urls import url  # noqa: E402

KEYS = os.path.join(ROOT, 'build', 'test-keys')
PIN = 'test-pin'


def key_file(name):
    """Test key name's private key file, made the first time."""
    path = os.path.join(KEYS, name + '.pem')
    if not os.path.exists(path):
        os.makedirs(KEYS, exist_ok=True)
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'ed25519', '-out', path + '.new'], check=True)
        os.replace(path + '.new', path)
    return path


def public_key(name):
    der = subprocess.run(['openssl', 'pkey', '-in', key_file(name), '-pubout', '-outform', 'DER'],
                         check=True, capture_output=True).stdout
    return der[-32:]


def ed_sign(name, data):
    with tempfile.NamedTemporaryFile() as f:
        f.write(data)
        f.flush()
        return subprocess.run(['openssl', 'pkeyutl', '-sign', '-rawin', '-inkey', key_file(name), '-in', f.name],
                              check=True, capture_output=True).stdout


def minisig(name, body, file):
    """A minisign signature file of body, as the signing server writes it."""
    signature = b'Ed' + public_key(name)[:8] + ed_sign(name, body)
    trusted = 'timestamp:0\tfile:%s' % file
    return ('untrusted comment: signature from the Airfrog signing server\n%s\ntrusted comment: %s\n%s\n'
            % (base64.b64encode(signature).decode(), trusted,
               base64.b64encode(ed_sign(name, signature[10:] + trusted.encode())).decode())).encode()


class Server:
    """The stand-in signing server, signing with test key name."""

    def __init__(self, name):
        self.name = name
        self.requests = []
        server = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, body, status=200):
                self.send_response(status)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                server.requests.append(('GET', self.path))
                if self.path == '/v1/release/public-key':
                    return self.reply(public_key(server.name))
                self.reply(b'', 404)

            def do_POST(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                server.requests.append(('POST', self.path))
                if self.headers.get('Authorization') != 'Bearer ' + PIN:
                    return self.reply(b'PIN', 401)
                kind = self.path.removeprefix('/v1/release/sign-')
                if kind not in ('manifest', 'firmware', 'extension'):
                    return self.reply(b'', 404)
                self.reply(minisig(server.name, body, kind))

        self.httpd = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        self.url = 'http://127.0.0.1:%d' % self.httpd.server_port
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()


def firmware_image(size=4096):
    """An ESP-IDF app image of size bytes, a multiple of 16, with one
    segment."""
    data = bytearray((i * 13) & 0xff for i in range(size))
    data[0] = 0xE9
    data[1] = 1
    data[23] = 0
    struct.pack_into('<I', data, 28, size - 48)
    return bytes(data)


def extension_image(name='hello', metadata=b'{"name":"hello"}', module=b''):
    head = 30 + len(name)
    data = bytearray(b'AFXI' + bytes(24) + struct.pack('<H', len(name)) + name.encode() + metadata + module)
    struct.pack_into('<IIII', data, 12, head, len(metadata), head + len(metadata), len(module))
    return bytes(data)


def load_script(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), os.path.join(ROOT, 'ci', name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@contextlib.contextmanager
def patched(release_keys):
    """The release keys signing.py reads replaced with test keys, and the
    PIN prompt answered."""
    saved = signing.keys, getpass.getpass
    signing.keys = lambda: ([public_key(k).hex() for k in release_keys], 'https://manifest.test/manifest.json')
    getpass.getpass = lambda prompt='': PIN
    try:
        yield
    finally:
        signing.keys, getpass.getpass = saved


def run_main(main, argv):
    """main() with argv, its output discarded. Returns the exit message or
    None."""
    saved = sys.argv
    sys.argv = argv
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            main()
        return None
    except SystemExit as e:
        return str(e.code)
    finally:
        sys.argv = saved


class SignedFiles(unittest.TestCase):
    def test_firmware(self):
        image = firmware_image(4096)
        self.assertEqual(signing.read_signed_file(image, 'firmware'), (image, None))
        signed = signing.signed_file(image, b'Ed' + bytes(72))
        self.assertEqual(len(signed), 4096 + 4 + 74)
        self.assertEqual(signing.read_signed_file(signed, 'firmware'), (image, b'Ed' + bytes(72)))
        self.assertIsNone(signing.read_signed_file(signed + b'\0', 'firmware'))
        self.assertIsNone(signing.read_signed_file(image + b'\1', 'firmware'))
        self.assertIsNone(signing.read_signed_file(image[:4000], 'firmware'))
        hashed = bytearray(firmware_image(4128))
        hashed[23] = 1
        struct.pack_into('<I', hashed, 28, 4096 - 48)
        self.assertEqual(signing.firmware_length(bytes(hashed)), 4128, 'an appended SHA-256')

    def test_hostile_lengths(self):
        for lengths in ([0xFFFFFFF0], [0x80000000], [0x7FFFFFF0, 0x7FFFFFF0], [0xFFFFFFFF, 0]):
            data = bytearray(110)
            data[0] = 0xE9
            data[1] = len(lengths)
            for i, n in enumerate(lengths):
                struct.pack_into('<I', data, 28 + 8 * i, n)
            data[32:36] = signing.SIGNATURE_MAGIC
            self.assertIsNone(signing.read_signed_file(bytes(data), 'firmware'), lengths)

    def test_extension(self):
        image = extension_image()
        self.assertEqual(len(image) % 4, 3)
        signed = signing.signed_file(image, b'Ed' + bytes(72))
        self.assertEqual(signed[len(image):len(image) + 1], b'\0', 'zeros to a 4-byte boundary')
        self.assertEqual(signing.read_signed_file(signed, 'extension'), (image, b'Ed' + bytes(72)))
        bad = bytearray(signed)
        bad[len(image)] = 1
        self.assertIsNone(signing.read_signed_file(bytes(bad), 'extension'), 'a padding byte that isn\'t 0')
        self.assertIsNone(signing.read_signed_file(b'AFXJ' + image[4:], 'extension'))


class SignImage(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def sign(self, server, kind, data):
        path = os.path.join(self.dir, 'in.bin')
        out = os.path.join(self.dir, 'out.bin')
        with open(path, 'wb') as f:
            f.write(data)
        error = run_main(signing.main, ['signing.py', kind, path, '--out', out, '--signer', server.url])
        return error, (signing.read(out) if os.path.exists(out) else None)

    def test_signs_with_a_release_key(self):
        for kind, image in (('sign-firmware', firmware_image()), ('sign-extension', extension_image())):
            server = Server('backup')
            with patched(['release', 'backup']):
                error, out = self.sign(server, kind, image)
                self.assertIsNone(error)
                self.assertTrue(signing.release_signed(out, kind.removeprefix('sign-')))
            got, signature = signing.read_signed_file(out, kind.removeprefix('sign-'))
            self.assertEqual(got, image)
            self.assertEqual(signature[2:10], public_key('backup')[:8])
            self.assertIn(('POST', '/v1/release/' + kind), server.requests)
            server.close()
            os.remove(os.path.join(self.dir, 'out.bin'))

    def test_a_server_key_that_isnt_a_release_key_signs_nothing(self):
        server = Server('other')
        with patched(['release', 'backup']):
            error, out = self.sign(server, 'sign-firmware', firmware_image())
        self.assertIn("isn't one of commissioning/release-keys.js's release keys", error)
        self.assertIsNone(out)
        self.assertFalse(any(method == 'POST' for method, _ in server.requests))
        server.close()

    def test_a_signed_or_invalid_image_fails(self):
        server = Server('release')
        with patched(['release']):
            error, out = self.sign(server, 'sign-firmware', signing.signed_file(firmware_image(), b'Ed' + bytes(72)))
            self.assertIn('already signed', error)
            error, out = self.sign(server, 'sign-extension', firmware_image())
            self.assertIn("isn't an extension image", error)
        self.assertIsNone(out)
        server.close()

    def test_release_signed(self):
        image = firmware_image()
        with patched(['release']):
            self.assertTrue(signing.release_signed(
                signing.signed_file(image, b'Ed' + public_key('release')[:8] + ed_sign('release', image)), 'firmware'))
            self.assertFalse(signing.release_signed(
                signing.signed_file(image, b'Ed' + public_key('other')[:8] + ed_sign('other', image)), 'firmware'))
            self.assertFalse(signing.release_signed(
                signing.signed_file(image, b'Ed' + public_key('release')[:8] + ed_sign('release', b'x')), 'firmware'))
            self.assertFalse(signing.release_signed(image, 'firmware'), 'unsigned')


class ReleaseExtensions(unittest.TestCase):
    def test_signs_new_images_then_the_list(self):
        repo = tempfile.mkdtemp()
        base = url('EXTENSIONS_MANIFEST').rsplit('/', 1)[0] + '/'
        image = extension_image()
        rel = 'hello/1.0.0/wamr-0.0.0/model-0.bin'
        os.makedirs(os.path.join(repo, os.path.dirname(rel)))
        with open(os.path.join(repo, rel), 'wb') as f:
            f.write(image)
        entry = {'model': 0, 'wamr': '0.0.0', 'url': base + rel, **signing.entry(image)}
        manifest = {'type': 'extensions', 'version': 1, 'extensions': {'hello': {'depublished': False, 'versions': [
            {'metadata': {'name': 'hello', 'version': '1.0.0', 'ui': 'https://example.com/'}, 'images': [entry]}]}}}
        with open(os.path.join(repo, 'manifest.json'), 'w') as f:
            json.dump(manifest, f)
        script = load_script('release-extensions')
        server = Server('release')
        argv = ['release-extensions.py', '--repository', repo, '--signer', server.url]
        with patched(['release', 'backup']):
            self.assertIsNone(run_main(script.main, argv))
            signed = signing.read(os.path.join(repo, rel))
            self.assertTrue(signing.release_signed(signed, 'extension'))
            listed = json.loads(signing.read(os.path.join(repo, 'manifest.json')))
            self.assertEqual(listed['extensions']['hello']['versions'][0]['images'][0],
                             {**entry, **signing.entry(signed)}, "the list's size and SHA-256 are the signed file's")
            body = signing.read(os.path.join(repo, 'manifest.json'))
            text = signing.read(os.path.join(repo, 'manifest.json.minisig')).decode()
            self.assertIsNotNone(signing.minisig_signature(public_key('release'), text, body))
            posts = [p for m, p in server.requests if m == 'POST']
            self.assertEqual(posts, ['/v1/release/sign-extension', '/v1/release/sign-manifest'],
                             'the image is signed before the list')

            server.requests.clear()
            self.assertIsNone(run_main(script.main, argv))
            self.assertEqual(signing.read(os.path.join(repo, rel)), signed, 'a signed image is kept')
            self.assertEqual([p for m, p in server.requests if m == 'POST'], ['/v1/release/sign-manifest'])

            with open(os.path.join(repo, rel), 'wb') as f:
                f.write(image + b'\0')
            error = run_main(script.main, argv)
            self.assertIn("doesn't match its size and SHA-256", error)
        server.close()


class ReleaseUi(unittest.TestCase):
    def test_built_keys(self):
        release_ui = load_script('release-ui')
        a, b, c = 'aa' * 32, 'bb' * 32, 'cc' * 32
        ui = 'var RELEASE_KEYS = ["%s", "%s"];\nvar AIRFROG_MANIFEST = "https://m.test/manifest.json";\n' % (a, b)
        self.assertEqual(release_ui.built_keys(ui), ([a, b], 'https://m.test/manifest.json'))
        extra = ui.replace('"%s"]' % b, '"%s", "%s"]' % (b, c))
        self.assertEqual(release_ui.built_keys(extra)[0], [a, b, c], 'an extra developer key is read, so it differs')
        self.assertIsNone(release_ui.built_keys(ui + 'var RELEASE_KEYS2 = ["%s"];' % c), 'two lists')
        self.assertIsNone(release_ui.built_keys('var AIRFROG_MANIFEST = "x";'), 'no keys')

    def test_ci_build_ui(self):
        path = os.path.join(ROOT, 'build', 'ui', 'ui.js')
        if not os.path.exists(path):
            self.skipTest('ci/build-ui.sh has not built build/ui/ui.js')
        ui = signing.read(path).decode()
        self.assertEqual(load_script('release-ui').built_keys(ui), signing.keys(),
                         "ci/build-ui.sh's bundle has exactly release-keys.js's keys and address")


class AirfrogManifest(unittest.TestCase):
    def test_s8_format(self):
        releases = load_script('releases')
        key = 'ab' * 32
        m = releases.airfrog_manifest(key, ['https://airfrog.org'])
        self.assertEqual(m['type'], 'airfrog')
        for field in ('ui_manifest', 'firmware_manifest', 'support_firmware_manifest', 'cli_manifest',
                      'extensions_manifest'):
            self.assertEqual(m[field]['key'], key)
            self.assertTrue(m[field]['url'].startswith('https://'), field)
        self.assertEqual(m['extensions_manifest']['url'], url('EXTENSIONS_MANIFEST'))
        self.assertEqual(m['js_library'], url('CLIENT_LIBRARIES'))
        self.assertEqual(m['full_access_websites'], ['https://airfrog.org'])
        self.assertEqual(url('AIRFROG_TLD').rstrip('/'), 'https://airfrog.org',
                         "the released full_access_websites is AIRFROG_TLD's origin")


if __name__ == '__main__':
    unittest.main()
