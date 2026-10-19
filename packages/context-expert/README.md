# @a4s/context-expert

Host-neutral **Jev compaction core** with two adapters — a **Claude Code
marketplace plugin** and a **Pi extension** — sharing one contract. Port of
context-expert to Claude (bead `a4s-jr3`).

It reuses [`fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction)
(MIT — see [`NOTICE`](./NOTICE)), restructured into the a4s core + dual-adapter
shape used by the synagent adapters.

El timing del trigger deriva de
[`compact-adviser`](https://github.com/kunchenguid/compact-adviser.git), tag
`compact-adviser-v0.1.12`, commit
`ef216af7cb639947bb4642fdf063117f12a91fc6`, licencia MIT. El archivo
[`NOTICE`](./NOTICE) incluye la licencia exacta.

## Architecture

```
core/                 host-neutral, pure: types, state fitting, Jev
                      request/parse, the keep/truncate/drop decision engine
                      (compact.ts), and the HostBinding contract (binding.ts).
                      Knows nothing of any host. Canonical source of truth.
adapters/claude/      Self-contained Claude Code marketplace plugin:
  .claude-plugin/       plugin.json manifest (+ types for standalone tsc).
  hooks/register.ts     on('session.compact') replaces the native summary with
                        the core's rebuilt message array; on('turn.complete')
                        auto-compacts past a context-window threshold. Jev runs
                        over $.http.fetch. claudeBinding implements HostBinding.
  core/                 BUNDLED byte-identical copy of ../../core (the
                        marketplace installs only this directory). Regenerated
                        by scripts/sync-core.mjs, anchored by the
                        claude-bundle-parity test.
adapters/pi/          Pi adapter — contract-parity shim: piBinding implements
                      the same HostBinding but assembles Pi's string-summary.
```

The one seam both hosts share, `HostBinding<HostMsg, HostResult>`:

- `toNeutral(host)` → neutral messages the core compacts.
- `assemble(host, result)` → the host hook's return shape.

Claude returns `{ messages }` (keep = engine message **with its handle**;
truncate = rebuilt message **without a handle**; drop = omitted). Pi returns a
summary **string** plus a kept boundary. Same core decisions, two assemblers.

## Install the Claude plugin (from the A4S marketplace)

```sh
claude plugin marketplace add pablontiv/a4s
claude plugin install a4s-context-expert@a4s
```

See [`adapters/claude/README.md`](./adapters/claude/README.md) for the plugin's
behavior, credential resolution, and configuration. The TypeSafe Jev key
resolves — last — from Pi's native provider (`~/.pi/agent/auth.json`), the
source the way-of-working sanctions (`do_work.credentials`); it is read
in-process only and never logged or written to disk.

## Auto-compact (the Pi-global analog)

El plugin registra un trigger `turn.complete` decidido por Jev. El gate local
usa `minimumContextRatio`, con valor predeterminado `0.5`. Jev recibe las dos
preguntas `done` y `shape`. El estado `a4s.compaction-trigger-state/v3` incluye
una conversación reciente sanitizada. Cada resultado de herramienta usa como
máximo 512 bytes UTF-8. Cada request usa como máximo 32,000 bytes. El score usa
`finished * (0.5 + 0.5 * hands_on)`. El floor baja de `0.90` a `0.50` entre
`0.10` y `0.90` de uso. El trigger redondea el floor a tres decimales.
`triggerMode` acepta `auto`, `hint` u `off`.

## Verified

- ✅ **Core** scores tool calls/results via Jev → deterministic
  keep/truncate/drop; user/assistant text preserved verbatim; first and newest
  messages pinned. (`test/core.test.ts`)
- ✅ **Claude adapter** maps `SessionMessage` ↔ neutral and back: kept messages
  keep object identity (engine handle), truncated ones are rebuilt, dropped
  ones are omitted. (`test/claude-adapter.test.ts`)
- ✅ **Pi adapter** drives the identical core and assembles Pi's string-summary.
  (`test/pi-adapter.test.ts`)
- ✅ **Bundle self-containment**: `adapters/claude/core` is byte-identical to
  canonical `core/`. (`test/claude-bundle-parity.test.ts`)
- ✅ `claude plugin validate` passes: `session.compact` + `turn.complete`,
  calls `$.http.fetch`/`$.session.*`/`$.fs.read`/`$.env.get`, **env writes:
  nothing**.
- ✅ **Live**: `session.compact` fired on a real `/compact` with the TypeSafe
  Jev key from Pi, scoring the transcript and choosing keep/truncate/drop; the
  below-min-reduction fallback to the native summary was exercised end-to-end.

## Not in this plugin (Pi's richer layers)

Ladder request-time retrieval, the rule-candidate pool, retro/rules, evidence,
and corpus from `@a4s/pi-context-expert` are **not** ported here; this plugin is
the deterministic compaction core + auto-compact trigger. A faithful Pi port
refactoring `@a4s/pi-context-expert` onto this shared core remains future work.

## Develop

```sh
# from this package dir (tools resolve from the repo-root node_modules)
tsx --test test/*.test.ts
tsc --noEmit -p tsconfig.json && tsc -p tsconfig.hooks.json
node adapters/claude/scripts/sync-core.mjs --check   # bundle parity
```
