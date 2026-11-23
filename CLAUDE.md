# airfrog.org

Airfrog's website, served by GitHub Pages. `index.html` is the front page
and `site.css` the stylesheet of every page. `header.html` and `footer.html`
are the header and footer every page loads.

| Directory | Contents |
|---|---|
| `commissioning/` | airfrog.org/commissioning |
| `cli/` | airfrog.org/cli |
| `web/` | airfrog.org/web |
| `commissioning/vendor/` | esptool-js bundled into one ES module, and its licences |
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
to `main`. It runs `ci/urls.py write`, `ci/schema.py write site` and
`ci/tool-css.mjs`, copies the repository into one directory without the
patterns in its `DENY` variable and deploys that directory. Every file the
patterns don't match is served, so a file that isn't meant to be public
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
`airfrog-v2/docs/ac3-design.md` section 3 specifies the manifests.

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
`ci/release-airfrog.py` writes the Airfrog manifest, which contains the
addresses of the other manifests and of the client
library's published versions. The Airfrog home page fetches
it from `https://meta.piers.rocks/airfrog/manifest.json`, the address built into
the firmware. Client library versions
are independent of firmware releases.

The `airfrog` CLI's release files are on GitHub, at `CLI_RELEASE_FILE`.
`ci/release-cli.py` adds a release to the CLI manifest and `ci/promote-cli.py`
makes a listed release the latest of each architecture.

Each manifest is signed with the manifest key, as `manifest.json.minisig`
beside it. `commissioning/manifest-key.js` contains the key's public half,
which verifies the manifests the Airfrog full user interface,
airfrog.org/commissioning and airfrog.org/cli read, and the Airfrog manifest's address. The
release scripts fail when the signing server's key differs. `ci/release-ui.py`
also fails when `build/ui/ui.js` doesn't contain the key.

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
the setup module's stylesheet. See section 2 of
`airfrog-v2/docs/ac3-design.md` and "Over serial" in
`airfrog-v2/docs/websocket-protocol.md`.

`commissioning/vendor/esptool.js` is built from the pinned npm packages by:

```bash
ci/vendor-esptool.sh
```

The versions of esptool-js, pako, atob-lite, esbuild and Node.js are in
`ci/<name>-version`. The script installs the pinned Node.js into `build/`.

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

`tests/commissioning/provision.mjs` sends settings over TCP to Airfrog's serial
UART, for example QEMU's serial port, with the serial client of the Airfrog
internal JS setup module:

```bash
node tests/commissioning/provision.mjs localhost 5555 --ssid NETWORK --wifi-password PASSWORD
```

`--help` lists its options.
