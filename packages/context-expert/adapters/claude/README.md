# a4s-context-expert (Claude Code plugin)

Jev-guided deterministic compaction for Claude Code. It replaces Claude's
native `/compact` summary with a **keep / truncate / drop** transcript scored by
TypeSafe Jev, and auto-compacts once the context window crosses a threshold —
the Claude analog of Pi's `pi-context-expert` with `trigger.mode: "auto"`.

This directory is the self-contained marketplace plugin. It bundles its own copy
of the host-neutral core (`core/`), kept byte-identical to the canonical
`packages/context-expert/core/` by `scripts/sync-core.mjs` and anchored by the
`claude-bundle-parity` test, because the marketplace installs only this
directory.

## What it does

- **`session.compact`** — runs the shared core over the live transcript. Jev
  scores each tool call/result; items below the keep threshold are dropped
  (calls) or truncated (results), the first message and the most recent N are
  pinned, and the rebuilt message array replaces the native summary. If the
  estimated reduction is below `minReductionRatio`, or anything fails, it falls
  back to the native summary via `next(event)` — a failure never degrades the
  session.
- **`turn.complete`** — the auto-compact trigger. When `$.session.usage()`
  reports the context window at or above `compactAtPercent`, it asks the engine
  to compact. This is the "compact automatic" behavior.

## Credentials

The TypeSafe Jev key resolves, in order, from the plugin `apiKey` userConfig,
then `TYPESAFE_API_KEY`, then the plugin settings `env`, and finally **Pi's
native credential provider** (`~/.pi/agent/auth.json` → `typesafe.key`) — the
source the A4S way-of-working sanctions (`do_work.credentials`). The key is read
in-process only; it is never logged, written to disk, or copied elsewhere.

## Install (from the A4S marketplace)

```sh
claude plugin marketplace add pablontiv/a4s
claude plugin install a4s-context-expert@a4s
```

Or load it directly from a checkout:

```sh
claude --plugin-dir packages/context-expert/adapters/claude
```

## Configuration (`userConfig`)

| Key | Default | Meaning |
| --- | --- | --- |
| `compactAtPercent` | `60` | Context-window % at which `turn.complete` auto-compacts. |
| `minReductionRatio` | `0.25` | Minimum estimated reduction to replace history; below it, native summary. |
| `keepThreshold` | `0.5` | Minimum Jev probability to keep a tool call/result. |
| `preserveRecentMessages` | `6` | Newest messages pinned from compaction. |
| `maxStateTokens` / `maxRequestTokens` | `25000` / `30000` | Jev request token budgets. |
| `truncateHeadChars` | `300` | Characters of a truncated tool result kept. |
| `model` | `jev-latest` | TypeSafe Jev model. |
| `apiKey` | — | TypeSafe key override (sensitive); otherwise resolved as above. |

To turn the auto-compact trigger **off**, set `compactAtPercent` to `100`.

Derived from [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
(MIT) — see `NOTICE`.
