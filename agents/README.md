# Portable agent definitions

This family preserves portable agent role definitions owned by A4S. Agent runtimes are integrations, not the category of this directory.

## Current contents

[`superpowers/`](superpowers/) contains:
- **Canonical role definitions** (`superpowers-*.md`): owner-authored role definitions with file-level provenance in [`provenance.json`](superpowers/provenance.json). Tool lists use Pi-oriented names (read, grep, find, edit, write, bash, mem_save).
- **Claude Code adapters** (`claude-code/superpowers-*.md`): adapted versions of canonical definitions with Claude Code tool names (Read, Grep, Glob, Edit, Write, Bash, mcp__plugin_engram_engram__mem_save). Body and frontmatter name/description are byte-identical to canonical; only the tools field is mapped.

## Installation and activation

Claude Code adapters are activated via [ADR 0049](../.workspace/docs/adr/0049-superpowers-claude-code-adapters.md):

**Installation contract**: Symlinks from `~/.claude/agents/<role-name>.md` to `agents/superpowers/claude-code/<role-name>.md` in the main branch checkout. Fails closed if a target exists (no overwrites). Symlinks are reversible (removal disables the role in that installation).

The Pi installation remains in its own control plane; this installation enables Claude Code to use Superpowers roles as orchestrator subagents.

## Ownership and license

A4S owns these definitions. The imported definitions retain the [MIT license](../LICENSES/handbook-MIT.txt) from their source repository. Consumers must independently supply compatible tools and validate execution semantics.
