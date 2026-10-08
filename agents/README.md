# Portable agent definitions

This family preserves portable agent role definitions owned by A4S. Agent runtimes are integrations, not the category of this directory.

## Authority boundary

[`common/AGENTS.md`](common/AGENTS.md) is Pi's root runtime entry point and the authoritative runtime contract for Orchestrator identity, decomposition, dispatch, Worker topology, concurrency, and adjudication. Repository-local policy remains the authority for what project work is authorized and for project-specific readiness, mutation, review, safety, and delivery. The two contracts are cumulative: neither replaces or extends the other, and installing these definitions does not grant project authority.

The Orchestrator is Pi and performs orchestration only. Every domain action goes to a direct leaf Worker. Each independently adjudicable work unit has one result and one primary specialization; all ready, non-conflicting units are dispatched concurrently under the exceptions and wave behavior defined by the runtime contract.

## Current contents

- [`common/`](common/) contains the Pi Orchestrator root runtime contract for Agent operating model version 1.0.
- [`pi/`](pi/) contains six manual Pi Worker definitions for that model.
- [`claude/`](claude/) contains five Claude Code custom-subagent definitions with Claude-native tool names. This set does not include Judge.
- [`superpowers/`](superpowers/) contains:
  - **Canonical role definitions** (`superpowers-*.md`): owner-authored role definitions with file-level provenance in [`provenance.json`](superpowers/provenance.json). Tool lists use Pi-oriented names (read, grep, find, edit, write, bash, mem_save).
  - **Claude Code adapters** (`claude-code/superpowers-*.md`): adapted versions of canonical definitions with Claude Code tool names (Read, Grep, Glob, Edit, Write, Bash, mcp__plugin_engram_engram__mem_save). Body and frontmatter name/description are byte-identical to canonical; only the tools field is mapped.

## Installation and activation

A4S is the versioned source for these definitions. This repository change does not install or activate the Agent operating model baseline. Global activation by symlink occurs only after the pull request and requires separate authorization. The intended projections are:

```text
$PI_CODING_AGENT_DIR/AGENTS.md
  -> <checkout>/agents/common/AGENTS.md
$PI_CODING_AGENT_DIR/agents/<role-name>.md
  -> <checkout>/agents/pi/<role-name>.md

~/.claude/agents/<role-name>.md
  -> <checkout>/agents/claude/<role-name>.md
```

When `PI_CODING_AGENT_DIR` is unset, Pi's default root is `~/.pi/agent`. Pi loads `AGENTS.md` there as its root entry point and assumes the user-facing Orchestrator identity defined in that file. The six Pi role names are `explorer`, `judge`, `implementer`, `reviewer`, `debugger`, and `generalist`. The five Claude Code role names remain `explorer`, `implementer`, `reviewer`, `debugger`, and `generalist`. These projections must fail closed rather than overwrite an existing runtime file.

Static files and contract tests do not prove runtime behavior. Before an agent or skill definition is released or activated, its representative end-to-end path must invoke it through the consuming harness; focused contract tests remain supplementary evidence.

The separate Superpowers Claude Code adapters are activated via [ADR 0049](../.workspace/docs/adr/0049-superpowers-claude-code-adapters.md):

**Installation contract**: Symlinks from `~/.claude/agents/<role-name>.md` to `agents/superpowers/claude-code/<role-name>.md` in the main branch checkout. Fails closed if a target exists (no overwrites). Symlinks are reversible (removal disables the role in that installation).

The Pi Superpowers installation remains in its own control plane; this installation enables Claude Code to use Superpowers roles as orchestrator subagents.

## Ownership and license

A4S owns these definitions. The imported definitions retain the [MIT license](../LICENSES/handbook-MIT.txt) from their source repository. Consumers must independently supply compatible tools and validate execution semantics.
