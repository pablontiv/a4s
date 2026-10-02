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

Pi 1.0.0 already publishes `registerCommand`, but this extension no longer uses it. Removing that published API does not replace either required port. Published Pi 1.0.0 lacks declarations for both remaining methods, so this candidate must not merge until a published Pi version provides them and a fresh `npm ci`, root tests, and root typecheck pass without a local type mapping or pi-local checkout. The eventual development minimum remains pending that publication; no future version is assumed here.

Pi and TypeBox remain wildcard peer dependencies so the active host supplies one shared runtime.

## Development

```sh
npm test --workspace @a4s/pi-tool-row-presentation
npm run typecheck --workspace @a4s/pi-tool-row-presentation
```

Contract tests use a fake of the public extension API and import no Pi private internals. Until the host dependency blocker is resolved, the normal typecheck is expected to fail only because the installed Pi declarations lack `registerSetting` and `registerTranscriptPresentationPolicy`.
