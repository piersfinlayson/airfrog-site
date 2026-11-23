# Airfrog page style guide

These rules cover every Airfrog page:
- the Airfrog home page, with the Airfrog internal JS setup module and the
  Airfrog full user interface
- the commissioning tool on airfrog.org/commissioning
- the bridge window

airfrog.org's other pages, and the text of airfrog.org/commissioning, follow
"airfrog.org pages" below.

The styles every page uses are defined in `js/setup/style.js`. `ui/src/style.js`
adds the styles used only by the Airfrog full user interface and the bridge
window. A page uses the classes in these files. It doesn't define its own
button, input, message or card styles.

The commissioning tool on airfrog.org/commissioning uses the same styles,
except for the bridge window's and the full user interface's. `ci/tool-css.mjs`
writes them to `commissioning/tool.css` with every rule applying only inside
`.tool`, the `div` that contains the tool. The rest of that page uses
`site.css`.

Text the Airfrog home page displays before the Airfrog internal JS setup module
loads, or when it fails to load, uses `BASE_CSS` in `js/setup/style.js`: the
colour variables and the page font. The firmware build puts it in the page in
place of `@BASE_CSS@`.

## One source

Every text and value a page displays is defined in one place. A page refers
to it and never writes its own copy.
- Every text a page displays: `schema.toml`, which generates
  `js/messages.js` and the Airfrog home page's texts.
- AWP's values and layouts: `schema.toml`, which generates `js/schema.js`.
- Colours: the variables in `js/setup/style.js`, which have the values of
  the same variables in `site.css`. `tests/js/palette.test.mjs` fails when one differs.
- Styles: `js/setup/style.js`, `ci/tool-css-source.mjs`, `ui/src/style.js` and
  `site.css`.
- airfrog.org and images.airfrog.org addresses: `urls.toml`.
- Board names: the firmware, through GET_BOARDS.

A text or value that has no place in this list is agreed with the owner
before it is written.

## Colour

Colours are defined once as variables in `js/setup/style.js`. A second set is
used when the system is in dark mode. `site.css` is the source of every
variable it also defines, so the accent, greys and link colours are airfrog.org's.
`tests/js/palette.test.mjs` compares them in light and dark mode. The
commissioning tool's `tool.css` takes the variables from `js/setup/style.js`, so
it has no copy.

| Variable | Used for |
|---|---|
| `--accent` (blue) | Buttons, table headers, checkboxes, progress bars, the selected tab, the spinner, and ok and success states: success messages, the tick, Connected and Running pills |
| `--link` (blue) | Links outside the footer |
| `--bad` (red) | Failures and deleting |
| `--warn`, `--warn-bg` (amber) | Warnings, confirmations and states not yet settled |
| `--muted` (grey) | Secondary text and neutral states |
| `--accent-fg`, `--bad-fg` | Text on blue and red buttons |
| `--fg`, `--bg`, `--card`, `--line` | Text, page, cards and fields, borders |
| `--tip-bg`, `--tip-fg` | Tooltip box, dark in light mode and light in dark mode |
| `--bar-*` | The header bar and its pill, the same dark colours in both modes |
| `--highlight` (yellow) | J1 and J2's boxes on the board render |

Every coloured state also has text.

## Type

The system font at 15 px, line height 1.45.

| Text | Size |
|---|---|
| Header title | 17 px, semibold |
| Card title | 17 px, bold |
| Sub-heading in a card | 14 px, semibold, grey |
| Field label, note | 14 px, grey |
| Table header | 14 px, bold, white |
| Monospace in values | 14 px |
| Pill, tooltip, header sub line, footer | 13 px |
| Log | 12 px, monospace |

Numbers in values use tabular figures. Serial numbers, service names and pin
numbers use the monospace font.

Titles, labels, buttons, tabs and pills use sentence case: "Save and connect",
not "Save and Connect".

## Spacing and cards

- The content column is at most 720 px wide with 16 px side padding.
- A card has the `--card` background, a 1 px border, 10 px corners, 16 px
  padding and 16 px below it. Fields, buttons, the scan list and prompts have
  8 px corners.
- A card holds one subject and has a title. Warning cards, the connection
  state card and the bridge window card don't have a title.
- A sub-heading starts a group within a card. A separator line divides forms
  that save separately.
- Form rows are 12 px apart. Buttons in a row are 8 px apart.
- Fields, selects, the scan list and progress bars are at most 420 px wide.

### Warning cards

A warning card is an amber card for a lasting state of the page or of
Airfrog, for example "Full Airfrog UI not loaded. REASON", "No password
set. Set password" and AP mode staying on after Airfrog joins a network.
- It is never a bar above the tabs. Its place is in Main (see Page layout).
- It is displayed only while the state lasts.
- It can contain a link or button for its action, for example Set password
  or Stop AP mode.
- The failure of an operation is a message, not a warning card. The Airfrog
  full user interface not loading is a lasting state, so a warning card.

## Buttons

### Kinds

- A button is blue: a filled `--accent` background with `--accent-fg`
  text, 8 px corners and semibold. It is the shape of `.btn.primary` on
  airfrog.org at the Airfrog's sizes. Choose file, Scan and Refresh are included.
- Cancel is the exception: an outline with the `--bg` background, a
  `--line` border and `--fg` text, so it is told apart from the action it
  cancels.
- A button that deletes something is red: a filled `--bad` background with
  `--bad-fg` text, for example Remove password.
- Tabs and the "?" mark aren't buttons. They have their own styles (see Page
  layout and Tooltips).

### Labels

A button label is a verb or verb phrase for what happens: "Save", "Set
password", "Update", "Reset target". It is never "OK", "Yes", "Submit" or
"Apply".

### Placement

- The buttons of a form are in one row below its last field, left-aligned,
  with the main action first. A file chooser is the exception (see File
  chooser).
- In a form with several fields, a button that acts on one field is beside
  it, for example Scan beside Network name.
- Enter in a field runs the main action of the form. Enter in Network name
  doesn't run Save and connect, so a network isn't saved before its password
  is typed.

### When a button is enabled

- Save and Save and connect are enabled once a field differs from the
  settings stored in Airfrog and the required fields of the form are filled.
  They are disabled again after saving.
- The action button of another form (Set password, Log in) is enabled once
  its required fields are filled.
- Update is enabled once a chosen file passes its check (see File chooser).
- A button that acts on Airfrog, other than Connect and Log in, is disabled
  while the page isn't connected to Airfrog. Every button is disabled while
  its own operation or one that conflicts with it runs.
- A button is hidden, not disabled, when its action can't exist in the
  current state, for example Remove password while a password isn't set, Reset
  target on a target without a reset pin, or Update for an extension that is
  up to date.
- A disabled button, field or select is drawn at half opacity.
- A control reached by keyboard displays a focus ring.

### Confirmation

An action that deletes something, erases the Airfrog settings, restarts
Airfrog or changes data a running target is reading is confirmed first, for
example removing an extension. A firmware update isn't confirmed.
- An amber prompt appears below the buttons.
- Its text is a question about the action: "Are you sure you want to
  restart Airfrog?"
- The confirming button is labelled with the action ("Remove"). Cancel is
  beside it and has the focus.

### Links

A link is `--link`. It goes to another page or another place on the page, for example Set
password in the warning card, Change beside Board and Release notes. A
button performs an action.

A link from a page connected to Airfrog to another site opens in a new tab.
Leaving the page closes the connection.

## Inputs

- The label of a field is above it.
- A unit is in the label, for example "Boot window (ms)". A suffix follows
  the field, for example ".local".
- The label of an optional field ends "(optional)", for example the WiFi
  "Password (optional)". A required field isn't marked.
- Fields don't have placeholder text. A placeholder disappears once the user
  types.
- A field displays the value stored in Airfrog until the user edits it.
- When the action of a form runs, an invalid field gets a red border and the
  message line displays the reason.
- A setting that is on or off is a checkbox, with its label to the right in
  the text colour at 15 px.
- A choice from a list is a select. Where Airfrog can set the value itself,
  "Automatic" is the first option and displays the value Airfrog set in
  brackets: "Automatic (One ROM fire-24-c)".
- A number is a text field with the numeric keyboard. Its range is in its
  tooltip. Where Airfrog can set the number itself, an "Automatic" checkbox
  follows the field. While it is ticked the field is disabled and displays the
  value Airfrog set.
- A password is masked. A field for a stored WiFi password contains
  `********`.
  Leaving it unchanged keeps the stored password. An empty field means an open
  network.
- A password field is marked for password managers: `current-password` to log
  in, `new-password` to set the Airfrog password. The WiFi password field is
  marked `off`.

### File chooser

The file control drawn by the browser is hidden.
- A "Choose file" button opens the file dialog.
- The name of the chosen file is displayed beside it in grey. Before a file is
  chosen nothing is displayed.
- A firmware file is checked as soon as it is chosen. A spinner beside the
  file name is displayed while it checks, then a tick, or a cross with the
  reason in red. A file that isn't in the firmware manifest has a tick and
  "Unsigned firmware." in amber.
- The action button follows in the same row, for example Update.
- The file types accepted are restricted, for example to `.bin`.

## Tooltips

A tooltip is a "?" mark after a label, card title, button or pill, made with
`tip()` in `js/setup/dom.js`. It opens on hover or focus and stays open on a
tap. The `title` attribute isn't used, because it looks different in each
browser and doesn't open on a touch screen.

An item gets a tooltip only when its label leaves out something a user needs.
A Password card, for example, doesn't get one.

Tooltip text, in this order, each part only when it isn't in the label:
- one sentence for what the item is or does
- its range: "0 to 10000 ms."
- each special value as "VALUE: meaning.": "Automatic: set by detecting the
  target's firmware.", "0: disabled."
- the consequence: "Changing it causes Airfrog to disconnect and reconnect."

Each part ends with a full stop. Tooltips don't contain uses ("Use it to…")
or links.

## Lists, pills and icons

### Label and value lists

- Labels are grey on the left, values on the right.
- A value that isn't set or can't be read is "-". A value Airfrog reads but
  doesn't recognise is "Unknown".
- A long value, for example an IPv6 address, wraps.
- A row that can't exist in the current state is hidden, for example Signal
  while WiFi isn't connected.

### Tables

- The header row is a solid `--accent` background with white bold text.
- The actions for an item are in the last column, right-aligned.
- The current item is bold with a pill.
- A row keeps its height in every state, while an action in it runs included.

### WiFi scan list

One network per row:
- the signal bars on the left
- the network name
- a padlock on the right for a network that requires a password and that
  Airfrog can join, and nothing for an open one
- "Not supported" on the right for a network Airfrog can't join. Its row is
  greyed and can't be selected.

### Pills

A pill is a short state with a dot: "Connected", "One ROM: Stopped".

| Colour | States |
|---|---|
| Blue | Ok: Connected, Running |
| Amber | Not yet settled: Connecting |
| Red | Failed |
| Grey | Neutral: Stopped, Not set |

A pill is at the right of a card title, in a table row or in the header.

### Icons

- Only icons people know from system settings: signal bars, the padlock,
  the "?" mark, and the spinner, tick and cross of a firmware file's check.
  The dot in a pill isn't an icon.
- Icons are drawn with CSS or inline SVG in the text colour or grey. Unlit
  signal bars are `--line`. The spinner and the tick are `--accent` and the
  cross is `--bad`, as a pass and a failure. Icons aren't emoji, which look different on each
  system, or an icon font, which is another file to load.
- Every icon has a text alternative for screen readers, or is hidden from
  them when the text beside it has the same meaning, for example "-54 dBm".

## Messages

A message is displayed next to what it concerns:
- below the buttons of a form, for the operation of that form
- below a field, for a button beside the field, for example Scan
- above the cards of the tabs, for a failure that affects every tab, for
  example "Settings read failed."
- in the connection state card, for the connection to Airfrog
- in a warning card (see Warning cards)

A message is the state, then the action when there is one, tersely, without a
line break:
- "Scan failed. Try again."
- "Firmware update failed. No response from Airfrog."
- "No response from target. Check J1 wiring and target power."

A message never narrates an attempt ("couldn't", "tried to", "so it wasn't
started") and never repeats what is already on screen. The owner's
exception: the bridge window's "onerom.org couldn't connect to
airfrog.local."

| Kind | Form | Colour |
|---|---|---|
| Progress | Present participle and an ellipsis: "Saving…", "Updating to firmware v0.2.0…" | Grey |
| Success | The new state: "Saved.", "Updated to firmware v0.2.0 (1a2b3c4d)." | Blue |
| Information | The state: "No networks found." | Grey |
| Failure | What failed, then why, then the action when there is one: "Scan failed. Try again." Or the state: "No response from Airfrog." | Red |

A success message clears when a field of its form is edited. A message line
is announced to screen readers.

- The action is what to do, in one short imperative sentence, for example
  "Try again." or "Select Save and connect." How to do it is an instruction
  (see Instructions).
- Every sentence ends with a full stop, except a question, a progress
  message, a link labelled with a verb, for example Set password, and an
  airfrog.org link line (see Instructions). The ellipsis is the single
  character "…".
- Text about firmware a target runs uses the wording of that firmware, for
  example "Failed to start One ROM.", the One ROM CLI wording.

## Logs

A log is a bordered box in the `--card` background with a `--line` border and
8 px corners. Its text is 12 px monospace. It grows with its lines up to 320 px
high, then scrolls vertically. Long lines wrap. A success line is `--accent`
and a failure line is `--bad`. What a log displays, its order and when it is
cleared are the page's. The stylesheet's `pre.log` implements it.

## Text on pages

- Pages use these terms for these things: Airfrog home page, Airfrog UI (the
  full user interface), Airfrog internal JS setup module, Airfrog AP mode, airfrog.org,
  airfrog.org/commissioning, bridge window, firmware, Airfrog manifest, UI
  manifest, firmware manifest. "Airfrog" can be dropped where clear: "AP
  mode".
- Never built-in page, setup page, host page, app, web app, loader, control
  page, online UI, cloud UI, UI bundle or downloaded code.
- Software doesn't own things. Use Airfrog as a modifier, "the Airfrog
  password", or drop it where clear. The owner's exceptions: "Are you sure
  you want to remove Airfrog's password?", "This page uses Airfrog's AP
  mode, which will be disabled in 2 minutes.", "Resets the target using
  Airfrog's GPIOs." and "Controls Airfrog's GPIOs."
- Text doesn't use exclamation marks, "please", "click" or "tap". A button
  is referred to by its label, with "select": "Select Save and connect."
- A version is "v0.2.0 (1a2b3c4d)", or "v0.2.0" when the commit is unknown.
- A number and its unit have a space between them: "500 ms", "4 MB", "-54 dBm".
  A range is "0 to 10000 ms".
- A note is a grey line: a fact about a value, "Latest release.", or an
  airfrog.org link line (see Instructions).

### Instructions

Pages built into the firmware don't contain instructions, for example how to
reset a forgotten password, because they go out of date. They link to an
airfrog.org page instead, as a grey note in the form "TOPIC: See
airfrog.org/PAGE", for example "Forgotten password: See airfrog.org/recovery".
The link text is the URL without `https://`.

## Page layout

### Header

A dark bar the full width of the window. Within the content column:
- the Airfrog logo, 56 px, on the left
- the title, with a grey sub line beneath it
- on the Airfrog home page, the target state as a pill on the right, as
  "TARGET: STATE", for example "One ROM: Running" or "Target: Identifying"

| Page | Title | Sub line |
|---|---|---|
| Airfrog home page | `HOSTNAME.local`, or the host in the browser address until the hostname is read | IP address · Airfrog model · firmware version |
| Bridge window | The host in the browser address | |

The browser tab title on the Airfrog home page is the header title, so
several Airfrogs can be told apart. In the bridge window it is the host and
the website: "airfrog.local (onerom.org)".

### Tabs

The Airfrog home page has tabs below the header: each extension UI tab,
Target, Network, System, Advanced and Extensions. Extension UI tabs, Target
and Extensions are in the Airfrog full user interface only. An extension UI
tab is titled with the display name in the extension metadata, and the tabs
are in the order of the list in the Extensions tab. The Target tab is titled "Target". The tab bar
wraps onto more lines when the tabs don't fit. The selected tab has `--fg` text
and a blue underline. Other tabs are grey. Other pages don't have tabs.

### Main

On the Airfrog home page, in this order:
- warning cards
- the connection state card, or the Log in card
- the message line for a failure that affects every tab
- the cards of the selected tab

While the page isn't connected to Airfrog, the cards of the tab are greyed and
can't be used.

airfrog.org/commissioning has warning cards, then one card per step in the
order they are done:
Connect, Firmware, the settings cards, Done. The log is a collapsed "Log"
section at the end.

The bridge window has one card: its state lines, then the Log in form or
its button, Disconnect or Close.

### Pins card

- A flat top-side render of the Airfrog's board, centred, at most 240 px
  wide, rendered by `ci/render-boards.py`.
- J1 and J2 boxed on the render, with their labels outside the board: J1's
  above it and J2's to its left.
- Each connector's drawing and its table form one group, and the groups are
  centred in the card, with the tables lined up. Under 520 px wide, they
  stack in one column.
- Pins are grey, with pin 1 square.

### Footer

The Airfrog home page footer is "Airfrog v0.2.0 (1a2b3c4d) · airfrog.org ·
from piers.rocks", or "Airfrog · airfrog.org · from piers.rocks" until the
version is read. airfrog.org links to https://airfrog.org and piers.rocks to
https://piers.rocks. The footer, links included, is grey and centred, on every
page that has one.

## airfrog.org pages

These rules cover airfrog.org's pages, which use `site.css`. The commissioning
tool on airfrog.org/commissioning follows the rules above.
- Every page is 1080 px wide.
- The header is the Airfrog wordmark and the links Getting started and Airfrog
  Web. It is `header.html`, which `js/site/header.js` loads.
- Buttons and links are #0B76A0.
- A heading is a noun, not a sentence. Every `h2` and `h3` has an `id`.
- A table is full width with a blue header row. An empty cell is a dash.

Every airfrog.org page, airfrog.org/commissioning included, has the footer
"Airfrog · Copyright © 2026 · piers.rocks". Airfrog links to the airfrog.org
home page and piers.rocks to https://piers.rocks. It is `footer.html`, which
`js/site/footer.js` loads. The bridge window doesn't have a footer.
