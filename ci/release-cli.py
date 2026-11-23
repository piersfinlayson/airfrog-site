"""Add a release of the Airfrog CLI to the CLI manifest and sign it.

Reads the built files of release VERSION from a directory which contains
nothing else. A file's name contains the version and the platform, for
example airfrog-cli-0.2.0-windows-x86_64.zip, airfrog-cli-0.2.0-macos.zip and
airfrog-cli_0.2.0-1_arm64.deb. Each file's address in the CLI manifest is
CLI_RELEASE_FILE. The files aren't uploaded.

Adds the release in version order, highest first, has Airfrog's signing
server sign the CLI manifest, checks the signature and writes the CLI
manifest and its signature file to CLI_MANIFEST. The latest release of each
architecture isn't changed. ci/promote-cli.py changes it. urls.toml defines
the names in capitals.

Usage: python3 ci/release-cli.py --images DIR --signer URL --version VERSION --files DIR
  --images   the images.airfrog.org directory, for example ../images.airfrog.org
  --signer   the signing server, for example https://HOST:8444
  --cacert   a CA certificate for the signing server's TLS
  --version  the release, for example 0.2.1
  --files    the directory of built files

The signing key must be the one in commissioning/manifest-key.js. The PIN is
read from the terminal. Use the Python ci/install-python.sh installs.
"""
import argparse
import os
import re

from releases import SCHEMA, add_arguments, add_release, load_manifest, write_manifest
from signing import entry, fail
from urls import url

VERSION = re.compile(r'(?<![\d.])\d+\.\d+\.\d+(?![\d.]*\d)')
# The words of a file's name that identify each target.
TARGETS = {t['target']: t['files'] for t in SCHEMA.data['cli_targets']}


def target_of(name):
    """The target a file is built for."""
    for target, forms in TARGETS.items():
        for extension, *words in forms:
            if name.endswith(extension) and all(re.search(r'[-_]%s[-_.]' % w, name) for w in words):
                return target
    fail('%s doesn\'t identify a platform' % name)


def platforms(directory, version):
    """A release's platforms, from the files in directory."""
    out = {}
    for name in sorted(n for n in os.listdir(directory) if not n.startswith('.')):
        if VERSION.findall(name) != [version]:
            fail('%s isn\'t a file of release %s' % (name, version))
        target = target_of(name)
        if target in out:
            fail('%s and %s are both for %s' % (out[target]['url'].rsplit('/', 1)[1], name, target))
        out[target] = {'target': target, 'url': url('CLI_RELEASE_FILE', release=version, file=name),
                       **entry(open(os.path.join(directory, name), 'rb').read())}
    if not out:
        fail('%s is empty' % directory)
    return [out[target] for target in TARGETS if target in out]


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    add_arguments(p)
    p.add_argument('--version', required=True)
    p.add_argument('--files', required=True)
    args = p.parse_args()

    release = {'version': args.version, 'platforms': platforms(args.files, args.version)}
    manifest = load_manifest(args.images, 'cli')
    manifest['releases'] = add_release(manifest['releases'], release)
    key = write_manifest(args.images, manifest, args.signer, args.cacert)
    print('Airfrog CLI release %s added to the CLI manifest, signed by %s' % (args.version, key.hex()))


if __name__ == '__main__':
    main()
