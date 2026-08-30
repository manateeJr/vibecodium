# Vibecodium

## CLI usage

Start the control plane with `vibecodium start` (or `vibecodium dev`). The
control plane defaults to `http://127.0.0.1:4310`.

### Attach to a session

`vibecodium attach` lists known sessions and their current state. To take over
a session in the terminal, run `vibecodium attach <session-id>`. Vibecodium
ensures a resumable session is live, then foregrounds the native TUI through
abduco. The attach command uses the abduco binary path returned by the control
plane; it does not assume a host-global installation.

To start a new substrate-backed OMP session in a project and attach to it in
one step, run `vibecodium open <project/path>`. `vibecodium attach --new` is an
alias that opens the current directory (or a supplied path) before attaching.

For troubleshooting, the raw escape hatch is `abduco -a <name>`, where `<name>`
is the substrate name returned by `vibecodium attach <session-id>`'s attach
information. This bypasses the CLI wrapper but connects to the same native TUI.

Running plain `omp` in a terminal remains an **external session**, not a
control-plane session. If that session is later resumed through Vibecodium, it
follows the existing fork-on-conflict behavior rather than becoming a
substrate-backed live session.

## Sharing files into Vibecodium from a phone

Sharing puts one or more files into the control plane's shared folder and then
opens the web app with those files already staged in the composer, so the share
becomes an ordinary new session: type a prompt (or keep the one the share
brought), check the `PROJECT` picker, press `OPEN`.

Both platforms use the same two control-plane steps:

1. `POST /share-intake` as `multipart/form-data`, with the file(s) in the field
   `file` and optional text fields `note` and `project`. The response is JSON:
   `{"token": "<token>", "path": "<staging directory>"}`.
2. Open `https://<host>/?share=<token>`. The web app reads the staged metadata
   and prefills the composer with the attachments, the note, and the project.

`<host>` is whatever host the control plane is reachable on from the phone — on
a Tailscale tailnet that is the machine's tailnet name, e.g.
`https://my-laptop.tailnet-name.ts.net`.

### Android

Nothing to set up. Install the PWA (Chrome → **Add to Home screen**) and
Vibecodium appears in the Android share sheet: `web/manifest.webmanifest`
declares a `share_target` that POSTs the share straight to `/share-intake`, and
the service worker exchanges the response for the `?share=<token>` navigation.
The share sheet's title becomes `project` and its text becomes `note`.

### iOS — Shortcut recipe

iOS has no `share_target`, so a Shortcut performs the same two steps. Create it
in the Shortcuts app:

1. **New Shortcut** → rename it `Share to Vibecodium`.
2. Open the shortcut's settings (the ⓘ / **Details** tab) and turn on **Show in
   Share Sheet**. Under **Share Sheet Types** keep **Files** and **Images**
   (add anything else you want to share); leave **Text** and **URLs** on if you
   want to share links too.
3. Add action **Get Contents of URL** and expand **Show More**:
   - **URL**: `https://<host>/share-intake`
   - **Method**: `POST`
   - **Request Body**: `Form`
   - Add a form field: **Key** `file`, type **File**, **Value** `Shortcut
Input`. (Shortcuts sends a `Form` body as `multipart/form-data`.)
   - Optionally add a **Text** field **Key** `project` with the project name you
     usually share into, and a **Text** field **Key** `note`.
4. Add action **Get Dictionary Value** → **Get** `Value` for **Key** `token`
   **in** the _Contents of URL_ output from step 3.
5. Add action **Open URLs** with the URL
   `https://<host>/?share=` followed by the _Dictionary Value_ from step 4.
   (Type the literal prefix, then insert the variable — do not wrap it in
   quotes.)

Then: share a file from any app → **Share to Vibecodium** → the PWA opens with
the file staged. If the token has expired or the upload failed, the composer
says so instead of opening a session with nothing attached.
