# Five-month numerical findings

Window: 2026-05-11T01:42:10+00:00 ≤ timestamp < 2026-10-11T01:42:10+00:00. All locally available projects in Pi, Claude Code and Codex. Same evaluation endpoint as the three-week probe.

## Requested persistence numbers

| Period | Active streams | Inference steps | Output chars observed | Retained-match chars | ≥7-day chars | Git written-char coverage |
|---|---:|---:|---:|---:|---:|---:|
| Three weeks | 435 | 42,650 | 41,464,200 | 188,944 | 140,398 | 11.22% |
| Five months | 3,897 | 192,554 | 193,064,441 | 2,548,486 | 2,499,785 | 11.54% |

## Harness totals

| Harness | Streams | Steps | Output chars | Retained chars | Proxy yield | Git written-char coverage |
|---|---:|---:|---:|---:|---:|---:|
| claude | 763 | 31,217 | 23,874,501 | 269,947 | 1.131% | 14.38% |
| codex | 1043 | 29,427 | 30,085,476 | 57,306 | 0.190% | 34.95% |
| pi | 2091 | 131,910 | 139,104,464 | 2,221,233 | 1.597% | 10.93% |
| OpenCode (indexed historical corpus) | N/A | N/A | N/A | N/A | N/A | N/A |

OpenCode and absent native-source records are not represented as zero delivery. Native yield remains unmeasured for them.

## Historical scenario breakdown

S1=no delegation/coordination signals; S2=delegation only; S3=coordination only; S4=both. This is distinct from the four-form model. Counts are source streams, not complete family-level costs.

| Harness | Scenario | Streams | Retained chars | Proxy yield | Git written-char coverage |
|---|---|---:|---:|---:|---:|
| claude | S1 | 733 | 244,736 | 1.353% | 17.27% |
| claude | S2 | 30 | 25,211 | 0.436% | 3.90% |
| codex | S1 | 960 | 45,404 | 0.185% | 32.75% |
| codex | S2 | 83 | 11,902 | 0.213% | 54.59% |
| pi | S1 | 1512 | 377,957 | 0.740% | 4.05% |
| pi | S2 | 173 | 1,117,895 | 4.061% | 32.64% |
| pi | S3 | 194 | 21,421 | 0.319% | 2.74% |
| pi | S4 | 212 | 703,960 | 1.309% | 11.94% |

## Compaction candidate numbers

Each median below is descriptive. No sample-count rule alone makes it a valid compaction policy.

| Harness | Model | Candidate streams | Observed families | Median context | Range |
|---|---|---:|---:|---:|---|
| claude | claude-haiku-4-5-20251001 | 2 | 1 | 129,868 | 123,516–136,221 |
| claude | claude-opus-4-8 | 4 | 4 | 449,948 | 287,579–645,089 |
| codex | gpt-6-astra | 1 | 1 | 196,549 | 196,549–196,549 |
| pi | MiniMax-M3 | 1 | 1 | 305,251 | 305,251–305,251 |
| pi | gpt-5.6-luna | 4 | 4 | 118,668 | 114,136–176,171 |
| pi | gpt-5.6-sol | 1 | 1 | 253,355 | 253,355–253,355 |
| pi | gpt-5.6-terra | 1 | 1 | 185,524 | 185,524–185,524 |
| pi | grok-4.6 | 1 | 1 | 222,773 | 222,773–222,773 |
| pi | k3 | 2 | 2 | 116,280 | 83,657–148,903 |

Total observed candidate families: 16. Window=10 inference steps, three successive eligible overlapping windows below one third of first productive-window yield, ≥80% observable write-character coverage. Delegating coordinator streams are excluded without complete child-value attribution.

Window sensitivity: {"20": {"candidates": 14, "median_context": 217351.5}, "5": {"candidates": 9, "median_context": 137100}, "10": {"candidates": 17, "median_context": 185524}}

## Artifact categories

Filename-based exact-match char categories: {"Markdown": 1949067, "other code/configuration": 422252, "test-named files": 177167}

## Interpretation limits

- Proxy denominator is observable text/thinking/tool-argument characters, not full hidden model output.
- Retained chars are exact-line single-source matches in local default refs, not an accepted utility score.
- Old paths and arbitrary shell writes are incompletely attributable.
- Expanding the candidate pool can turn formerly unique matches into ambiguous attribution; persistence numerators are not additive across window expansions.
- Backscroll archived records lack native context usage and may have incomplete tool input. They are included in availability census, not invented native yield or candidate calculations.
- OpenCode is present in indexed history but not supported by this three-harness native probe; yield/context candidate results for it are N/A.
- No classifier, Git ref, or compaction configuration was changed.

## Verification

Eighteen regression checks pass, including legacy JSON-string edits and malformed-edit rejection. CSV totals, line uniqueness, written-character caps and fixture exclusions were independently checked.

Full method and diagnostics: report.md. Curves: curves.html. Native evidence: line-evidence.csv and turns.csv. Monthly stratification: monthly-model-scenario-cohorts.csv. Indexed historical availability: ../yield-context-20261010/backscroll-census.json.
