# A4S Pi Tool Row Presentation

Private Pion extension that controls how tool calls appear in the interactive transcript. Pion's native `Settings > Tool rows` row is the authoritative UI for choosing `full`, `compact`, or `hidden`; `Ctrl+Alt+O` cycles through the same persisted setting as a quick shortcut. The extension registers no slash command.

`compact` requests Pion's `summary` transcript density. `hidden` also hides Pion's orphaned-thinking placeholder; the other modes leave that placeholder visible.

## Requirement

This extension requires [Pion 1.0.0-ports.1](https://github.com/pablontiv/pi/releases/tag/pion-v1.0.0-ports.1), which provides extension-owned settings and transcript presentation policies. Its development type import is pinned to that immutable release artifact; runtime host imports remain compatible through Pion's managed extension loader.

## Use

```sh
pion -e packages/pi-tool-row-presentation/src/index.ts
```

Open Pion's native settings and select `Tool rows`, or press `Ctrl+Alt+O` to cycle `full` -> `compact` -> `hidden` -> `full`. Both surfaces use the same global `a4s.tool-rows.mode` setting.

`a4s.tool-rows.migrated-v1` records one-time migration of Pi's legacy core `toolRowsMode` value. The extension does not migrate any other extension namespace.

## Development

```sh
npm test --workspace @a4s/pi-tool-row-presentation
npm run typecheck --workspace @a4s/pi-tool-row-presentation
```

The contract tests exercise settings, migration, shortcut, invalidation, and transcript presentation behavior against an in-memory structural host. The package typecheck uses Pion's published declarations and is part of the root aggregate gate.
