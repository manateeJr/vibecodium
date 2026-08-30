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
