"""Make a release of one firmware its latest and sign the manifest that lists
it.

NAME is the firmware's key in the firmware manifest or the support firmware
manifest, as ci/release-firmware.py describes it. VERSION is any listed
release of it, an older one included. Has Airfrog's signing server sign the
manifest, checks the signature and writes the manifest and its signature
file.

Usage: python3 ci/promote-firmware.py --images DIR --signer URL --firmware NAME --version VERSION
  --images    the images.airfrog.org directory, for example ../images.airfrog.org
  --signer    the signing server, for example https://HOST:8444
  --cacert    a CA certificate for the signing server's TLS
  --firmware  the firmware, for example airfrog-mini
  --version   the release, for example 0.2.1

The signing server's key must be one of commissioning/release-keys.js's
release keys. The PIN is read from the terminal. Use the Python
ci/install-python.sh installs.
"""
import argparse

from releases import add_arguments, find_release, firmware_type, load_manifest, write_manifest


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    add_arguments(p)
    p.add_argument('--firmware', required=True)
    p.add_argument('--version', required=True)
    args = p.parse_args()

    kind = firmware_type(args.firmware)
    manifest = load_manifest(args.images, kind)
    find_release(manifest['firmware'].get(args.firmware, []), args.version)
    manifest['latest'][args.firmware] = args.version
    key = write_manifest(args.images, manifest, args.signer, args.cacert)
    print('%s release %s is the latest in the %s manifest, signed by %s'
          % (args.firmware, args.version, kind, key.hex()))


if __name__ == '__main__':
    main()
