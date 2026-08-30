# Vibecodium — Agent Guide

Vibecodium is a self-hosted, always-on control plane for AI coding sessions (TypeScript/Node, strict, NodeNext ESM).

## Prime directive: self-contained

- A fresh `git clone` plus the documented setup MUST work on any Linux box. Do NOT hard-depend on tools that merely happen to exist on the maintainer's machine.
- Bundle capabilities with the repo, or self-provision them at setup / first run — never assume a host-specific install. Examples:
  - Voice transcription provisions its OWN whisper engine (isolated Python venv via `faster-whisper`) and downloads its model under the repo's data dir; it must not rely on a pre-existing host whisper / WhisperFlow install.
  - Built-in skills (grill-me, wayfinder, file-gh-issue, batch-issues, advisor, and custom ones) ship WITH the repo, not sourced from the host's skill library.
- You MAY learn from the host's existing setup (discover how the maintainer configured something) to inform sensible defaults, but the result must stay generic and portable.

## Dependencies

- Runtime npm deps are limited to `better-sqlite3` + `ws`. Adding any new npm dependency requires explicit maintainer approval.
- Non-npm needs (a Python venv, model files, system binaries such as `ffmpeg`, and a C compiler such as `cc`) MUST be self-provisioned by a setup step and documented — not assumed present on the host.

## Repo conventions

- merge-only-primary: the primary checkout (`~/vibecodium`) rejects authored commits. Do all work in sibling worktrees; only merges INTO `main` happen in the primary.
- Gate (`npm run gate`): tsc + eslint + prettier + node:test + governance (max 500 lines per file; prettier on all files). The merge-gate requires a `.vibecodium/evidence/*.json` entry covering the exact committed HEAD.
- Projects registry lives at `~/.vibecodium/projects.json`.
