# A4S Pi Tool Row Presentation

This extension controls tool rows in Pi and Pion. It supports `full`, `compact`, and `hidden` modes.

A Pion host with the final `renderRow()` contract applies all three modes. The `full` mode uses the native tool row. The `compact` mode uses one private line when the row is collapsed and does not report an error. The `hidden` mode removes that collapsed row. Expanded rows and error rows use the native tool row. Direct Bash output does not change. HTML export does not use this renderer.

Pi 1.0.3 and Pion 1.0.4 keep command, shortcut, and storage support. These hosts use the native tool row. The extension reports this limitation after each successful change.

## Use

Load the extension in Pi or Pion.

```sh
pi -e packages/pi-tool-row-presentation/src/index.ts
pion -e packages/pi-tool-row-presentation/src/index.ts
```

Run this command in an interactive session:

```text
/pi-tool-row-presentation-settings
```

The command offers `full`, `compact`, `hidden`, reset, and cancel. `Ctrl+Alt+O` cycles through the three modes. Both controls write the same global file.

## Configuration

The global file is:

```text
<agent-dir>/pi-tool-row-presentation.json
```

The extension uses the non-empty `PI_CODING_AGENT_DIR` value as `<agent-dir>`. It uses `~/.pi/agent` when that value is absent or empty. The file has this format:

```json
{
  "mode": "compact"
}
```

The extension writes this file through an atomic rename. It creates the parent directory. It sets file mode `0600`.

A trusted project can provide this override:

```text
<project>/.pi/pi-tool-row-presentation.json
```

The project file uses the same format. The project mode takes precedence over the global mode. The extension ignores the project file when Pi does not trust the project. The command and shortcut always write the global file.

## Migration

The extension checks legacy settings only when the new global file does not exist. It first checks `extensionSettings["a4s.tool-rows.mode"]`. It then checks `toolRowsMode`. It migrates only `full`, `compact`, or `hidden`. It does not read `a4s.tool-rows.migrated-v1`. It does not change `settings.json`.

## Development

```sh
npm test --workspace @a4s/pi-tool-row-presentation
npm run typecheck --workspace @a4s/pi-tool-row-presentation
git diff --check
```

The package declares Pi and Pion as optional peer hosts. A consumer does not need to install both hosts.

The development dependency uses the immutable Pion snapshot for the final `renderRow()` contract.
