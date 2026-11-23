# Client library

ES modules for web pages that use an Airfrog: the JavaScript version of
the Rust crate `airfrog-client`. They use the Airfrog
WebSocket Protocol (AWP, `airfrog-v2/docs/websocket-protocol.md`).

| File | Contents |
|---|---|
| `airfrog.js` | The AWP client |
| `bridge.js` | The bridge window, for another site's page |
| `awp.js` | Framing, login and errors, which the others import |
| `messages.js` | Every text the pages display, generated from `schema.toml` by `ci/schema.py` |
| `target-state.js` | The target's state and MCU for display |
| `schema.js` | AWP's constants and each layout's encoder and decoder, generated from `schema.toml` by `ci/schema.py` |
| `urls.js` | Airfrog's addresses, generated from `urls.toml` by `ci/urls.py` |
| `sha256.js` | SHA-256, HMAC-SHA256 and PBKDF2-HMAC-SHA256 |

`airfrog.js` is the client's API. The modules it imports, `schema.js`
included, are its internals.

Each version is published at `CLIENT_LIBRARY` (`urls.toml`), on
images.airfrog.org, by `ci/release-js.sh`, with the version in
`js/js-version`. The versions are
independent of firmware releases. `setup/` isn't part of it.

## Connecting

Airfrog accepts a WebSocket only from a page it served. `Airfrog.connect()`
is for the Airfrog home page. Every other site uses `Airfrog.connectBridge()`,
which opens the bridge window, the Airfrog home page in a window, from a click.
That window logs in, so
the password doesn't reach the site, and relays messages. A site connects
once it is in the Airfrog's authorised websites. An extension UI, in a frame of the
Airfrog UI, uses `Airfrog.connectExtension()`.

```javascript
import { Airfrog, Service } from './airfrog.js';

button.onclick = async () => {
    const airfrog = await Airfrog.connectBridge('airfrog.local');
    airfrog.addEventListener('close', (event) => show(event.detail.message));
    await airfrog.resetBoot();
    await airfrog.waitForTarget(5000, t => t.offers(Service.PICOBOOT_RP2350_SWD));
};
```

## airfrog.js

**`Airfrog.connect(host, password?)`**
- Opens a WebSocket to Airfrog, logs in when Airfrog has a password and reads
  the first TARGET. `host` is Airfrog's hostname, its hostname with `.local`
  or its IP address, with `:port` when it isn't 80.
- Returns: `Promise<Airfrog>`

**`Airfrog.connectBridge(host)`**
- Opens the bridge window, which logs in and relays. Call it from
  a click. Resolves once the user has logged in there, and rejects with
  `CLOSED` when the user closes that window first.
- Returns: `Promise<Airfrog>`

**`Airfrog.connectExtension()`**
- For an extension UI. The Airfrog UI that contains its frame logs in and
  forwards CLAIM, RELEASE, TARGET_CMD, IDENTIFY, AIRFROG_CMD get commands and
  EXT_CMD to its own extension. Other AIRFROG_CMD commands fail with
  `NOT_PERMITTED` without being sent. An extension UI from airfrog.org isn't
  limited. Rejects with `CONNECT` in a page that isn't inside the Airfrog UI.
  `getHost()` returns `null`. From the connection's opening, and after it
  closes, the page's height is posted to the Airfrog UI, which makes the frame
  that high.
- Returns: `Promise<Airfrog>`

An `Airfrog` is an `EventTarget`:
- `target`: Airfrog sent TARGET. `event.detail` is the `TargetInfo`.
- `close`: the connection closed. `event.detail` is the `AirfrogError` that
  closed it, for example the user pressing Disconnect in the bridge window.

Requests are sent one at a time, in the order they are made.

| Method | Returns |
|---|---|
| `getHost()` | The host the connection was opened with |
| `getRevision()` | HELLO's AWP revision |
| `getMaxTransfer()` | HELLO's max_transfer |
| `getTarget()` | The last TARGET, a `TargetInfo` |
| `isClosed()` | Whether the connection is closed |
| `close()` | Closes the connection, and the bridge window through the bridge |
| `waitForTarget(timeoutMs, condition)` | The first TARGET, the last one included, for which `condition(target)` is true, or `null` on timeout |
| `claim(timeoutMs)` | Adds a claim. The first sends CLAIM |
| `release()` | Ends a claim. The last sends RELEASE without waiting |
| `targetCmd(service, operation, fields, timeoutMs)` | TARGET_CMD's response fields |
| `airfrogCmd(command, fields, timeoutMs)` | AIRFROG_CMD's response fields |
| `resetBoot()` | Resets the target into its bootloader with RESET_BOOT |
| `resetPins(pins)` | Resets the target with RESET_PINS |
| `identify(flags, firmware)` | IDENTIFY's result for each firmware ID |
| `setPassword(password)` | Sets, changes or removes Airfrog's password |
| `getExtensions()` | GET_EXTENSIONS's entries: `[{ name, flags, wasmState, wasmReason, model, wamr }]`, `wamr` as `'2.4.5'` |
| `installExtension(image, flags)` | Installs or updates an extension image with EXT_BEGIN, EXT_WRITE and EXT_FINISH |
| `removeExtension(name)` | Removes an extension with EXT_REMOVE |
| `setExtensions(entries)` | Sets the list order and Tab checkboxes with SET_EXTENSIONS. `entries` is `[{ name, flags }]`, with `SetExtensionFlag`'s flags |
| `getExtensionMetadata(name)` | The extension metadata, parsed. Metadata that isn't JSON fails with `INVALID_MESSAGE` and the connection stays open |
| `extension(name)` | The `Extension` for that extension's WASM module, the same one for each call. In an extension UI `name` defaults to its own extension |

- `fields` are `Uint8Array`s.
- `resetPins`'s `pins` is `{ resetPin, resetLevel, resetMs, bootPin,
  bootLevel, bootDelayMs, bootHoldMs }`. A pin is a connector name, for
  example `J1-4`, or a name in the active pin map. `bootPin` is `null` for a
  reset without a boot pin.
- `resetBoot()`, `resetPins()` and `identify()` claim the target for the
  request.
- Where the connection holds a claim and Airfrog has ended it, `targetCmd()`
  sends CLAIM and the command again, once.
- `setPassword()` sends Airfrog K, derived from the password with a random
  salt and HELLO's iterations, so the password doesn't leave the page. An
  empty password removes it. Airfrog then closes every connection with
  `PASSWORD_CHANGED`.

An `Extension` is an `EventTarget`:
- `command(data, timeoutMs)` sends EXT_CMD with `data`, a `Uint8Array` of
  0 to 4,096 bytes, and resolves to the module's reply.
- `notify`: the module sent EXT_NOTIFY. `event.detail` is its data, a
  `Uint8Array`.

`TargetInfo` has TARGET's fields `state`, `swd`, `targetid`, `firmware`,
`fwFlags` and `services` (`[{ service, operation }]`), and the methods
`identified()`, `running()`, `offers(service)` and
`supports(service, operation)`.

`Service`, `Operation`, `Firmware`, `IdentifyFlag`, `IdentifyResult`,
`PinLevel`, `ExtensionFlag`, `SetExtensionFlag`, `WasmState` and `WasmReason`
are AWP's IDs. An operation's name in `Operation` is its service's name and
then its own, for example `RESET_RESET_BOOT`.

`AirfrogError`'s `code` is one of `CONNECT`, `IO`, `TIMEOUT`,
`PASSWORD_REQUIRED`, `LOGIN_FAILED`, `LOGIN_BLOCKED`, `PROOF_MISMATCH`,
`PASSWORD_CHANGED`, `PROTOCOL_ERROR`, `BAD_COUNTER_OR_HMAC`,
`TOO_MANY_CONNECTIONS`, `LOGIN_TIMEOUT`, `NETWORK_SETTINGS_CHANGED`,
`CLOSED`, `INVALID_MESSAGE`, `BUSY`, `NOT_CLAIMED`, `NOT_OFFERED`,
`TRANSFER_FAILED`, `NOT_RUNNING`, `MEMORY_FAULT`, `OUT_OF_RANGE`,
`INSTALL_IN_PROGRESS`, `EXTENSION_INVALID`, `EXTENSION_UNSUPPORTED`,
`NO_SPACE`, `IMAGE_INVALID`, `RESTARTING`, `CODE`, `PIN_NAME`,
`TRANSFER_TOO_LARGE` and `NOT_PERMITTED`. Its `message` is for the person using the page. Its
`detail` is BUSY's extension name (empty when a client holds the claim),
LOGIN_BLOCKED's seconds, CLOSED's close
code, CODE's error code, PIN_NAME's pin, TRANSFER_TOO_LARGE's length,
NOT_PERMITTED's request, the extension name for an EXT_CMD's NOT_OFFERED,
NOT_RUNNING and OUT_OF_RANGE, and
INVALID_MESSAGE's, CONNECT's and IO's technical reason, and `null`
otherwise. `awp.js` lists each code.

## bridge.js

**`startBridge(container)`** runs the bridge window when the URL of the
Airfrog home page has `#bridge=ORIGIN`. `container` is where it displays its
state, the login and its buttons. The window connects a website in the
Airfrog's authorised websites, and displays Allow and Cancel for any other. Without a website's
origin in the hash the window loads the Airfrog home page. The window's states
are in "The bridge" in `airfrog-v2/docs/ac3-design.md`.

When the Airfrog full user interface doesn't load in the bridge window, the
home page posts a close with the reason to the opener.

The window posts only to that origin and accepts messages only from
`window.opener` with that origin. Each message is
`{ airfrogBridge: { type, flags, payload } }`, an AWP message type, the
header's flags and the payload, without counter and hmac. The page's messages
don't contain flags. Once the website is connected the window posts
HELLO and every message from Airfrog, other than the responses to its own
commands. The page may send CLAIM, RELEASE, TARGET_CMD,
IDENTIFY and AIRFROG_CMD get commands. Anything else ends the connection.
Either side ends the connection with `{ airfrogBridge: { close } }`: from the
page `close` is `{ closeCode }`, and from the window `{ code, detail,
message }`, the `AirfrogError`, with the window's reason as its message.

## messages.js

Every text the pages display, which pages refer to (the style guide's "One
source"). Among them are `ERRORS`, each `AirfrogError` code's text, the texts
for closes and reconnecting, `FIRMWARE`, each supported firmware's name,
`targetState()`, the target's state as "TARGET: STATE", and `SERVICES`, each
service's name, operations and description. `AirfrogError`'s message is its
code's text from here. `ci/schema.py` generates `messages.js` from
`schema.toml`.

## setup/

The Airfrog internal JS setup module: its connection and login, its Network,
System and Advanced tabs and its target settings, with their codecs and
checks, and `releases.js`, which checks the firmware manifest.
`ci/build-setup.sh` bundles `setup/index.js` into `build/setup/setup.js`.
Airfrog's firmware serves that file at `/setup.js` (airfrog-v2's
`ci/vendor-setup.sh` copies it in), and each firmware release publishes it at
`SETUP_MODULE` (`urls.toml`).

- The Airfrog setup is its `localPage()`.
- The Airfrog full user interface imports the copy its Airfrog serves, and adds
  its Target tab and its engineering detail to its `Page`.
- airfrog.org/commissioning imports the copy of the release Airfrog runs and
  runs `mountSerial()` with a `SerialTransport` over Web Serial.

`API` is the module's interface version, which the Airfrog full user interface
checks.

## Tests

```bash
tests/js/run.sh
```

This tests the modules against a fake Airfrog, directly and through a fake
bridge, and `bridge.js` against a fake page.
`tests/js/chrome/bridge-qemu.test.mjs` programs QEMU Airfrog through the
bridge in headless Chrome. How to run it is in its header comment.

These run in headless Chrome against a fake Airfrog:

- `tests/js/chrome/setup-serial.test.mjs`: the Airfrog internal JS setup module,
  as bundled, over serial.
- `tests/js/chrome/setup-ap.test.mjs`: the Airfrog full user interface through
  AP mode after Airfrog joins its network.
- `tests/js/chrome/pages.test.mjs`: the Airfrog full user interface and
  the Airfrog setup, their tabs, messages and tooltips.
