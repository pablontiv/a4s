# Retrospective persistence and context probe

Window: **2026-05-11T01:42:10+00:00 ≤ event timestamp < 2026-10-11T01:42:10+00:00** (five calendar months).
Scope: all locally recorded projects, Pi + Claude Code + Codex. Current analysis stream and verified Pi faux test-model responses excluded; fixture sources remain auditable in excluded-fixtures.csv. No fetch, push, or source mutation.

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

Active file streams: 3897; inference steps: 192,554; output characters observed: 193,064,441.
Git-blame observable, snapshot-covered successful-write characters: 3,829,758 / 33,182,180. Possible shell/programmatic mutation calls not reconstructed: 13,755.
Single-source retained characters: 2,548,486; ≥7-day retained: 2,499,785; ambiguous retained: 3,892.

## Harness × scenario (observational; not a ranking)

| Harness | Form | Streams | Steps | Output chars | Matched chars | ≥7 days chars | Proxy yield |
|---|---|---:|---:|---:|---:|---:|---:|
| claude | form-orch-hybrid | 30 | 6612 | 5,785,909 | 25,211 | 9,941 | 0.436% |
| claude | form-solo | 733 | 24605 | 18,088,592 | 244,736 | 215,897 | 1.353% |
| codex | form-orch-hybrid | 83 | 5832 | 5,584,354 | 11,902 | 11,902 | 0.213% |
| codex | form-solo | 960 | 23595 | 24,501,122 | 45,404 | 45,404 | 0.185% |
| pi | form-cross-session | 0 | 0 | 0 | 0 | 0 | N/A |
| pi | form-delegator-pure | 4 | 72 | 62,018 | 0 | 0 | 0.000% |
| pi | form-orch-hybrid | 381 | 85613 | 81,245,461 | 1,821,855 | 1,817,319 | 2.242% |
| pi | form-solo | 1706 | 46225 | 57,796,985 | 399,378 | 399,322 | 0.691% |

## Historical scenarios (separate taxonomy)

S1=no delegation/coordination signals; S2=delegation only; S3=coordination only; S4=both. This table does not establish complete family attribution.

| Harness | Scenario | Streams | Output chars | Matched chars | Proxy yield |
|---|---|---:|---:|---:|---:|
| claude | S1 | 733 | 18,088,592 | 244,736 | 1.353% |
| claude | S2 | 30 | 5,785,909 | 25,211 | 0.436% |
| codex | S1 | 960 | 24,501,122 | 45,404 | 0.185% |
| codex | S2 | 83 | 5,584,354 | 11,902 | 0.213% |
| pi | S1 | 1512 | 51,080,413 | 377,957 | 0.740% |
| pi | S2 | 173 | 27,526,727 | 1,117,895 | 4.061% |
| pi | S3 | 194 | 6,716,572 | 21,421 | 0.319% |
| pi | S4 | 212 | 53,780,752 | 703,960 | 1.309% |

## Candidate context decline by model

| Harness | Model | Steps with context | Median context | Candidate streams | Median candidate context (n≥5) |
|---|---|---:|---:|---:|---:|
| claude | claude-fable-5-1 | 2636 | 129268.5 | 0 | None |
| claude | claude-haiku-4-5-20251001 | 4102 | 45814.5 | 2 | None |
| claude | claude-haiku-5-5 | 3 | 19044 | 0 | None |
| claude | claude-opus-4-8 | 5868 | 170217.5 | 4 | None |
| claude | claude-opus-5 | 2544 | 125547.5 | 0 | None |
| claude | claude-opus-5-5 | 1303 | 184892 | 0 | None |
| claude | claude-sonnet-4-6 | 71 | 51081 | 0 | None |
| claude | claude-sonnet-5 | 14619 | 152350 | 0 | None |
| claude | claude-sonnet-5-5 | 71 | 31211 | 0 | None |
| codex | codex-auto-review | 259 | 34862 | 0 | None |
| codex | gpt-5.5 | 64 | 71160.0 | 0 | None |
| codex | gpt-5.6-luna | 1321 | 140083 | 0 | None |
| codex | gpt-5.6-sol | 17777 | 80921 | 0 | None |
| codex | gpt-5.6-terra | 873 | 76969 | 0 | None |
| codex | gpt-6-astra | 8659 | 137153 | 1 | None |
| codex | gpt-6.1-sol | 368 | 111391.0 | 0 | None |
| codex | unknown | 1 | 241855 | 0 | None |
| pi | MiniMax-M3 | 8477 | 92306 | 1 | None |
| pi | adaptive | 0 | None | 0 | None |
| pi | bengalfox | 0 | None | 0 | None |
| pi | claude-fable-5 | 562 | 42907.5 | 0 | None |
| pi | claude-fable-5.1 | 51 | 156140 | 0 | None |
| pi | claude-haiku-4-5 | 2 | 5637.5 | 0 | None |
| pi | claude-opus-4-8 | 355 | 68594 | 0 | None |
| pi | claude-opus-4.8 | 0 | None | 0 | None |
| pi | claude-opus-5 | 490 | 94107.0 | 0 | None |
| pi | claude-opus-5.5 | 0 | None | 0 | None |
| pi | claude-sonnet-4-5 | 242 | 73553.0 | 0 | None |
| pi | claude-sonnet-4-6 | 636 | 39295.0 | 0 | None |
| pi | claude-sonnet-4.6 | 2 | 5594.5 | 0 | None |
| pi | claude-sonnet-5 | 1506 | 47397.0 | 0 | None |
| pi | deepseek-v4-1-flash-high | 33 | 55040 | 0 | None |
| pi | deepseek-v4-flash | 185 | 37576 | 0 | None |
| pi | fusion-claude-fable-5-1-medium-sidekick-gpt-5-6-luna-high | 0 | None | 0 | None |
| pi | gemini-2.5-pro | 18 | 14809.5 | 0 | None |
| pi | gemini-3.1-pro-preview | 68 | 13747.5 | 0 | None |
| pi | gemini-3.5-flash | 0 | None | 0 | None |
| pi | gemini-3.7-flash | 14 | 30237.5 | 0 | None |
| pi | glm-5.1 | 29 | 28476 | 0 | None |
| pi | glm-5.3 | 147 | 97320 | 0 | None |
| pi | gpt-4.1-mini | 0 | None | 0 | None |
| pi | gpt-5-mini | 3 | 8087 | 0 | None |
| pi | gpt-5.3-codex | 26 | 92924.0 | 0 | None |
| pi | gpt-5.3-codex-spark | 194 | 33647.5 | 0 | None |
| pi | gpt-5.4-mini | 5 | 8087 | 0 | None |
| pi | gpt-5.4-nano | 0 | None | 0 | None |
| pi | gpt-5.5 | 12783 | 90860 | 0 | None |
| pi | gpt-5.6-luna | 3049 | 71110 | 4 | None |
| pi | gpt-5.6-sol | 75875 | 137167 | 1 | None |
| pi | gpt-5.6-terra | 11116 | 194121.5 | 1 | None |
| pi | gpt-6-astra | 5037 | 192784 | 0 | None |
| pi | gpt-6-sol | 438 | 102680.0 | 0 | None |
| pi | grok-4.5 | 736 | 292934.5 | 0 | None |
| pi | grok-4.6 | 1796 | 142533.0 | 1 | None |
| pi | grok-4.7 | 67 | 96742 | 0 | None |
| pi | k3 | 3011 | 122171 | 2 | None |
| pi | kimi-for-coding | 396 | 149371.5 | 0 | None |
| pi | kimi-k2.6 | 512 | 35758.0 | 0 | None |
| pi | minimax-m3 | 913 | 27717 | 0 | None |
| pi | subscription-economy | 0 | None | 0 | None |
| pi | subscription-reasoning | 0 | None | 0 | None |
| pi | subscription-swe | 0 | None | 0 | None |
| pi | swe-1.7 | 286 | 103612.0 | 0 | None |
| pi | swe-2 | 295 | 80425 | 0 | None |
| pi | swe-2-high | 17 | 146446 | 0 | None |
| pi | test-devin | 0 | None | 0 | None |
| pi | test-xai | 0 | None | 0 | None |

## Window sensitivity

{
  "20": {
    "candidates": 14,
    "median_context": 217351.5
  },
  "5": {
    "candidates": 9,
    "median_context": 137100
  },
  "10": {
    "candidates": 17,
    "median_context": 185524
  }
}

## Diagnostics

```json
{
  "known_unobservable_directories": 1,
  "pi_candidate_files": 2690,
  "unparsed_edit_hunks": 15,
  "duplicate_assistant_records": 20451,
  "excluded_verified_fixture_steps": 457,
  "claude_candidate_files": 788,
  "excluded_synthetic_responses": 56,
  "copied_claude_responses": 2,
  "duplicate_assistant_blocks": 668,
  "codex_candidate_files": 1067,
  "encrypted_reasoning_items": 26531,
  "excluded_current_stream": 1,
  "excluded_verified_fixture_streams": 364,
  "edit_success": 19471,
  "edit_failed": 1176,
  "edit_unknown": 118,
  "edits_without_git": 8326,
  "edits_unresolved_relpath": 381,
  "files_blame_read": 729,
  "files_absent_or_blame_failed": 1893,
  "ambiguous_retained_chars": 3892,
  "edits_with_blame_observable": 3728,
  "edits_with_snapshot_covering_write": 3294
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
