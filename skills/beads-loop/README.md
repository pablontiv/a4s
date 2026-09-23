# Beads autonomous loop

`beads-loop` is an operator-facing Pi skill. Its public interface is the skill invocation; its adapter implementation is internal.

## Operator invocation

Open Pi in the target Beads repository and invoke:

```text
/skill:beads-loop
```

The skill reads and operates only on the current repository. It selects work atomically, records in-repository evidence, and stops on a terminal envelope. Do not invoke its adapter implementation directly.

## Manual safety test

Use a disposable Beads repository, never a repository containing work you intend to preserve. Load the A4S `beads-loop` skill in Pi, then invoke `/skill:beads-loop` exactly as above.

Verify that Pi:

1. reads readiness before selecting work;
2. claims only the item returned by its atomic claim;
3. records validation evidence inside the disposable repository;
4. finalizes with `pass` only after successful validation, or `fail` after a validation failure; and
5. stops when it receives a terminal envelope.

For a non-mutating dispatch check, load the skill in Pi from a disposable regular Git repository without Beads state. The skill must stop with the terminal `not_beads_repo` envelope and must not select or mutate work.

## Internal verification

Project tests exercise the adapter boundary and Pi dispatch probes directly so regressions are deterministic. Those commands are maintainer verification infrastructure, not the operator interface.
