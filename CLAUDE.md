# airfrog.org

Airfrog's website, served by GitHub Pages. `index.html` is the front page
and `site.css` the stylesheet of every page. `header.html` and `footer.html`
are the header and footer every page loads.

| Directory | Contents |
|---|---|
| `commissioning/` | airfrog.org/commissioning |
| `cli/` | airfrog.org/cli |
| `web/` | airfrog.org/web |
| `commissioning/vendor/` | esptool-js bundled into one ES module, which isn't committed, and its licences |
| `ui/` | Source of the Airfrog full user interface |
| `ui/images/` | Renders of each released model's Airfrog board, written by `ci/render-boards.py` |
| `js/` | The client library |
| `js/setup/` | The Airfrog internal JS setup module, which the Airfrog firmware serves at `/setup.js` |
| `js/site/` | `header.js` and `footer.js`, which load `header.html` and `footer.html` into every airfrog.org page |
| `images/` | Airfrog's logo, favicon and the pictures on airfrog.org. `ci/render-quarter.py` renders `airfrog-quarter.png` |
| `tests/commissioning/` | Tests of airfrog.org/commissioning, and `provision.mjs` |
| `tests/js/` | Tests of `js/` and `cli/` |
| `tests/ui/` | Tests of the Airfrog full user interface |
| `ci/` | Pinned tool versions and the scripts that use them |
| `.github/workflows/` | `pages.yml`, which publishes the site |
| `build/` | Downloads and scratch files, not committed |

## Publishing

`.github/workflows/pages.yml` publishes the site to GitHub Pages on each push
to `main`. It runs these, then copies the repository into one directory
without the patterns in its `DENY` variable and deploys that directory:

- `ci/urls.py write`
- `ci/schema.py write site`
- `ci/tool-css.mjs`
- `ci/vendor-esptool.sh`

Every file the patterns don't match is served, so a file that isn't meant to be public
belongs in `DENY`. `ci/check-pages.mjs` fails the workflow when a published
page or script refers to a local file that isn't published.

## Addresses

`urls.toml` defines every address on airfrog.org and images.airfrog.org that
Airfrog's code uses. `ci/urls.py` reads it at build time:
- `ci/urls.py write` writes `js/urls.js`, which the JavaScript imports.
  `ci/build-setup.sh` and `ci/build-ui.sh` run it.
- `ci/urls.py url NAME` and `path NAME` print an entry's address, and the
  release scripts import the same functions.
- `ci/urls.py check DIR` fails when a file outside the table contains a full
  airfrog.org or images.airfrog.org address. Tests, `.md` files and the
  table's own files aren't checked. `tests/js/run.sh` checks this site and
  airfrog-v2's `ci/test.sh` checks airfrog-v2.

## Schema

`schema.toml` defines the Airfrog WebSocket Protocol's constants and layouts,
every text in `js/messages.js`, Airfrog's project name, the MCUs Airfrog's
rules identify, the ESP32s Airfrog is built on and Airfrog's models. It is
here so this site's builds read it without airfrog-v2. airfrog-v2's tests
and firmware build read it from this site. `ci/schema.py` generates from it:
- `ci/schema.py write site` writes `js/schema.js` and `js/messages.js`.
  `ci/build-setup.sh`, `ci/build-ui.sh` and `ci/release-js.sh` run it.
- `ci/schema.py write v2 DIR` writes airfrog-v2's public C header
  `airfrog_awp.h`, the firmware image's C header `airfrog_image.h`,
  `airfrog-ext-api`'s and `airfrog-client`'s Rust,
  `picoboot-airfrog`'s error texts, the signing server's manifest version and keys,
  its scripts' and tests' Python, the firmware's CMake project name and the texts
  of the Airfrog home page.
- `ci/schema.py check site` and `check v2 DIR` fail when a generated file
  differs from the schema. `check v2 DIR` also fails when
  `docs/websocket-protocol.md`'s tables differ from it. `tests/js/run.sh` checks this site and
  airfrog-v2's `ci/test.sh` checks airfrog-v2.
- `ci/schema.py check names PATH...` fails when a file contains the name of
  a model that isn't released after "airfrog" and a hyphen, underscore or
  space. `tests/js/run.sh`, `ci/test-ui.sh`,
  airfrog-v2's `ci/test.sh` and the release scripts run it.
- `ci/schema.py models` prints every model's key, and `model KEY`
  a model's details, which the firmware build reads.
- `ci/schema.py --test` adds the test models in `tests/fixtures/models.toml`.
  The tests use them for a model that isn't released and a name with a
  space.

`ci/urls.py`, `ci/schema.py` and the release scripts run on the Python pinned
in `ci/python-version`, which `ci/install-python.sh` installs into `build/`.

## Releases

Release files are published in images.airfrog.org's own repository, at the
paths `urls.toml` defines. Published files are never changed.

| Entry | Contents | Published by |
|---|---|---|
| `FIRMWARE_UPDATE_IMAGE` | A model's firmware alone, installed over WiFi | airfrog-v2's `ci/release.sh` |
| `FIRMWARE_FACTORY_IMAGE` | A model's whole flash for a blank Airfrog in one file | airfrog-v2's `ci/release.sh` |
| `FIRMWARE_FACTORY_FILES` | The same flash as separate files with `commission.json` | airfrog-v2's `ci/release.sh` |
| `SETUP_MODULE` | The Airfrog internal JS setup module that release's firmware serves | airfrog-v2's `ci/release.sh` |
| `ONEROM_RECOVERY_FIRMWARE` | One ROM's recovery firmware | airfrog-v2's `ci/release.sh` |
| `ONEROM_SERIAL_RECOVERY_FIRMWARE` | One ROM's serial recovery firmware | airfrog-v2's `ci/release.sh` |
| `PICO_SERIAL_ADAPTER_FIRMWARE` | The Pico's serial adapter firmware | airfrog-v2's `ci/release.sh` |
| `FIRMWARE_MANIFEST` | The signed firmware manifest, which lists Airfrog's firmware | `ci/release-firmware.py` and `ci/promote-firmware.py` |
| `SUPPORT_FIRMWARE_MANIFEST` | The signed support firmware manifest, which lists firmware that runs on devices other than Airfrog | `ci/release-firmware.py` and `ci/promote-firmware.py` |
| `CLI_MANIFEST` | The signed CLI manifest | `ci/release-cli.py` and `ci/promote-cli.py` |
| `FULL_UI` | The Airfrog full user interface, listed by the UI manifest | `ci/release-ui.py` |
| `UI_MANIFEST` | The signed UI manifest | `ci/release-ui.py` |
| `CLIENT_LIBRARY` | The client library, version from `js/js-version` | `ci/release-js.sh` |

Each firmware has its own releases. A release of one firmware is published
with `ci/release.sh`, then added to its manifest with
`ci/release-firmware.py`. `ci/promote-firmware.py` makes a listed release the
latest of its firmware. `ci/release-ui.py`
publishes the full user interface and writes the UI manifest.
`ci/release-airfrog.py` writes the Airfrog manifest, which contains:

- the address and key of each other manifest
- the address of the client library's published versions
- `full_access_websites`, the websites whose extension UIs have every request
  forwarded by the Airfrog full user interface

The Airfrog home page fetches it from `AIRFROG_MANIFEST` in
`commissioning/release-keys.js`, the address built into the firmware. Client
library versions are independent of firmware releases.

```json
{
  "type": "airfrog",
  "version": 1,
  "ui_manifest": { "url": "https://images.airfrog.org/ui/manifest.json", "key": "<64 hex digits>" },
  "firmware_manifest": { "url": "https://images.airfrog.org/firmware/manifest.json", "key": "<64 hex digits>" },
  "support_firmware_manifest": { "url": "https://images.airfrog.org/support-firmware/manifest.json", "key": "<64 hex digits>" },
  "cli_manifest": { "url": "https://images.airfrog.org/cli/manifest.json", "key": "<64 hex digits>" },
  "extensions_manifest": { "url": "https://extensions.airfrog.org/manifest.json", "key": "<64 hex digits>" },
  "js_library": "https://images.airfrog.org/js/",
  "full_access_websites": ["https://airfrog.org"]
}
```

A manifest whose entry has a `key` is signed with that key. One without is
read only from an https address and isn't checked further.

The `airfrog` CLI's release files are on GitHub, at `CLI_RELEASE_FILE`.
`ci/release-cli.py` adds a release to the CLI manifest and `ci/promote-cli.py`
makes a listed release the latest of each architecture.

Each manifest is signed with the release key, as `manifest.json.minisig`
beside it. `commissioning/release-keys.js` contains:

- `RELEASE_KEYS`, the release keys' public halves in hex, the release key first
- `AIRFROG_MANIFEST`, the Airfrog manifest's address

These verify the Airfrog manifest with any of the keys:

- the Airfrog full user interface
- airfrog.org/commissioning
- airfrog.org/cli

`ci/schema.py` writes the keys into the firmware and the `airfrog` CLI. The
release scripts fail when the signing
server's key isn't one of them. `ci/release-ui.py` also fails when
`build/ui/ui.js`'s keys and address aren't exactly these.

`ci/build-ui.sh` reads the environment variables `AIRFROG_MANIFEST` and
`AIRFROG_KEYS` (hex keys separated by commas) in place of
`commissioning/release-keys.js`'s, and fails when two keys have the same key
ID, their first 8 bytes.

Firmware and extension images are published as signed files. A signed file
is:

- the image
- 0 to 3 zero bytes to a 4-byte boundary
- `AFSG`
- the image's 74-byte minisign legacy Ed25519 signature

The firmware and extensions manifests list each
signed file's size and SHA-256. A firmware image's end is found from its
segment headers and an extension image's from its `AFXI` header.
`ci/release-firmware.py` fails when `FIRMWARE_UPDATE_IMAGE` isn't signed with
a release key. `ci/release-extensions.py` signs each unsigned extension image
in the Airfrog Extension Repository before signing its list.

`ci/signing.py` signs one image through the signing server and writes its
signed file. airfrog-v2's `ci/release.sh` uses it for firmware:

```bash
"$(ci/install-python.sh)/python3" ci/signing.py sign-firmware IMAGE --out FILE --signer URL
```

`sign-extension` signs an extension image.

`ci/releases.py` contains the code that writes the Airfrog manifest
and signs the extension images and their list, which the release scripts and
`ci/dev.py` use.

`commission.json` lists a model's factory files with their flash offsets,
for `ci/release-firmware.py` and `ci/test-esp-rom.sh` in airfrog-v2.

```json
{
  "version": "0.2.0",
  "commit": "1a2b3c4d",
  "model": "mini",
  "flash_size": 4194304,
  "files": [
    {"offset": 0, "file": "bootloader.bin", "size": 20000, "sha256": "<64 lowercase hex digits>"}
  ]
}
```

## airfrog.org/commissioning

The commissioning tool below the page's text writes Airfrog's firmware with
esptool-js over Web Serial, then sends Airfrog's settings over serial as `@af `
lines with the Airfrog internal JS setup module from the release Airfrog runs.
`ci/tool-css.mjs` writes the tool's stylesheet, `commissioning/tool.css`, from
the setup module's stylesheet. "Over serial" in
`airfrog-v2/docs/websocket-protocol.md` defines the messages.

`commissioning/vendor/esptool.js` isn't committed. It is built from the
pinned npm packages by:

```bash
ci/vendor-esptool.sh
```

The versions of esptool-js, pako, atob-lite, esbuild and Node.js are in
`ci/<name>-version`. The script installs the pinned Node.js into `build/`.

## Developer builds

airfrog-v2's `DEVELOPING.md` is the guide to building your own Airfrog
software and testing it on an Airfrog.

`ci/dev.py keys` makes a developer key in `build/dev/keys/`. `ci/dev.py
serve` serves these, signed with the developer key:

- the manifests
- the firmware
- the Airfrog UI
- the extensions

## Testing

```bash
ci/test-commissioning.sh
```

runs airfrog.org/commissioning's tests with the pinned Node.js and the test
models (`ci/schema.py --test`). Web Serial and an adapter aren't tested.
`tests/js/chrome/models.test.mjs` runs the page in headless Chrome with a fake serial port and a fake esptool-js, after `ci/test-commissioning.sh` has
written the test models:

```bash
node tests/js/chrome/models.test.mjs
```

The Airfrog internal JS setup module over serial is tested by
`tests/js/chrome/setup-serial.test.mjs`.

`tests/js/chrome/interfaces.test.mjs` tests what each interface allows in the
Airfrog setup and the Airfrog full user interface, in headless Chrome against
a stand-in Airfrog. Run `ci/test-deps.sh` first.

`tests/js/chrome/phone-speed.test.mjs` runs these with the CPU throttled until
PBKDF2 takes longer than Airfrog's 5 s login limit:

- first setup
- the password reset
- the login

It runs against the stand-in Airfrog, or with `QEMU=ADDRESS:PORT` against
Airfrog in QEMU.

`tests/signing_test.py` tests `ci/signing.py` and the release scripts' signing
against a stand-in signing server, and `tests/dev_test.py` tests `ci/dev.py`.
`tests/js/run.sh` runs both. The signing tests' Ed25519 keys are made once in
`build/test-keys/`.

airfrog.org/web is tested in headless Chrome, with a stand-in Airfrog, by:

```bash
node tests/js/chrome/web.test.mjs
```

`tests/js/chrome/bridge-qemu.test.mjs` runs in headless Chrome against Airfrog
in QEMU (airfrog-v2's `ci/qemu.sh --serve`). `AIRFROG_V2` is the airfrog-v2
checkout:

```bash
AIRFROG_V2=../airfrog-v2 node tests/js/chrome/bridge-qemu.test.mjs ADDRESS:PORT
```

`tests/js/chrome/qemu-security.test.mjs` runs the Airfrog setup and the Airfrog
full user interface over each interface against Mini in QEMU
(`ci/qemu.sh --serve mini`) with the QEMU build's test keys. Run
`ci/build-setup.sh` and `ci/build-ui.sh` first. Its header lists its ports and
options:

```bash
AIRFROG_V2=../airfrog-v2 node tests/js/chrome/qemu-security.test.mjs 127.0.0.1:18080
```

`tests/commissioning/provision.mjs` sends settings over TCP to Airfrog's serial
UART, for example QEMU's serial port, with the serial client of the Airfrog
internal JS setup module:

```bash
node tests/commissioning/provision.mjs localhost 5555 --ssid NETWORK --wifi-password PASSWORD
```

`--help` lists its options.
