# Vibecodium slice 0 + server slice 1 report

## Checkpoints

- `7ba23bc` — `#1 build slice 0 gate and server skeleton`
- `11facede` — `#1 add strict governance checks`
- Branch: `build/slice-0-1`; `main` was not changed.

## What was built

- Strict TypeScript/NodeNext package with minimal runtime dependencies (`better-sqlite3`, `ws`).
- SQLite append-only event log with WAL, FULL synchronous writes, global monotonic sequence numbers, stream replay, subscriptions, and reopen durability.
- Localhost-only control plane with `/healthz`, `/events`, and WebSocket session/subscription/action messages.
- Isolated child-process session worker. It has no event-store import or database handle and emits provider events through IPC.
- Typed `ProviderSessionRef` seam (`spawn`, `stream`, `stop`, `capabilityMatrix`), fake echo provider, and explicit `ProviderNotImplementedError` adapters for real providers.
- Typed deny-first authority with protected rules taking precedence over explicit permissions.
- `vibecodium start`/`dev` CLI and npm scripts.
- Strict hooks, quality manifest, immutable evidence records, staged checks, full gate, and 500-line file-size enforcement.

## Walking-skeleton proof

`test/control-plane.integration.test.ts` starts the control plane on `127.0.0.1`, opens a fake echo session, observes ordered event sequence numbers, disconnects after the first output, waits for completion, reconnects with the cursor, and asserts the replay is exactly the missed suffix. The same test asserts a filesystem action is denied and an explicitly permitted stop action is allowed.

## Governance status

| Check                    | Status                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Max file lines (`500`)   | Enforced in staged pre-commit and all-tracked gate; lockfiles, generated, vendored, and evidence paths are explicitly exempted.                                        |
| Branch/issue binding     | Enforced by `.vibecodium/branch.json`, staged hook, and commit-msg hook; current issues are `#1 #2 #5 #6 #8 #11`. `gh` labeling/state checks warn when unavailable.    |
| Branch naming            | Enforced from `branchNamePattern` in the manifest.                                                                                                                     |
| Nested worktrees         | Enforced in pre-commit and gate; sibling-only paths pass.                                                                                                              |
| Main guard               | Enforced in pre-commit/gate plus post-checkout and post-merge hooks.                                                                                                   |
| Primary merge-only       | `primaryCheckout: merge-only` allows merge-in-progress/multi-parent commits in the primary and rejects authored commits; sibling worktrees remain authoring checkouts. |
| Focused/skipped tests    | Enforced from manifest regexes.                                                                                                                                        |
| Lockfile sync            | Enforced for package/lock presence, root dependency parity, and staged package changes.                                                                                |
| Debug leftovers          | Warn-tier scan for `console.log`/`debugger` in `src`.                                                                                                                  |
| Stale worktree sweep     | Maintenance-only `scripts/worktree-sweep`; dry-run default, `--prune` removes merged+aged+clean candidates.                                                            |
| Dependency approvals     | Enforced against `HEAD`; approvals require a reason and approver, and the file states agents cannot self-approve.                                                      |
| npm audit                | Warn-tier, offline-safe advisory scan; high/critical findings do not block this phase.                                                                                 |
| Protected merge evidence | `post-merge`, pre-push gate, and `scripts/merge-gate` require a passing strict gate evidence record for the exact main head.                                           |

## Exact gate result

Real `npm run gate` / pre-push output:

```text
max-file-lines passed: 51 tracked candidate(s), max 500
branch-name passed: build/slice-0-1
branch-issue passed
worktree-nesting passed: 7 worktree(s)
main-guard passed: build/slice-0-1
primary-merge-only passed: primary validation run
focused-tests passed: 3 test file(s)
lockfile-sync passed: package-lock.json
dependency-approval passed: no new dependencies
debug-leftovers passed: no console.log/debugger in src
npm audit passed: no high/critical vulnerabilities
> tsc -p tsconfig.json --noEmit
> eslint .
> prettier --check .
Checking formatting...
All matched files use Prettier code style!
> npm run build && node --test dist/test/*.test.js
> tsc -p tsconfig.json
TAP version 13
# Subtest: authority denies actions by default
ok 1 - authority denies actions by default
# Subtest: authority allows an explicit scoped permission
ok 2 - authority allows an explicit scoped permission
# Subtest: protected rules win before permitted rules
ok 3 - protected rules win before permitted rules
# Subtest: opens an echo session, streams ordered events, and catches up after reconnect
ok 4 - opens an echo session, streams ordered events, and catches up after reconnect
# Subtest: append assigns monotonic global sequences and replays after a cursor
ok 5 - append assigns monotonic global sequences and replays after a cursor
# Subtest: subscribe replays the cursor then receives newly appended events
ok 6 - subscribe replays the cursor then receives newly appended events
# Subtest: events survive closing and reopening the SQLite store
ok 7 - events survive closing and reopening the SQLite store
1..7
# tests 7
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
merge-gate skipped: current branch is build/slice-0-1
```

The authoritative run exited `0`. Every run writes JSON evidence under `.vibecodium/evidence/`; that directory is gitignored. The pre-push hook was also run directly and exited `0`.

## Run locally

```sh
npm install
scripts/install-hooks
npm run gate
npm start
# or: npm run dev
```

The server defaults to `http://127.0.0.1:4310`; set `VIBECODIUM_PORT` and `VIBECODIUM_DB_PATH` to override it. Tests are headless and use temporary SQLite stores.

## Module map

- `src/server/event-store.ts` — append/replay/subscription persistence.
- `src/server/control-plane.ts` — HTTP/WS protocol, authority checks, sole event-store writer, worker lifecycle.
- `src/server/session-worker.ts` — isolated provider worker and IPC event contract.
- `src/server/authority.ts` — typed deny-first evaluator.
- `src/provider/provider.ts` — provider adapter contract, echo implementation, typed not-implemented seam.
- `src/cli.ts` — start/dev entry point.
- `test/*.test.ts` — event-store, authority, and end-to-end walking-skeleton tests.
- `scripts/gate.mjs`, `scripts/hooks.mjs`, `scripts/evidence.mjs` — quality gate orchestration and immutable evidence.
- `scripts/checks/` — standalone governance checks.

## Deferred to the owner's live gate

- Real Claude/OMP/Codex provider adapters, credentials, and provider capability validation.
- Tailscale/tailnet exposure; the control plane remains localhost-only.
- React Native/mobile console wiring.
- systemd/Podman installation and deployment supervision.
- Live GitHub issue labeling/state confirmation when `gh` credentials/network are available.
