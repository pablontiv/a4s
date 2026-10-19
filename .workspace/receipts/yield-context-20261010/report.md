# Retrospective persistence and context probe

Window: **2026-09-20T01:42:10+00:00 ≤ event timestamp < 2026-10-11T01:42:10+00:00** (21 rolling days).
Scope: all locally recorded projects, Pi + Claude Code + Codex. Current analysis stream and verified Pi faux test-model responses excluded; fixture sources remain auditable in excluded-fixtures.csv. No fetch, push, or source mutation.

## Findings

- 435 active file streams (197 Pi, 194 Claude, 44 Codex) and 42,650 inference steps were observed in the rolling 21-day window.
- 364 verified Pi faux-provider test sources were excluded from operational cohorts. Their definitions are in `/Users/Shared/vendor/pi/packages/coding-agent/test/test-harness.ts:48` and `test/suite/agent-session-runtime.test.ts:50-51`; these are simulated responses, not actual model inference.
- The exact-line matching proxy found 188,944 retained characters, including 140,398 currently retained characters at least seven days old.
- Filename-based artifact categories: 147,676 characters in Markdown documentation, 18,031 in test-named files, and 23,237 in other code/configuration. Persistence alone does not demonstrate utility.
- Only 11.2% of identified successful-write characters have blame-readable file coverage and a snapshot tip at/after the write. Unobserved or unparsed writes are not evidence of waste.
- Three exploratory decline candidates span only two independent observed families: one Pi root stream and two Claude child streams of the same parent. No calibrated per-model compaction threshold can be supported.
- Proxy percentages are descriptive only. They cannot rank harnesses or strategies given unequal observation, missing shell writes, local reference staleness, and incomplete Pi/Codex family linkage. Codex zero matched characters must not be interpreted as zero delivered value.
- Eighteen Claude parent-child families can be explicitly grouped. Historical S1-S4 and the four-form model are reported separately without altering the existing classifier.

## Method and interpretation

- Canonical mtime discovery preserved, followed by event-level rolling-window restriction. File streams are not necessarily independent user sessions. Existing scenario classifier is reused unchanged; its signals cover the whole recorded stream, not just this time slice.
- An inference step is one assistant response in Pi/Claude; Codex uses per-response token_usage_record when present, otherwise last_token_usage events. This is not a user-turn count.
- Denominator: observable assistant text, visible thinking, and tool-argument characters; normalized compact JSON for Pi/Claude arguments and original call source for Codex. Hidden/encrypted reasoning is unavailable. This is NOT total model-output yield and is not directly comparable across harnesses.
- Attempted write characters: Write content, Edit replacement text, and literal apply_patch added lines. Arbitrary shell/programmatic writes are NOT reconstructed. Failed writes are excluded from persistence matching; unknown tool results are not assumed successful.
- Numerator: exact added/replacement lines (minimum 16 non-whitespace characters), on a locally available default-branch snapshot, whose blame commit is within the window and at/after a successful tool call. Pre-existing blamed lines are excluded. Repeated lines across different streams are marked ambiguous, never credited twice. Within one stream, credit goes to the last eligible write. This is a conservative proxy, not proof of authorship or accepted utility.
- Mature numerator: those currently surviving lines with blame origin at least seven days old. Recent changes are immature, not failed. Local default-branch reachability does not prove deployment/acceptance or live remote state. Ref tips are recorded in summary.json.
- Topology uses the existing four-form classifier, keeping historical S1-S4 separate. Claude/Codex cannot identify all four forms with existing instrumentation. families.csv merges Claude child streams using explicit parent-directory lineage. Pi/Codex cross-session family linkage remains incomplete; no temporal-overlap heuristic is used.
- Context candidates: solo streams only. Window=10 inference steps; marginal rate=persisted characters / observable output characters. Baseline=first window with ≥3 successfully mutated, blame-observable file steps with snapshot tip at/after the write and ≥100 matched characters. Require at least 80% observable written-character coverage and three successive eligible windows below one third of baseline. Reset across model/compaction boundaries; exploration-only windows are skipped. Delegating streams require verified child-value attribution and are excluded from this detector.
- Overlapping windows are correlated. These are exploratory candidates, not calibrated compaction thresholds or causal evidence. Medians are withheld for fewer than five independent candidate families. No thresholds are installed.

## Coverage

Active file streams: 435; inference steps: 42,650; output characters observed: 41,464,200.
Git-blame observable, snapshot-covered successful-write characters: 478,104 / 4,260,816. Possible shell/programmatic mutation calls not reconstructed: 2,321.
Single-source retained characters: 188,944; ≥7-day retained: 140,398; ambiguous retained: 196.

## Harness × scenario (observational; not a ranking)

| Harness | Form | Streams | Steps | Output chars | Matched chars | ≥7 days chars | Proxy yield |
|---|---|---:|---:|---:|---:|---:|---:|
| claude | form-orch-hybrid | 20 | 2877 | 3,961,707 | 23,416 | 8,146 | 0.591% |
| claude | form-solo | 174 | 4612 | 4,102,008 | 28,839 | 0 | 0.703% |
| codex | form-orch-hybrid | 2 | 354 | 556,297 | 0 | 0 | 0.000% |
| codex | form-solo | 42 | 1108 | 1,053,192 | 0 | 0 | 0.000% |
| pi | form-cross-session | 0 | 0 | 0 | 0 | 0 | N/A |
| pi | form-delegator-pure | 0 | 0 | 0 | 0 | 0 | N/A |
| pi | form-orch-hybrid | 112 | 29148 | 27,732,272 | 128,846 | 124,465 | 0.465% |
| pi | form-solo | 85 | 4551 | 4,058,724 | 7,843 | 7,787 | 0.193% |

## Claude family-level aggregation (explicit parent-child links only)

| Root form | Families | Member streams | Output chars | Matched chars |
|---|---:|---:|---:|---:|
| form-orch-hybrid | 18 | 185 | 7,841,568 | 52,255 |
| form-solo | 9 | 9 | 222,147 | 0 |

Pi and Codex family linkage is incomplete; no comparable family-level ranking is made.

## Historical scenarios (separate taxonomy)

S1=no delegation/coordination signals; S2=delegation only; S3=coordination only; S4=both. This table does not establish complete family attribution.

| Harness | Scenario | Streams | Output chars | Matched chars | Proxy yield |
|---|---|---:|---:|---:|---:|
| claude | S1 | 174 | 4,102,008 | 28,839 | 0.703% |
| claude | S2 | 20 | 3,961,707 | 23,416 | 0.591% |
| codex | S1 | 42 | 1,053,192 | 0 | 0.000% |
| codex | S2 | 2 | 556,297 | 0 | 0.000% |
| pi | S1 | 67 | 2,958,159 | 6,229 | 0.211% |
| pi | S2 | 52 | 8,848,773 | 74,240 | 0.839% |
| pi | S3 | 18 | 1,100,565 | 1,614 | 0.147% |
| pi | S4 | 60 | 18,883,499 | 54,606 | 0.289% |

## Candidate context decline by model

| Harness | Model | Steps with context | Median context | Candidate streams | Median candidate context (n≥5) |
|---|---|---:|---:|---:|---:|
| claude | claude-fable-5-1 | 5 | 58526 | 0 | N/A |
| claude | claude-haiku-4-5-20251001 | 3981 | 45737 | 2 | N/A |
| claude | claude-haiku-5-5 | 3 | 19044 | 0 | N/A |
| claude | claude-opus-4-8 | 2018 | 196178.0 | 0 | N/A |
| claude | claude-opus-5-5 | 1303 | 184892 | 0 | N/A |
| claude | claude-sonnet-4-6 | 12 | 60683.5 | 0 | N/A |
| claude | claude-sonnet-5 | 96 | 72130.0 | 0 | N/A |
| claude | claude-sonnet-5-5 | 71 | 31211 | 0 | N/A |
| codex | gpt-5.6-luna | 518 | 139618.5 | 0 | N/A |
| codex | gpt-5.6-sol | 287 | 66922 | 0 | N/A |
| codex | gpt-5.6-terra | 7 | 40929 | 0 | N/A |
| codex | gpt-6-astra | 276 | 92960.0 | 0 | N/A |
| codex | gpt-6.1-sol | 368 | 111391.0 | 0 | N/A |
| pi | MiniMax-M3 | 147 | 112410 | 0 | N/A |
| pi | adaptive | 0 | N/A | 0 | N/A |
| pi | claude-fable-5.1 | 51 | 156140 | 0 | N/A |
| pi | claude-opus-4.8 | 0 | N/A | 0 | N/A |
| pi | claude-opus-5 | 0 | N/A | 0 | N/A |
| pi | claude-opus-5.5 | 0 | N/A | 0 | N/A |
| pi | deepseek-v4-1-flash-high | 33 | 55040 | 0 | N/A |
| pi | fusion-claude-fable-5-1-medium-sidekick-gpt-5-6-luna-high | 0 | N/A | 0 | N/A |
| pi | glm-5.3 | 147 | 97320 | 0 | N/A |
| pi | gpt-5.5 | 177 | 51550 | 0 | N/A |
| pi | gpt-5.6-luna | 1 | 983 | 0 | N/A |
| pi | gpt-5.6-sol | 24695 | 123239 | 0 | N/A |
| pi | gpt-5.6-terra | 5587 | 164135 | 1 | N/A |
| pi | gpt-6-astra | 154 | 104806.5 | 0 | N/A |
| pi | gpt-6-sol | 438 | 102680.0 | 0 | N/A |
| pi | grok-4.5 | 0 | N/A | 0 | N/A |
| pi | grok-4.6 | 296 | 96254.5 | 0 | N/A |
| pi | grok-4.7 | 67 | 96742 | 0 | N/A |
| pi | k3 | 862 | 201825.0 | 0 | N/A |
| pi | subscription-economy | 0 | N/A | 0 | N/A |
| pi | swe-2 | 121 | 66085 | 0 | N/A |
| pi | swe-2-high | 17 | 146446 | 0 | N/A |

## Window sensitivity

{
  "10": {
    "candidates": 3,
    "median_context": 136221
  },
  "20": {
    "candidates": 3,
    "median_context": 136221
  },
  "5": {
    "candidates": 1,
    "median_context": 137100
  }
}

## Diagnostics

```json
{
  "pi_candidate_files": 619,
  "duplicate_assistant_records": 1232,
  "unparsed_edit_hunks": 2,
  "excluded_verified_fixture_steps": 457,
  "claude_candidate_files": 280,
  "copied_claude_responses": 1,
  "duplicate_assistant_blocks": 667,
  "excluded_synthetic_responses": 15,
  "codex_candidate_files": 48,
  "encrypted_reasoning_items": 1305,
  "excluded_current_stream": 1,
  "excluded_verified_fixture_streams": 364,
  "edit_success": 4202,
  "edit_failed": 194,
  "edit_unknown": 3,
  "edits_without_git": 1036,
  "files_absent_or_blame_failed": 726,
  "files_blame_read": 181,
  "ambiguous_retained_chars": 196,
  "edits_with_blame_observable": 839,
  "edits_with_snapshot_covering_write": 805
}
```

## Files

- excluded-fixtures.csv: verified Pi faux-provider test transcripts excluded from operational cohorts.
- families.csv: explicitly linked Claude families; unlinked streams remain separate.
- legacy-scenarios.csv: historical S1-S4 aggregations, never relabeled as four forms.
- streams.csv: scenario and per-stream numerator/denominator.
- turns.csv: context, output, mutation signals, and retained characters per inference step.
- line-evidence.csv: content hashes and blame provenance, without raw file content.
- candidates.csv: decline points, baseline, and observed window rate.
- models.csv: context coverage and candidate medians.
- curves.html: top matched streams, context versus cumulative matched characters; ordered paths preserve temporal traversal.
- summary.json: exact reference snapshots and diagnostics.
