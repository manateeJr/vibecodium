# xterm.js — vendored static asset

The phone surface renders the read-only live PTY mirror with xterm.js. It is vendored here as a
plain static asset and served by the control plane's static handler.

## Provenance

| | |
| --- | --- |
| npm package | `xterm` (the 5.x name; 5.4.0+ renamed to `@xterm/xterm`) |
| version | **5.3.0**, pinned |
| vendored on | 2026-08-30 |
| licence | MIT — see `LICENSE`, copied verbatim from the same release |

Files, fetched verbatim from the pinned version on jsDelivr:

| file | source URL | bytes | md5 |
| --- | --- | --- | --- |
| `xterm.js` | `https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js` | 283404 | `e162d1d3f7e6bb7cae82b2d08d992edb` |
| `xterm.css` | `https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css` | 5383 | `4267d3deed3a180ee533775ffff94d3e` |
| `LICENSE` | `https://cdn.jsdelivr.net/npm/xterm@5.3.0/LICENSE` | 1261 | `a6f7d231a2745fd8aaa465e2dd7c7c04` |

`xterm.js` is the UMD browser bundle. Loaded from a classic `<script>` tag it copies its exports
onto the global object, so **`globalThis.Terminal` is the constructor itself** — not a namespace
with a `.Terminal` member. `test/phone-surface.test.ts` pins that shape, because getting it wrong
fails silently: the mirror just reports `UNAVAILABLE` forever.

The bundle ends with a `sourceMappingURL=xterm.js.map` comment. The map is deliberately not
vendored (it is larger than the bundle and only helps upstream debugging), so opening devtools
logs one harmless 404. The two files are kept byte-identical to upstream instead, so their hashes
stay verifiable against the table above.

## Rules

- This is a **static asset, never an npm dependency.** `scripts/checks/dependency-approval.mjs`
  freezes runtime dependencies to `better-sqlite3` and `ws`; adding `xterm` to `package.json`
  fails the gate.
- Do not edit these files. To move versions, re-fetch all three from the new pinned version's
  URLs, update the table above, and re-check the hashes.
- `web/vendor/**` is excluded from eslint (`eslint.config.js`), prettier (`.prettierignore`) and
  the 500-line file cap (`vibecodium.quality.json` `maxFileLinesExempt`). Keep it that way.
