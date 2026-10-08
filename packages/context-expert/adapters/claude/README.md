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
- **`turn.complete`** usa la política compartida adaptativa. El floor es
  `max(60000, 15% de la ventana)`. El ceiling es el mayor entre `20% de la
  ventana` y `floor + 5% de la ventana`. Bajo el floor, el adaptador no resuelve
  credenciales ni llama al Jev de timing. Entre floor y ceiling, Jev recibe las
  preguntas `done` y `shape`. En el ceiling, la política compacta sin llamar al
  Jev de timing. El estado `a4s.compaction-trigger-state/v3` recibe
  `$.session.messages()` mediante la API de Claude. El adaptador excluye el
  system prompt, reasoning e imágenes. El adaptador sanitiza el texto. Cada
  resultado de herramienta usa como máximo 512 bytes UTF-8. Cada request usa
  como máximo 32,000 bytes. El modo `hint` muestra un aviso que indica al
  usuario que ejecute `/compact`. El modo `hint` no inicia una compactación. El
  modo `auto` inicia una compactación tras una decisión positiva.
- El trigger aplica un cooldown de 300 segundos a los avisos y a las
  compactaciones automáticas. El trigger permite una sola compactación
  concurrente. Tras completar una compactación automática, el trigger se
  rearma en `max(floor, postContextTokens + 40000)`. El modo `hint` no crea
  rearme. Si Claude no devuelve `tokensAfter`, el adaptador bloquea nuevas
  decisiones automáticas durante la sesión. El adaptador no estima este valor.
- El adaptador registra decisiones estructuradas con el identificador
  `a4s.claude-context-expert.trigger-decision.v1`. Un aviso positivo registra
  `decision=compact`, `dispatchOutcome=not_dispatched` y `uiOutcome=hinted`.
  Usa `$.ui.log`, que también
  entra en el debug log del host. Claude no ofrece al plugin un almacén durable
  equivalente a las custom entries de Pi. El adaptador no crea un archivo de
  logging propio.

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
| `triggerMode` | `auto` | `auto` compacts after a positive policy decision. `hint` asks the user to run `/compact` and does not compact. `off` disables the trigger. |
| `minimumContextRatio` | `0.5` | Compatibility setting. The shared adaptive policy uses token floor and ceiling values. |
| `minReductionRatio` | `0.25` | Minimum estimated reduction to replace history; below it, native summary. |
| `keepThreshold` | `0.5` | Minimum Jev probability to keep a tool call/result. |
| `preserveRecentMessages` | `6` | Newest messages pinned from compaction. |
| `maxStateTokens` / `maxRequestTokens` | `25000` / `30000` | Jev request token budgets. |
| `truncateHeadChars` | `300` | Characters of a truncated tool result kept. |
| `model` | `jev-latest` | TypeSafe Jev model. |
| `apiKey` | — | TypeSafe key override (sensitive); otherwise resolved as above. |

To turn the auto-compact trigger **off**, set `triggerMode` to `off`.

Derived from [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
(MIT) — see `NOTICE`.

El timing del trigger deriva de
[`compact-adviser`](https://github.com/kunchenguid/compact-adviser.git), tag
`compact-adviser-v0.1.12`, commit
`ef216af7cb639947bb4642fdf063117f12a91fc6`, licencia MIT. `NOTICE` incluye la
licencia exacta.
