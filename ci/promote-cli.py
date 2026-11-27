"""Change the latest Airfrog CLI release of one or more architectures and sign
the CLI manifest.

Has Airfrog's signing server sign the CLI manifest, checks the signature and
writes the CLI manifest and its signature file to urls.toml's CLI_MANIFEST.

Usage: python3 ci/promote-cli.py --images DIR --signer URL --version VERSION [--arch ARCH]...
       python3 ci/promote-cli.py --images DIR --signer URL --remove --arch ARCH...
  --images   the images.airfrog.org directory, for example ../images.airfrog.org
  --signer   the signing server, for example https://HOST:8444
  --cacert   a CA certificate for the signing server's TLS
  --version  the release, any listed one, for example 0.2.1. It becomes the
             latest of every architecture it was built for, or of each --arch
  --arch     a Rust target, for example x86_64-pc-windows-msvc. Can be repeated
  --remove   removes each --arch from the latest releases. Its releases remain
             listed

The signing server's key must be one of commissioning/release-keys.js's
release keys. The PIN is read from the terminal. Use the Python
ci/install-python.sh installs.
"""
import argparse

from releases import add_arguments, find_release, load_manifest, write_manifest
from signing import fail


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    add_arguments(p)
    action = p.add_mutually_exclusive_group(required=True)
    action.add_argument('--version')
    action.add_argument('--remove', action='store_true')
    p.add_argument('--arch', action='append', default=[])
    args = p.parse_args()

    manifest = load_manifest(args.images, 'cli')
    latest = manifest['latest']
    if args.remove:
        if not args.arch:
            fail('--remove requires --arch')
        for arch in args.arch:
            if arch not in latest:
                fail('%s doesn\'t have a latest release' % arch)
            del latest[arch]
        done = 'removed from the latest releases: %s' % ', '.join(args.arch)
    else:
        built = [platform['target'] for platform in find_release(manifest['releases'], args.version)['platforms']]
        for arch in args.arch:
            if arch not in built:
                fail('Release %s wasn\'t built for %s' % (args.version, arch))
        archs = args.arch or built
        latest.update({arch: args.version for arch in archs})
        done = 'release %s is the latest for %s' % (args.version, ', '.join(archs))
    key = write_manifest(args.images, manifest, args.signer, args.cacert)
    print('Airfrog CLI %s. CLI manifest signed by %s' % (done, key.hex()))


if __name__ == '__main__':
    main()
