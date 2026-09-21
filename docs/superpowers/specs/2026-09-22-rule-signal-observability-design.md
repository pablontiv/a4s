# Rule-signal observability: minimal empty-state diagnosis

**Status:** proposed
**Date:** 2026-09-22
**Package:** `@a4s/pi-rule-compiler`

## Intent

When `/rules-review` has no stored rule proposals after a successful compaction, users must be able to distinguish:

1. no session message was eligible to be evaluated as a rule source;
2. eligible messages were evaluated but no `RuleSignal` passed the existing conservative filter; or
3. signals exist but retro synthesis has not yet stored a proposal.

The feature must not weaken rule-selection thresholds, invoke an additional model, create a new command, persist new data, expose message content, or change compaction and retro behavior.

## Existing evidence and constraints

`RuleSignalBatch` entries are already stored on the active Pi conversation branch as custom entries of type `a4s.pi-rule-compiler.rule-signals.v2`. A batch is first embedded in successful compaction details and is later published after `session_compact`; recovery reconstructs it from the compaction entry when necessary.

Each batch already includes:

- `provenance.compactionAttemptId`, `windowIndex`, and `windowCount`;
- `provenance.sanitizedExcerpts`, containing each fitted message's role and sanitized excerpt;
- `signals`, the selected `RuleSignal` records.

The current candidate-pool criterion is exactly:

```text
message.excerpt.trim().length > 0
&& (message.role === "user" || message.role === "custom")
```

Tool output, shell output, assistant messages, and summaries are intentionally excluded from the candidate pool. This trust boundary remains unchanged.

Large compactations may produce multiple chronological batches with the same `compactionAttemptId`. The diagnostic therefore must aggregate all windows of the latest attempt, not inspect only the last window.

## Design

### Derive, do not persist

Add no schema field and no custom entry. Derive the diagnostic on demand from existing `RuleSignalBatch` data:

1. collect batches from the active conversation branch;
2. locate the latest batch in branch order and take its `compactionAttemptId`;
3. select every batch with that attempt ID;
4. count eligible candidates by filtering `provenance.sanitizedExcerpts` with the established candidate-pool criterion;
5. sum `signals.length` across the selected batches.

The calculation uses roles and sanitized excerpts already persisted by the extension. It must never include an excerpt, raw message text, score, model response, token count, digest, or credential in user-visible output.

### Extend only the empty proposal view

Keep existing proposal listing behavior unchanged when one or more stored proposals exist.

When `/rules-review` finds no proposals, render one of these states:

| Condition | User-visible result |
|---|---|
| No valid signal batches exist | `No stored rule proposals or rule observations. Run a successful compaction.` |
| Latest attempt has zero eligible candidates | `Latest compaction: no non-empty user or custom messages were eligible as rule sources.` |
| Latest attempt has one or more eligible candidates and zero selected signals | `Latest compaction: evaluated N rule candidate(s); none passed the conservative filter.` |
| Latest attempt has one or more selected signals | `Latest compaction: recorded N RuleSignal(s), but no rule proposal is stored. Run /retro-rules to retry retro processing.` |

Use pluralization suitable for the existing English command surface. The renderer must not claim that a candidate was a durable rule; it only reports that it was eligible for evaluation.

### Compatibility and failure behavior

- Existing `a4s.pi-rule-compiler.rule-signals.v2` entries remain the sole data source.
- No migration, schema revision, persistence location, or state write is introduced.
- Invalid custom entries continue to be ignored by existing storage parsing.
- If no valid batches can be read, return the new no-observation state rather than throwing.
- The diagnostic is read-only and must not trigger Jev, the current model, retro synthesis, retries, or compaction.
- `/retro-rules` remains an idempotent retry/recovery command; it does not manufacture signals.

## Components

| Component | Responsibility |
|---|---|
| `src/extension.ts` | Derive latest-attempt observation state and select the empty-state text from `renderProposalList`. |
| Existing storage collector | Supply validated `RuleSignalBatch` values from the active branch. No storage change. |
| `test/extension.test.ts` and/or focused command-render tests | Verify command-visible diagnostics through the registered `/rules-review` path. |
| `test/signals.test.ts` or a focused pure helper test | Verify candidate eligibility uses the same non-empty `user`/`custom` criterion and aggregates all windows in an attempt. |

A small pure helper should own grouping and counting so rendering does not duplicate the authority criterion or depend on entry shape directly.

## Test matrix

1. No proposal and no valid batches renders the no-observation state.
2. A latest attempt containing only `toolResult` and `bashExecution` messages renders zero eligible candidates, even when the batch itself has no signals.
3. A latest attempt with non-empty `user` or `custom` messages and no selected signals renders the filtered-candidate state.
4. A latest attempt with selected signals and no stored proposal renders the retry guidance.
5. Multiple batches sharing the latest `compactionAttemptId` aggregate candidate and signal totals; batches from earlier attempts do not contribute.
6. Stored proposals preserve the current list output and suppress the diagnostic.
7. Rendered diagnostics contain no sanitized excerpts, raw contents, digests, scores, model data, or credentials.
8. Invalid stored entries do not crash `/rules-review`.

## Out of scope

- Per-threshold rejection reasons, individual candidate scores, or candidate excerpts.
- A `/rules-signals` command.
- Schema v3 or a new custom-entry type.
- Changing `DEFAULT_RULE_SIGNAL_THRESHOLDS` or the trusted-role policy.
- Automatic rule activation, Rootline writes, AGENTS.md updates, or repository changes.
- Cross-session, cross-user, or Git-backed sharing of diagnostics.

## Acceptance criteria

After a compacted session with no proposals, `/rules-review` unambiguously reports whether the latest compaction had no eligible `user`/`custom` sources, filtered all eligible candidates, or retained signals awaiting retro. The command remains read-only, uses only existing session-local data, and does not expose message contents or alter the normal compaction/retro lifecycle.
