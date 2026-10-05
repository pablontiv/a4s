# Portable agent definitions

This family preserves portable agent role definitions owned by A4S. Agent runtimes are integrations, not the category of this directory.

## Current contents

- [`common/`](common/) contains the manually derived Orchestrator instructions for Agent operating model version 1.0.
- [`pi/`](pi/) contains the five manual Pi Worker definitions for that model.
- [`claude/`](claude/) contains the corresponding five Claude Code custom-subagent definitions with Claude-native tool names.
- [`superpowers/`](superpowers/) contains:
  - **Canonical role definitions** (`superpowers-*.md`): owner-authored role definitions with file-level provenance in [`provenance.json`](superpowers/provenance.json). Tool lists use Pi-oriented names (read, grep, find, edit, write, bash, mem_save).
  - **Claude Code adapters** (`claude-code/superpowers-*.md`): adapted versions of canonical definitions with Claude Code tool names (Read, Grep, Glob, Edit, Write, Bash, mcp__plugin_engram_engram__mem_save). Body and frontmatter name/description are byte-identical to canonical; only the tools field is mapped.

## Installation and activation

The Agent operating model baseline is not installed or activated by this repository change. Its intended projections are:

```text
$PI_CODING_AGENT_DIR/AGENTS.md
  -> <checkout>/agents/common/AGENTS.md
$PI_CODING_AGENT_DIR/agents/<role-name>.md
  -> <checkout>/agents/pi/<role-name>.md

~/.claude/agents/<role-name>.md
  -> <checkout>/agents/claude/<role-name>.md
```

When `PI_CODING_AGENT_DIR` is unset, Pi's default root is `~/.pi/agent`. The five role names are `explorer`, `implementer`, `reviewer`, `debugger`, and `generalist`. These projections must fail closed rather than overwrite an existing runtime file.

The separate Superpowers Claude Code adapters are activated via [ADR 0049](../.workspace/docs/adr/0049-superpowers-claude-code-adapters.md):

**Installation contract**: Symlinks from `~/.claude/agents/<role-name>.md` to `agents/superpowers/claude-code/<role-name>.md` in the main branch checkout. Fails closed if a target exists (no overwrites). Symlinks are reversible (removal disables the role in that installation).

The Pi Superpowers installation remains in its own control plane; this installation enables Claude Code to use Superpowers roles as orchestrator subagents.

## Ownership and license

A4S owns these definitions. The imported definitions retain the [MIT license](../LICENSES/handbook-MIT.txt) from their source repository. Consumers must independently supply compatible tools and validate execution semantics.
