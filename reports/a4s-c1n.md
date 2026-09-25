# a4s-c1n — Superpowers roles as Claude Code subagents

- **Bead:** `a4s-c1n`
- **Candidate SHA:** `342d298e78e4efcae6c9513ad069a69572a01ee6`
- **Verdict:** pass (pre-review). The head-SHA review verdict, ci-local result, merge, symlink installation, and reload verification are appended to the Bead notes at closure.

## Delivered

- `.workspace/docs/adr/0049-superpowers-claude-code-adapters.md`: created with `adr.sh` and accepted. It supersedes the Pi-only, unmerged design on `feat/superpowers-subagents-install` (`a027127`, whose ADR number 0028 collides with main).
- `agents/superpowers/claude-code/`: six adapters. Name and description equal the canonical files. Tools are mapped: read→Read, grep→Grep, find→Glob, edit→Edit, write→Write, bash→Bash, mem_save→mcp__plugin_engram_engram__mem_save. Bodies are byte-identical.
- `test/test_superpowers_claude_code_agents.py`: 5 tests covering the exact set, name/description, tool mapping, and body identity.
- `agents/README.md`: documents the canonical definitions, the adapters, and the install contract.

## Acceptance (pre-merge)

| Criterion | Result |
|---|---|
| ADR 0049 accepted, rootline clean | PASS: 144/144 valid (implementer) |
| Adapters exist; test verifies identity and mapping and fails on divergence | PASS: 5/5 via `unittest discover`. The controller's negative check appended text to the `superpowers-debugger` adapter body in a throwaway copy, and `test_adapter_bodies_byte_identical_to_canonical` FAILED |
| ci-local.sh green | PASS on the implementer run (19/19); the head result is in the Bead notes |
| Symlinks and reload visibility | Post-merge, recorded in the Bead notes |

## Invariants

- The canonical `agents/superpowers/*.md` files and `provenance.json` are untouched.
- The main checkout stayed clean during implementation.

## Process disclosure

- Bootstrap: the Superpowers roles did not yet exist in Claude Code. The implementer was a `general-purpose` subagent whose prompt embedded the verbatim `superpowers-integration-worker` role.
- Implementer report: `.superpowers/roadmap/reports/a4s-c1n-implementer.md` (ignored path).
- Known LOW: Pyright flags `map_tools(canonical_tools_str)` at line 116 (the argument is typed as object and passed where str is expected). Runtime is unaffected.

## External effect (operator-authorized 2026-09-24)

After merge, create exactly six new symlinks `~/.claude/agents/<role>.md` pointing to `[REDACTED:shared-root]/harness/a4s/agents/superpowers/claude-code/<role>.md`. Fail closed if any target exists.
