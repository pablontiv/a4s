---
name: gpt-quota-audit
description: Investigate a quota spike on any omp provider using session token attribution, recorded quota windows, calibration, and an independent advisor panel; propose changes without applying configuration.
---

# GPT quota audit

Use when a provider's subscription quota is disappearing unexpectedly, or when comparing model routes and workflow overhead. Despite the name, the parser supports any omp provider ID.

## Inputs and command

Run from this repository with Python 3.10 or newer; the auditor uses only the standard library. Supply:

- `--provider`: exact `message.provider`, default `openai-codex`.
- `--days`: file-mtime lookback, default `3.5`.
- `--now`: optional ISO timestamp (local when no offset is supplied, or explicit `Z`/offset); defaults to the current instant. Assistant turns later than this instant are excluded.
- `--sessions-root`: default `~/.omp/agent/sessions`.
- `--db`: default `~/.omp/agent/agent.db`.
- `--limit-id`: exact `usage_history.limit_id`, default `<provider>:primary`. Inspect the provider's recorded IDs first; providers with multiple weekly/hourly limits need separate reports.
- `--out`: required Markdown output path, outside the source-data directory.

```sh
python3 skills/gpt-quota-audit/scripts/audit.py \
  --provider openai-codex --days 3.5 --out /tmp/gpt-quota-audit.md
```

The sessions and quota database are read-only inputs. The only written file is `--out`.

## Outputs and workflow

1. Generate and read the report: headline turns/Mtok; local day × model; top 15 main sessions with provider subagent-file counts; top 30 subagent files with context maxima, timestamps and assignments; tool-category split; stop reasons/errors; agent × modelRole.
2. Inspect quota windows: first, last and peak `used_fraction`, grouped by `resets_at` with ±120-second tolerance for provider timestamp jitter. The report includes readings covering the selected turns, plus the preceding reading when available. This can span more than `--days`: mtime selects files, not a timestamp window on their historical contents. Each window reports its observed average burn in percentage points/hour and the projected hours from 0% to 100% at that rate [INFERENCE]; that projection is not time remaining.
3. Read the calibration: no-intercept OLS, one regressor per observed model, on token Mtok between consecutive quota readings in the same reset window. Exact `(previous, current]` boundaries accommodate hourly polls that land off the clock hour. Real reset-spanning intervals and the initial partially observed interval are excluded. Interval starts must be at or after `now - days`: earlier history is token-incomplete because older-mtime session files are not selected. Models with no interval traffic are omitted. The report provides quota-percentage-points per 100 Mtok, approximate 95% CIs, interval n, and uncentered R². Insufficient or collinear data are reported as unavailable, rather than inventing coefficients.
4. Fill the options matrix with current settings, candidates, measured basis, side effects and defensible estimated savings. Its keys are `modelRoles.task`, `task.agentCompactionThresholdOverrides.task`, `task.maxConcurrency`, `retry.fallbackChains.*`, and `retry.usageReservePct`. Workflow improvements can be additional rows. Shared tokens are not additive savings; attributable overhead is an upper bound, not a promised reduction.
5. Obtain an explicit independent advisor panel per decision: `completion(model='slow')` plus a `reviewer` agent. Verify and record both resolved model IDs before relying on their reviews; both must be outside the provider under audit. If the configured routes use that provider, select authorised independent routes first. Give both the same decision, evidence and counter-evidence; request `adopt|reject|needs-evidence`, strongest counterargument, risk and confidence. Record results in the `decision | opus verdict | grok verdict` template, replacing labels with actual model IDs if the routes differ. The script supplies templates, not fabricated verdicts or automatic calls.
   Invoke the native OMP `task` tool with `agent=reviewer`, using the canonical A4S [reviewer definition](../../.omp/agents/reviewer.md). For a private consumer, install it in a supported [project or user agent root](../../agents/README.md#private-consumer-installation). Record the selected `agentSource` and definition path from the task transcript as well as the resolved model ID; the role name alone does not establish which definition ran.
6. Report a grounded root cause and propose options. Treat model comparisons as observational unless matched workloads establish a controlled comparison. Keep project mix, restart/rework, provider errors and cached context separate from model capability.

## Hard rules

- Select session files by `mtime >= now - days` with recursive Python glob. A selected long-lived file contributes all of its historical assistant turns through `--now`; there is no lower timestamp cutoff. Directory slugs can start with `--`, so use Python paths rather than shell option-sensitive globs.
- Filter exactly on `message.role == 'assistant'` and `message.provider == --provider`. Read `session_init.agent/modelRole/task`; parse both dictionary and JSON-string tool arguments. Parent identity comes from the first two relative path components (normalising the main `.jsonl` suffix); child files are separate agents.
- Tokens mean `input + cacheRead + cacheWrite`, excluding output. `totalTokens` is shown only as a context diagnostic. Cached input is still sent context, not automatically free quota.
- Quota truth is SQLite `usage_history`, never omp's displayed dollar estimate. Convert `used_fraction` to percentage points explicitly; coefficients are not dollars and not a direct measurement of provider internals.
- Report/propose only. Configuration or routing writes require explicit approval; this skill does not change `~/.omp/agent/config.yml`, rules, model routes or provider accounts.
- The advisor panel never uses the provider being audited. A pending template is not a completed review.
- Category labels are heuristic [INFERENCE]. Priority is text-only, wait-only, history URI, agent URI without edit/write/bash, bash sleep/poll, iOS build/E2E, then first tool name. A `write agent://` call therefore remains `write` unless an earlier category matches.

## Interpretation caveats

A `resets_at` change beyond the 120-second jitter tolerance can mean an early subscription renewal or replacement, not exhaustion. In the reference investigation, the observed windows ended at 0.37 and 0.55; omp had no evidence of a recorded 1.0. omp polls approximately hourly, and its recorded Codex primary series does not expose a Codex 5-hour window. The ChatGPT-side quota view may therefore describe a limit absent from this database.

Calibration intervals can include other clients' consumption, reporting delay and rounded fractions. Output and cache pricing can affect quota even though the chosen context metric excludes output. An attractive regression coefficient is not a causal per-model quota tariff. Inspect n, confidence intervals, reset transitions, and model/project correlation before recommending a model change. Negative deltas inside an unchanged reset window remain visible in OLS rather than being silently discarded.

A historical `--now` reproduces turn timestamps, not historical mtimes: later appends can bring additional old files into the selection. Host timezone controls local-day grouping and naive `--now`; use an explicit offset when moving the reproduction between hosts.

## Regression anchor: 2026-10-17 21:27 local

```sh
python3 skills/gpt-quota-audit/scripts/audit.py \
  --provider openai-codex --days 3.5 --now 2026-10-17T21:27:00 \
  --out /tmp/audit.md
python3 -m pytest skills/gpt-quota-audit/scripts -q
```

Reference snapshot: 48,999 assistant turns across providers and 1,220 `session_init` files. Provider-filtered anchors (rounded Mtok):

| Measure | Turns | Mtok |
| --- | --- | --- |
| All `openai-codex` | 31,601 | 2,517 |
| `agent=task`, `modelRole=task` | 29,270 | 2,364 |
| antojea main `2026-10-13T22-25-50-100Z_01a1375f-3a14-774b-a49e-4da7add166a9` | 8,976 | 876 |
| a4s main `2026-10-16T17-08-31-747Z_01a145af-cd83-77cf-a203-d74d9238549c` | 4,816 | 292 |
| Local 2026-10-15, `gpt-5.6-sol` | 12,120 | 1,135 |
| Wait-only | 1,521 | 161 |

Antojea and a4s respectively had 163 and 240 GPT child files. Compare tokens/turns against this snapshot within 1%, accounting explicitly for later mtime changes; fix actual parser/filter errors rather than adjusting measurements to fit. The fixture tests use three JSONL files and ten quota rows with a reset, and validate known independent OLS coefficients. Current runs naturally change these numbers.
