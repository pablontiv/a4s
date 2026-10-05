# @a4s/context-expert (PoC)

Host-neutral **Jev compaction core** with two adapters — a **Claude Code mod**
and a **Pi extension** — sharing one contract. This is the PoC port of
context-expert to Claude (bead `a4s-jr3`).

It reuses [`fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction)
(MIT — see [`NOTICE`](./NOTICE)), restructured into the a4s core + dual-adapter
shape used by the synagent adapters.

## Architecture

```
core/            host-neutral, pure: types, state fitting, Jev request/parse,
                 the keep/truncate/drop decision engine (compact.ts), and the
                 HostBinding contract (binding.ts). Knows nothing of any host.
hooks/           Claude adapter — a function-hooks mod:
  register.ts      on('session.compact') replaces the native summary with the
                   core's rebuilt message array; on('turn.complete') asks the
                   engine to compact past a context-window threshold. Jev runs
                   over $.http.fetch. claudeBinding implements HostBinding.
adapters/pi/     Pi adapter — contract-parity shim: piBinding implements the
                 same HostBinding but assembles Pi's string-summary shape.
```

The one seam both hosts share, `HostBinding<HostMsg, HostResult>`:

- `toNeutral(host)` → neutral messages the core compacts.
- `assemble(host, result)` → the host hook's return shape.

Claude returns `{ messages }` (keep = engine message **with its handle**;
truncate = rebuilt message **without a handle**; drop = omitted). Pi returns a
summary **string** plus a kept boundary. Same core decisions, two assemblers.

## What this PoC proves (bead `a4s-jr3`)

- ✅ **Core** scores tool calls/results via Jev and produces deterministic
  keep/truncate/drop; user/assistant text is preserved verbatim; the first and
  newest messages are pinned. (`test/core.test.ts`)
- ✅ **Claude adapter** maps `SessionMessage` ↔ neutral and back: kept messages
  keep object identity (engine handle), truncated ones are rebuilt, dropped
  ones are omitted. (`test/claude-adapter.test.ts`)
- ✅ **Pi adapter** drives the identical core and assembles Pi's string-summary.
  (`test/pi-adapter.test.ts`)
- ✅ `claude plugin validate` passes: the mod registers `session.compact` +
  `turn.complete`, calls `$.http.fetch`/`$.session.*`, reads `TYPESAFE_API_KEY`,
  writes nothing.
- ✅ Two typecheck passes: general (Node) and mod-env (`tsconfig.hooks.json`,
  `types: []`) — the hook and its core import graph use no Node APIs.

## Deferred to promotion (NOT in this PoC)

- **Live Jev verdict** in a running Claude session (needs `TYPESAFE_API_KEY`;
  incurs provider cost).
- **Trigger** is wired and typechecked but has no engine-harness unit test yet.
- **Richer context-expert layers**: Ladder retrieval, the rule-candidate pool,
  retro/rules, evidence, corpus — none are ported here.
- **Faithful Pi port**: mapping Pi's real entry types and wiring
  `session_before_compact`, ideally refactoring `@a4s/pi-context-expert` onto
  this core. The Pi adapter here is a contract shim only.
- **Marketplace autocontención**: bundling `core/` into the installable Claude
  plugin (today the adapter imports `../core` within the package).

## Develop

```sh
# from this package dir (tools resolve from the repo-root node_modules)
tsx --test test/*.test.ts
tsc --noEmit -p tsconfig.json && tsc -p tsconfig.hooks.json
```

## Run as a Claude mod (live)

Set `TYPESAFE_API_KEY` (or the `apiKey` userConfig), load the plugin, and
compaction — manual `/compact` or the `turn.complete` trigger past
`compactAtPercent` — is served by Jev. On any failure (missing key, Jev error,
under-threshold reduction) it falls back to the native summary, so a failure
never degrades the session.
