# A4S Pi Tool Row Presentation

Private Pi extension that controls how tool calls appear in the interactive transcript. It contributes the native `Tool rows` setting and preserves `/tool-rows` plus `Ctrl+Alt+O` as direct controls for `full`, `compact`, and `hidden` modes.

`compact` requests Pi's `summary` transcript density. `hidden` also hides Pi's orphaned-thinking placeholder; the other modes leave that placeholder visible.

## Install and use

This package is a pre-release candidate and is not currently installable against the published Pi 1.0.0 public contract. Once a published Pi release exposes both required extension ports, the host can load the package entrypoint:

```sh
pi -e packages/pi-tool-row-presentation/src/index.ts
```

Then use:

```text
/tool-rows
/tool-rows full
/tool-rows compact
/tool-rows hidden
```

The `Ctrl+Alt+O` shortcut cycles through the same modes. Values are stored globally under `a4s.tool-rows.mode`; `a4s.tool-rows.migrated-v1` records one-time migration of Pi's legacy core `toolRowsMode` value. The extension does not migrate any other extension namespace.

## Host dependency blocker

The package requires the public Pi extension methods `registerSetting` and `registerTranscriptPresentationPolicy`. Published Pi 1.0.0 lacks both declarations, so this candidate must not merge until a published Pi version provides them and a fresh `npm ci`, root tests, and root typecheck pass without a local type mapping or pi-local checkout. The eventual development minimum remains pending that publication; no future version is assumed here.

Pi and TypeBox remain wildcard peer dependencies so the active host supplies one shared runtime.

## Development

```sh
npm test --workspace @a4s/pi-tool-row-presentation
npm run typecheck --workspace @a4s/pi-tool-row-presentation
```

Contract tests use a fake of the public extension API and import no Pi private internals. Until the host dependency blocker is resolved, the normal typecheck is expected to fail only because the installed Pi declarations lack the two required ports.
