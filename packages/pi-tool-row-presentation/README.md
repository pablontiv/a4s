# A4S Pi Tool Row Presentation

Private Pi extension that controls how tool calls appear in the interactive transcript. Pi's native `Settings > Tool rows` row is the authoritative UI for choosing `full`, `compact`, or `hidden`; `Ctrl+Alt+O` cycles through the same persisted setting as a quick shortcut. The extension registers no slash command.

`compact` requests Pi's `summary` transcript density. `hidden` also hides Pi's orphaned-thinking placeholder; the other modes leave that placeholder visible.

## Install and use

This package is a pre-release candidate and is not currently installable against the published Pi 1.0.0 public contract. Once a published Pi release exposes both required extension ports, the host can load the package entrypoint:

```sh
pi -e packages/pi-tool-row-presentation/src/index.ts
```

Open Pi's native settings and select `Tool rows`, or press `Ctrl+Alt+O` to cycle `full` -> `compact` -> `hidden` -> `full`. Both surfaces use the same global `a4s.tool-rows.mode` setting.

`a4s.tool-rows.migrated-v1` records one-time migration of Pi's legacy core `toolRowsMode` value. The extension does not migrate any other extension namespace.

## Host dependency blocker

The package still requires two unpublished Pi extension ports after removing its former command surface:

- `registerSetting` registers the native settings row, persists the mode and migration marker, and supplies the `get`, `set`, and `onChange` handle operations shared by settings, migration, the shortcut, and live invalidation.
- `registerTranscriptPresentationPolicy` applies `full`, `summary`, or `hidden` density to transcript blocks and provides invalidation when the mode changes.

Pi 1.0.0 already publishes `registerCommand`, but this extension no longer uses it. Removing that published API does not replace either required port. Published Pi 1.0.0 lacks declarations for both remaining methods, so CI intentionally omits this package from the aggregate root typecheck. The package must not merge until a published Pi version provides both ports, this package's typecheck is restored to the root aggregate, and a fresh `npm ci`, root tests, root typecheck, E2E, and review pass without a local type mapping or pi-local checkout. The eventual development minimum remains pending that publication; no future version is assumed here.

Pi and TypeBox remain wildcard peer dependencies so the active host supplies one shared runtime.

## Development

```sh
npm test --workspace @a4s/pi-tool-row-presentation
npm run typecheck --workspace @a4s/pi-tool-row-presentation
```

The six contract tests execute the extension factory against an in-memory structural fake. They import no Pi private internals, do not load the published or modified Pi runtime, and do not depend on Pi's declarations, so root tests and CI retain them.

The package-owned typecheck remains an explicit readiness gate but is intentionally absent from the root aggregate while blocked. Run separately against Pi 1.0.0, it is expected to fail only because `ExtensionAPI` lacks `registerSetting` and `registerTranscriptPresentationPolicy`. The successful mapped typecheck and real E2E against the exact pi-local checkout are local disposable evidence only and must never be added to CI. Once both ports are published, restore this package's typecheck to the root aggregate and rerun fresh install, root checks, E2E, review, and CI before considering the draft ready.
