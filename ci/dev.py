"""Makes a developer key and serves a local copy of Airfrog's releases signed
with it. airfrog-v2's DEVELOPING.md is the guide.

  python3 ci/dev.py keys
    Makes the developer key's private half in build/dev/keys/private.pem
    and its public half in hex, for AIRFROG_KEYS, in
    build/dev/keys/public.hex. Fails when the key exists.

  python3 ci/dev.py serve --host HOST --port PORT [--full-access URL]...
    Builds the full user interface with ci/build-ui.sh, with AIRFROG_MANIFEST
    set to http://HOST:PORT/manifest.json and AIRFROG_KEYS to the developer
    key. Writes these into build/dev/serve/ with the release scripts' code,
    signed with the developer key, and serves them at http://HOST:PORT/ until
    stopped:
      the manifests
      the client library
      the firmware's release files
      the extensions and their signed list
    --host         a host name or IPv4 address of this computer, which
                   Airfrog's pages and the CLI fetch from
    --port         the port
    --full-access  an extension UI's address. Its website is added to the
                   Airfrog manifest's full_access_websites. Can be repeated
    --airfrog-v2   the airfrog-v2 checkout (default: beside this repository).
                   Each released model's firmware built there by ci/build.sh
                   with the same AIRFROG_MANIFEST and key is served
    --extensions   the extension repository, a directory airfrog-ext publish
                   writes with --url http://HOST:PORT/extensions/ (default:
                   build/dev/extensions/, made with an empty list when it
                   doesn't exist)

The support firmware manifest and the CLI manifest don't list releases.
Requires OpenSSL 3 or later as openssl. ESP-IDF is used from INSTALL_DIR, as
airfrog-v2's ci/build.sh uses it. Use the Python ci/install-python.sh
installs.
"""
import argparse
import base64
import functools
import http.server
import json
import os
import re
import runpy
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse

import releases
import signing
import urls
from signing import fail, read, read_signed_file

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CI = os.path.join(ROOT, 'ci')
DEV = os.path.join(ROOT, 'build', 'dev')
KEYS = os.path.join(DEV, 'keys')
PRIVATE = os.path.join(KEYS, 'private.pem')
PUBLIC = os.path.join(KEYS, 'public.hex')
SERVE = os.path.join(DEV, 'serve')
EXTENSIONS = os.path.join(DEV, 'extensions')
# The directories of build/dev/serve/ that urls.toml's hosts are served from.
HOSTS = {'AIRFROG_IMAGES': 'images/', 'AIRFROG_EXTENSIONS': 'extensions/'}
HOST = re.compile(r'[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?')
OPENSSL = ("ci/dev.py requires OpenSSL 3 or later as openssl, for Ed25519. macOS's openssl is LibreSSL, which "
           "doesn't have it. Install OpenSSL, for example with Homebrew's brew install openssl@3, and put its bin "
           'directory first in PATH.')


def run(command, failed, env=None):
    """Runs command, failing with the message failed."""
    if subprocess.run(command, env={**os.environ, **(env or {})}).returncode != 0:
        fail(failed)


def openssl(*args):
    try:
        return subprocess.run(['openssl', *args], capture_output=True)
    except FileNotFoundError:
        fail(OPENSSL)


def check_openssl():
    if openssl('genpkey', '-algorithm', 'ed25519').returncode != 0:
        fail(OPENSSL)


def keys():
    check_openssl()
    if os.path.exists(KEYS):
        fail('%s exists. Delete it to make another developer key. The next firmware of an Airfrog built with the '
             'old key is then installed over serial or the recovery button access point.' % KEYS)
    os.makedirs(DEV, exist_ok=True)
    work = tempfile.mkdtemp(prefix='keys-', dir=DEV)
    try:
        private = os.path.join(work, 'private.pem')
        r = openssl('genpkey', '-algorithm', 'ed25519', '-out', private)
        if r.returncode != 0:
            fail("openssl didn't make the key: %s" % r.stderr.decode(errors='replace').strip())
        os.chmod(private, 0o600)
        r = openssl('pkey', '-in', private, '-pubout', '-outform', 'DER')
        if r.returncode != 0:
            fail("openssl didn't read the key: %s" % r.stderr.decode(errors='replace').strip())
        with open(os.path.join(work, 'public.hex'), 'w') as f:
            f.write(r.stdout[-32:].hex() + '\n')
        os.replace(work, KEYS)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print('Developer key %s' % developer_key().hex())


@functools.cache
def developer_key():
    """The developer key's public half."""
    if not os.path.exists(PRIVATE) or not os.path.exists(PUBLIC):
        fail("%s doesn't have a developer key. Make it with ci/dev.py keys." % KEYS)
    try:
        key = bytes.fromhex(read(PUBLIC).decode().strip())
    except ValueError:
        key = b''
    if len(key) != 32:
        fail("%s isn't a public key in hex. Delete %s and make the key again with ci/dev.py keys." % (PUBLIC, KEYS))
    return key


def ed_sign(path):
    r = openssl('pkeyutl', '-sign', '-rawin', '-inkey', PRIVATE, '-in', path)
    if r.returncode != 0 or len(r.stdout) != 64:
        fail("%s didn't sign: %s" % (PRIVATE, r.stderr.decode(errors='replace').strip()))
    return r.stdout


class DeveloperSigner(signing.Signer):
    """signing.Signer, signing with the developer key in place of the
    signing server."""

    def __init__(self, url=None, cacert=None):
        self.key = developer_key()
        self.pin = None

    def public_key(self):
        return self.key

    def sign(self, endpoint, body, content_type):
        with tempfile.NamedTemporaryFile() as f:
            f.write(body)
            f.flush()
            signature = b'Ed' + self.key[:8] + ed_sign(f.name)
        trusted = 'timestamp:%d\tfile:%s' % (time.time(), endpoint.removeprefix('sign-'))
        with tempfile.NamedTemporaryFile() as f:
            f.write(signature[10:] + trusted.encode())
            f.flush()
            global_signature = ed_sign(f.name)
        text = ('untrusted comment: signature from the Airfrog developer key\n%s\ntrusted comment: %s\n%s\n'
                % (base64.b64encode(signature).decode(), trusted, base64.b64encode(global_signature).decode()))
        if signing.minisig_signature(self.key, text, body) != signature:
            fail("The developer key's signature doesn't verify. %s and %s aren't one key pair." % (PRIVATE, PUBLIC))
        return signature, text.encode()


def use_developer(base, manifest):
    """Points the release scripts' code at the developer key and the local
    server. It signs with the developer key, which is then the only release
    key, manifest is the Airfrog manifest's address, and the hosts of HOSTS
    are under base."""
    table = urls.entries()
    for name, directory in HOSTS.items():
        table[name] = {**table[name], 'url': base + directory}
    urls.entries = lambda: table
    signing.release_keys = lambda: ([developer_key().hex()], manifest)
    signing.Signer = DeveloperSigner


def release_script(name, *args):
    """Runs release script name's main with args."""
    argv = sys.argv
    sys.argv = [name, *args]
    try:
        runpy.run_path(os.path.join(CI, name), run_name='__main__')
    finally:
        sys.argv = argv


def server_address(host, port):
    """The server's address, http://HOST:PORT/."""
    if not 1 <= port <= 65535:
        fail("--port %d isn't a port, 1 to 65535." % port)
    if not HOST.fullmatch(host):
        fail("--host %s isn't a host name or IPv4 address." % host)
    return 'http://%s:%d/' % (host, port)


def website(address):
    """The website of an extension UI's address, in the authorised websites'
    form: scheme://host, with :port unless it is the scheme's default."""
    u = urllib.parse.urlsplit(address)
    try:
        port = u.port
    except ValueError:
        port = -1
    if u.scheme not in ('http', 'https') or not u.hostname or port == -1 or u.username is not None \
            or u.password is not None or ':' in u.hostname:
        fail("--full-access %s isn't an http:// or https:// address with a host name or IPv4 address, an optional "
             'port and no user name.' % address)
    default = {'http': 80, 'https': 443}[u.scheme]
    return '%s://%s%s' % (u.scheme, u.hostname, '' if port in (None, default) else ':%d' % port)


def repository(path, default):
    """The extension repository at path, made with an empty list when it is
    the default and doesn't exist. Fails unless it is a repository."""
    listed = os.path.join(path, 'manifest.json')
    if default and not os.path.exists(path):
        os.makedirs(path)
        with open(listed, 'w') as f:
            json.dump({'type': 'extensions', 'version': signing.MANIFEST_VERSION, 'extensions': {}}, f, indent=2)
    try:
        manifest = json.loads(read(listed))
    except (OSError, ValueError):
        manifest = None
    if not isinstance(manifest, dict) or manifest.get('type') != 'extensions':
        fail("%s isn't an extension repository: it doesn't have airfrog-ext's signed list, manifest.json." % path)
    return path


def firmware(v2, images, manifest):
    """Publishes each released model's firmware built in v2 with the
    developer key and manifest, with airfrog-v2's ci/release-app.sh, and
    lists it. Fails when there is none."""
    key = developer_key()
    served = []
    for name, model in releases.AIRFROG_FIRMWARE.items():
        build = os.path.join(v2, 'build', 'airfrog', model, 'release')
        app = os.path.join(build, name + '.bin')
        if not os.path.exists(app):
            continue
        data = read(app)
        if key not in data or manifest.encode() not in data:
            print("Skipped %s: %s wasn't built with AIRFROG_MANIFEST %s and the developer key"
                  % (name, app, manifest), file=sys.stderr)
            continue
        split = read_signed_file(data, 'firmware')
        if split is None or split[1] is not None:
            fail("%s isn't an unsigned ESP-IDF image." % app)
        with tempfile.TemporaryDirectory() as d:
            signed = os.path.join(d, name + '.bin')
            with open(signed, 'wb') as f:
                f.write(DeveloperSigner().sign_image(data, 'firmware'))
            run(['bash', os.path.join(v2, 'ci', 'release-app.sh'), ROOT, images, model, signed],
                "airfrog-v2's ci/release-app.sh failed for %s. Build it with airfrog-v2's ci/build.sh %s, which "
                'builds the factory app too.' % (name, model))
        version = json.loads(read(os.path.join(build, name + '.factory', 'commission.json')))['version']
        release_script('release-firmware.py', '--images', images, '--signer', 'developer',
                       '--firmware', name, '--version', version)
        release_script('promote-firmware.py', '--images', images, '--signer', 'developer',
                       '--firmware', name, '--version', version)
        served.append(name)
    if not served:
        fail("%s doesn't have firmware built with AIRFROG_MANIFEST %s and the developer key. Build it with its "
             'ci/build.sh.' % (v2, manifest))


class Handler(http.server.SimpleHTTPRequestHandler):
    """Serves build/dev/serve/ to Airfrog's pages on another address."""

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Headers', '*')
        self.end_headers()


def build(args, base, extensions):
    """Builds and signs everything served."""
    manifest = base + 'manifest.json'
    key = developer_key()
    full_access = [website(a) for a in args.full_access]
    run([os.path.join(CI, 'build-ui.sh')], 'ci/build-ui.sh failed.',
        {'AIRFROG_MANIFEST': manifest, 'AIRFROG_KEYS': key.hex()})
    use_developer(base, manifest)
    shutil.rmtree(SERVE, ignore_errors=True)
    images = os.path.join(SERVE, HOSTS['AIRFROG_IMAGES'].rstrip('/'))
    os.makedirs(images)
    release_script('release-ui.py', '--images', images, '--signer', 'developer')
    run([os.path.join(CI, 'release-js.sh'), images], 'ci/release-js.sh failed.')
    firmware(args.airfrog_v2, images, manifest)
    for kind in ('support-firmware', 'cli'):
        releases.write_manifest(images, releases.load_manifest(images, kind), 'developer', None)
    served = os.path.join(SERVE, HOSTS['AIRFROG_EXTENSIONS'].rstrip('/'))
    shutil.copytree(extensions, served, ignore=shutil.ignore_patterns('.git'))
    releases.sign_extensions(served, DeveloperSigner(), https_ui=False)
    websites = releases.released_full_access()
    websites += [w for w in full_access if w not in websites]
    DeveloperSigner().sign_manifest(releases.airfrog_manifest(key.hex(), websites),
                                    os.path.join(SERVE, 'manifest.json'))


def serve(args):
    check_openssl()
    base = server_address(args.host, args.port)
    developer_key()
    for address in args.full_access:
        website(address)
    extensions = repository(args.extensions or EXTENSIONS, args.extensions is None)
    try:
        server = http.server.ThreadingHTTPServer((args.host, args.port), functools.partial(Handler, directory=SERVE))
    except OSError as e:
        fail("Can't serve at %s: %s." % (base, e.strerror or e))
    with server:
        build(args, base, extensions)
        print('Serving %s. AIRFROG_MANIFEST=%smanifest.json AIRFROG_KEYS=%s'
              % (SERVE, base, developer_key().hex()), flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    commands = p.add_subparsers(dest='command', required=True)
    commands.add_parser('keys')
    s = commands.add_parser('serve')
    s.add_argument('--host', required=True)
    s.add_argument('--port', required=True, type=int)
    s.add_argument('--full-access', action='append', default=[], metavar='URL')
    s.add_argument('--airfrog-v2', default=os.path.join(os.path.dirname(ROOT), 'airfrog-v2'), metavar='DIR')
    s.add_argument('--extensions', metavar='DIR')
    args = p.parse_args()
    if args.command == 'keys':
        keys()
    else:
        serve(args)


if __name__ == '__main__':
    main()
