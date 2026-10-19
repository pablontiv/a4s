# S2 quota versus persistence review

## Scope and conclusion

Five-month Pi records, 10 May–10 October 2026. S1/S2 use the historical signal classifier, not the four-form taxonomy. Higher observable-output yield does not establish higher useful delivery or better account-quota efficiency.

## What was actually measured

| Observable | S1 | S2 |
|---|---:|---:|
| Recorded input + output token traffic | 4,196,115,601 | 4,694,815,380 |
| Retained-match characters | 377,957 | 1,117,895 |
| Retained characters: Markdown | 140,767 | 1,073,793 |
| Retained characters: other code/configuration | 178,197 | 43,806 |
| Retained characters: test-named files | 58,993 | 296 |

- 96.05% of retained-match characters attributed to S2 are Markdown. File-type classification is lexical, not a quality/utility judgment.
- Within the same recorded model ID, `gpt-5.6-sol`, token traffic per context-observed response is approximately 116,565 in S1 versus 163,012 in S2 (+39.85%). These are input/cache plus output counters, not actual ChatGPT account quota. No time-normalized burn rate was established.

## Limitations that prevent a value ranking

- Pi orchestrator-child linkage is incomplete. Child work may be classified as S1 while its caller is S2; neither numerator nor token cost is a verified complete S2 family total.
- Recorded model IDs do not isolate billing provider/account or task difficulty. Five-month model/method cohorts are observational, not randomized comparisons.
- Git written-character coverage differs sharply: 4.05% for S1 versus 32.64% for S2. The larger S2 persistence proxy is selection-sensitive.
- Markdown is not automatically useless, and code/configuration is not automatically functional delivery. There is no accepted-outcome/utility ledger in this analysis.
- The earlier yield denominator was observable output characters. It omitted reread input/cache traffic and cannot answer whether a strategy pays back quota consumption.

## Decision supported

Do not justify more S2 delegation using the 4.06% character-yield result. Its additional quota cost has no demonstrated accepted-value payoff in this analysis. A defensible comparison requires total observed family cost per comparable accepted functional outcome, including parent and every child, plus current survival/verification of that outcome. No runtime policy or configuration was changed.

Source: token-persistence-observations.json, scenario-summary.csv, line-evidence.csv, and turns.csv. Category totals and relative token-traffic arithmetic were checked.
