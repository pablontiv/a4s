# PR-to-green-check and native-wait attribution: October 15, 21 and 22, 2026

Prepared for [a4s#563](https://github.com/pablontiv/a4s/issues/563), measured October 29, 2026. This is a finished measurement report, not a runtime timing exporter. Publication and issue creation remain Dagu-owned.

## Result

- **All 108 merged PRs are accounted for:** a4s 50/17/15 and backscroll 8/12/6 on October 15/21/22 respectively (UTC merge dates). All have a final-head successful required-check clock and matching Actions workflow. The ledger contains 192 observed heads, 183 workflow attempts and 84 force-push transitions. There are 52 equivalent-patch changed-parent rebases, one demonstrated signature-only quality correction, 22 changed-patch transitions whose rebase-resolution/quality-correction reason cannot be distinguished, and nine changed-patch transitions after failed CI whose motivation is likewise unavailable. The latter 31 have an explicit per-transition missing-reason entry rather than an invented classification.
- **The a4s October 21 gap is before the final workflow, not in its aggregate `validate` job.** Median PR→green is **851 seconds (14.1833 minutes)**, reproducing 14.18 minutes to 0.2 seconds. Median final workflow span is **241 seconds**. Their difference is **610 seconds**, versus 610.8 seconds from the issue's rounded 14.18-minus-4-minute figures (0.8-second/0.13% rounding residual). The exact median-witness PR is #506: **603 seconds before final-run creation + 0 workflow queue + 248 seconds final execution = 851 seconds**, with zero arithmetic residual. The 603-second measured head-replacement window explains 98.85% of the 610-second difference; the other 7 seconds is the difference between this witness's 248-second workflow and the independently computed 241-second workflow median, **not an extra physical latency phase**.
- **Backscroll's October 21 median is 6,902 seconds (115.0333 minutes).** The two central PRs, #220/#221, have repeated successful, equivalent-patch rebases. Their mean **6,815.5-second pre-final-run window + 0 workflow queue + 86.5 seconds final execution = 6,902 seconds**. This is head turnover/inter-run waiting, not 115 minutes of required-job execution. The inter-run windows do not establish why the coordinator waited or how long GitHub considered the PR BEHIND.
- **The reported native `await_merge` increase cannot be numerically allocated from the accessible sources.** The reported 317 − 150 = **167 seconds is a 100% residual**: historical source journals are absent from the reachable station. This is explicitly not explained by adding the 207-second `await_ci` metric. [PR #330](https://github.com/pablontiv/a4s/pull/330/files) introduced `await_ci` and `await_merge` as parallel siblings depending on `auto_merge`; both wait for merge with successful checks. Splitting the observer did not remove CI waiting from `await_merge`. Their clocks overlap, so the premise that `await_merge` necessarily should shrink is incorrect. That source-level explanation does **not** quantify the 167-second increase.

## Exact median-witness decompositions

These are decompositions of the central PR(s) in the **lead-time ordering**, not sums of unrelated medians. For an even cohort, average the two middle PRs and their corresponding components.

| Repo / day | Central PR(s) | Before final run | Created→started | Started→green | Sum / observed median | Arithmetic residual |
|---|---|---:|---:|---:|---:|---:|
| a4s / 10-15 | #160, #163 | 3.5 | 0 | 68.5 | 72 | 0 |
| a4s / 10-21 | #506 | 603 | 0 | 248 | 851 | 0 |
| a4s / 10-22 | #544 | 3 | 0 | 331 | 334 | 0 |
| backscroll / 10-15 | #183, #192 | 4 | 0 | 712.5 | 716.5 | 0 |
| backscroll / 10-21 | #220, #221 | 6,815.5 | 0 | 86.5 | 6,902 | 0 |
| backscroll / 10-22 | #231, #228 | 4 | 0 | 104.5 | 108.5 | 0 |

### What happened in a4s#506

1. PR created **23:11:07Z**; first workflow created/started **23:11:11Z**: 4 seconds dispatch.
2. [First workflow 39691736857](https://github.com/pablontiv/a4s/actions/runs/39691736857) succeeded at **23:15:23Z**: 252 seconds earlier CI.
3. Force push at **23:21:06Z** replaced the unsigned head with a GitHub-verified commit having **identical tree, identical parent and identical commit message**: 343 seconds after earlier CI finished. This is a signature/metadata quality correction, not a code-failure correction or a changed-base rebase. Its operator motivation is not exposed by the APIs.
4. [Final workflow 39692850538](https://github.com/pablontiv/a4s/actions/runs/39692850538) created/started **23:21:10Z**: 4 seconds dispatch, then 248 seconds to `validate` green at **23:25:18Z**. Merge at **23:25:21Z**: 3 seconds green→merge.

Thus the measured beyond-final-workflow interval is **4 + 252 + 343 + 4 = 603 seconds**. Do not label all 603 seconds "rebase time" or "signing execution": 252 seconds was earlier successful CI and 343 seconds was the observed intervening wait. Source commits and full SHAs appear below. Relative to October 15's median witnesses, the 779-second PR→green increase decomposes exactly into **599.5 seconds more before the final run + 179.5 seconds more final execution**.

### What happened in backscroll#220/#221

Both initial workflows and all intermediate workflows succeeded. #220 has three equivalent-patch changed-parent replacements; #221 has four. Averaging their exact, disjoint intervals gives **3.5 seconds initial dispatch + 305 seconds earlier successful workflows + 6,490.5 seconds from earlier workflow completion to the next rebase event + 16.5 seconds rebase-event→next-workflow dispatch + 86.5 seconds final workflow = 6,902 seconds**, with zero residual. This demonstrates repeated head/base turnover and long inter-run waits; the missing historical blocker/native journals prevent further attribution of the 6,490.5 seconds to behind-state residence, coordinator scheduling, or another cause. R3 applies the existing integration work to this measured sequence without claiming that a rebase itself took that long.

## Sources, clocks and unavailable data

**GitHub scope and coverage:** `gh api` search, paginated, independently for `repo:pablontiv/{a4s,backscroll} is:pr is:merged merged:YYYY-MM-DD`, cross-checked against the combined cohort search. All six ID sets matched. Use UTC dates rather than inferring a local-day cohort. For each PR, collect REST pulls, paginated issue timeline and PR commits, branch-scoped Actions runs from the PR creation date through merge, each run attempt's jobs, and all retained check runs per observed SHA (`filter=all`). GraphQL `HeadRefForcePushedEvent` supplies before/after SHAs and exact event timestamps; no event pagination was truncated. Commit files were checked against total changed-line statistics to avoid comparing only a truncated patch page. Equivalent patches compare the **complete per-file stable patch identity set**, not just the first/common version-bump file.

**Reproducible source endpoints** (replace `{repo}`, `{n}`, `{sha}`, `{run}`, `{attempt}`): [pull metadata](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request), [check runs](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference), [Actions runs](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository), [attempt jobs](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt), [timeline](https://docs.github.com/en/rest/issues/timeline#list-timeline-events-for-an-issue), and [force-push event](https://docs.github.com/en/graphql/reference/objects#headrefforcepushedevent). Raw routes: `repos/pablontiv/{repo}/pulls/{n}`, `repos/pablontiv/{repo}/issues/{n}/timeline`, `repos/pablontiv/{repo}/commits/{sha}/check-runs?filter=all`, `repos/pablontiv/{repo}/actions/runs?branch=...&created=...`, `repos/pablontiv/{repo}/actions/runs/{run}/attempts/{attempt}/jobs`.

**Selected required green:** the latest check-run ID on the final PR head, named `validate` (a4s) or `candidate` (backscroll), that completed by merge, and succeeded. This models the final-head rollup rather than an earlier obsolete head's green. Workflow execution ends at the last job completion; the requested queue clock is `created_at`→`run_started_at`. Required green can precede the end of non-required jobs, so those clocks are kept separate. **181 first attempts have zero workflow queue; two reruns have nonzero clocks because GitHub preserves the original run creation timestamp.** For a4s#465 attempt 2, the 1,614-second clock comprises 238 seconds of failed attempt 1 plus 1,376 seconds until attempt 2 started. For backscroll#188 attempt 2, 468 seconds comprises 440 seconds of failed attempt 1 plus 28 seconds until attempt 2 started. These are not pure runner queues. The rerun-request timestamp and runner-assignment timestamp are unavailable. Per-job dependency/scheduler/start delay is likewise not separable into runner queueing from these fields. No runner-capacity conclusion follows. A 3-second aggregate validation job is not a 3-second workflow.

**BEHIND/BLOCKED, for every PR:** GitHub exposes the current merge-state snapshot but does not retain a timestamped history of BEHIND/BLOCKED transitions in these timeline events. Exact durations are therefore unavailable. Each row explicitly bounds each state between zero and its entire PR lifetime. No force push proves the start or end of either state. These bounds overlap other intervals and are not added to the decomposition.

**Native Dagu, for every PR:** no corresponding October 15/21/22 `feature` `status.jsonl` is retained in reachable `$DAGU_HOME` or current primary run evidence. Available native feature history is October 27–29. `dagu history feature --limit 100` succeeded; `dagu status feature --run-id a4s-issue-323` returned exit 1 with `dag-run ID not found`. No historical station connection is configured. The source's absence is measured; its cause (retention, migration or otherwise) is unknown. Consequently **both `await_ci` and `await_merge` intervals are unavailable for each of the 108 PRs**, not zero. October 15 may predate `await_ci`, but no fabricated per-run applicability is substituted for the missing journals. GitHub green→merge cannot substitute for native step start/end. The 167-second reported median increase remains the explicit residual permitted by the issue's acceptance criteria.

**Local evidence and collection:** raw API responses, per-PR durable checkpoints, cohort audits, projection, throughput and targeted acceptance results live under `<git-dir>/dagu-feature/runs/a4s-issue-563/computations/ci-attribution/`, not in committed source. A bounded PR sample measured 5.431 seconds/PR (108 PRs projected 586.6 seconds); the 3-commit supplement sample measured 1.628 seconds (216 lookups projected 117.2 seconds). Collection ran in the background and resumed at checkpoint 35 after a transient API error; the head watcher recorded one 120-second no-progress stall. Completed shards were preserved; failed 502/422 responses were subsequently recovered, including a complete 12-file commit response. No unresolved API errors remain. These are measurement artifacts, not a new telemetry subsystem.


## Cohort medians

All durations below are seconds; dates and instants are UTC. Medians are independently computed, not additive.

| Repository / merge date | PRs | PR→green | Workflow span | Pre-final-run | Run queue | Run→green | Green→merge |
|---|---:|---:|---:|---:|---:|---:|---:|
| a4s / 2026-10-15 | 50 | 72 | 62 | 4 | 0 | 62 | 37 |
| a4s / 2026-10-21 | 17 | 851 | 241 | 603 | 0 | 241 | 19 |
| a4s / 2026-10-22 | 15 | 334 | 264 | 4 | 0 | 264 | 15 |
| backscroll / 2026-10-15 | 8 | 716.5 | 677.5 | 4.5 | 0 | 670.5 | 37.5 |
| backscroll / 2026-10-21 | 12 | 6902 | 90.5 | 6815.5 | 0 | 90.5 | 3 |
| backscroll / 2026-10-22 | 6 | 108.5 | 104.5 | 4 | 0 | 104.5 | 12.5 |

## Every merged PR

`P` = PR creation→selected final-head workflow creation; `Q` = run created→started; `X` = run started→required check green; `G→M` = required green→merge. Each PR satisfies lead = P + Q + X. `B≤` is a deliberately loose upper bound on each of BEHIND and BLOCKED duration: PR lifetime, **not measured time in either state**. Their lower bound is zero. `D` = both native Dagu intervals unavailable for the source-availability reason above; this applies individually to every row, not zero-duration waits.

| PR | Created → merged UTC | PR→green | P | Q | X | G→M | B≤ | Dagu |
|---|---|---:|---:|---:|---:|---:|---:|---|
| [a4s#137](https://github.com/pablontiv/a4s/pull/137) | 10-15 00:13:12 → 10-15 00:14:27 | 66 | 4 | 0 | 62 | 9 | 75 | D |
| [a4s#142](https://github.com/pablontiv/a4s/pull/142) | 10-15 00:47:00 → 10-15 00:48:22 | 76 | 3 | 0 | 73 | 6 | 82 | D |
| [a4s#144](https://github.com/pablontiv/a4s/pull/144) | 10-15 02:30:35 → 10-15 02:32:13 | 54 | 3 | 0 | 51 | 44 | 98 | D |
| [a4s#145](https://github.com/pablontiv/a4s/pull/145) | 10-15 02:31:46 → 10-15 02:37:09 | 312 | 250 | 0 | 62 | 11 | 323 | D |
| [a4s#148](https://github.com/pablontiv/a4s/pull/148) | 10-15 02:57:21 → 10-15 02:58:40 | 69 | 3 | 0 | 66 | 10 | 79 | D |
| [a4s#152](https://github.com/pablontiv/a4s/pull/152) | 10-15 03:21:43 → 10-15 03:23:03 | 69 | 3 | 0 | 66 | 11 | 80 | D |
| [a4s#153](https://github.com/pablontiv/a4s/pull/153) | 10-15 03:22:55 → 10-15 03:26:34 | 207 | 142 | 0 | 65 | 12 | 219 | D |
| [a4s#156](https://github.com/pablontiv/a4s/pull/156) | 10-15 04:49:23 → 10-15 04:50:46 | 74 | 4 | 0 | 70 | 9 | 83 | D |
| [a4s#158](https://github.com/pablontiv/a4s/pull/158) | 10-15 05:10:05 → 10-15 05:11:23 | 69 | 3 | 0 | 66 | 9 | 78 | D |
| [a4s#160](https://github.com/pablontiv/a4s/pull/160) | 10-15 05:50:13 → 10-15 05:51:41 | 72 | 3 | 0 | 69 | 16 | 88 | D |
| [a4s#161](https://github.com/pablontiv/a4s/pull/161) | 10-15 06:36:50 → 10-15 06:38:05 | 67 | 3 | 0 | 64 | 8 | 75 | D |
| [a4s#162](https://github.com/pablontiv/a4s/pull/162) | 10-15 07:04:28 → 10-15 07:41:33 | 2221 | 2149 | 0 | 72 | 4 | 2225 | D |
| [a4s#163](https://github.com/pablontiv/a4s/pull/163) | 10-15 08:18:16 → 10-15 08:20:03 | 72 | 4 | 0 | 68 | 35 | 107 | D |
| [a4s#164](https://github.com/pablontiv/a4s/pull/164) | 10-15 13:04:19 → 10-15 13:46:12 | 2472 | 2412 | 0 | 60 | 41 | 2513 | D |
| [a4s#165](https://github.com/pablontiv/a4s/pull/165) | 10-15 13:51:46 → 10-15 13:53:21 | 58 | 3 | 0 | 55 | 37 | 95 | D |
| [a4s#170](https://github.com/pablontiv/a4s/pull/170) | 10-15 14:04:34 → 10-15 14:06:38 | 70 | 4 | 0 | 66 | 54 | 124 | D |
| [a4s#172](https://github.com/pablontiv/a4s/pull/172) | 10-15 14:09:11 → 10-15 14:11:30 | 73 | 3 | 0 | 70 | 66 | 139 | D |
| [a4s#173](https://github.com/pablontiv/a4s/pull/173) | 10-15 14:11:01 → 10-15 14:19:14 | 447 | 378 | 0 | 69 | 46 | 493 | D |
| [a4s#174](https://github.com/pablontiv/a4s/pull/174) | 10-15 14:12:43 → 10-15 14:15:01 | 78 | 6 | 0 | 72 | 60 | 138 | D |
| [a4s#177](https://github.com/pablontiv/a4s/pull/177) | 10-15 14:50:25 → 10-15 14:52:30 | 74 | 4 | 0 | 70 | 51 | 125 | D |
| [a4s#178](https://github.com/pablontiv/a4s/pull/178) | 10-15 15:04:28 → 10-15 15:11:07 | 347 | 275 | 0 | 72 | 52 | 399 | D |
| [a4s#179](https://github.com/pablontiv/a4s/pull/179) | 10-15 15:10:03 → 10-15 15:41:05 | 1801 | 1730 | 0 | 71 | 61 | 1862 | D |
| [a4s#181](https://github.com/pablontiv/a4s/pull/181) | 10-15 15:16:16 → 10-15 15:18:47 | 65 | 4 | 0 | 61 | 86 | 151 | D |
| [a4s#183](https://github.com/pablontiv/a4s/pull/183) | 10-15 15:25:01 → 10-15 15:26:34 | 71 | 4 | 0 | 67 | 22 | 93 | D |
| [a4s#184](https://github.com/pablontiv/a4s/pull/184) | 10-15 15:28:24 → 10-15 15:30:12 | 65 | 3 | 0 | 62 | 43 | 108 | D |
| [a4s#186](https://github.com/pablontiv/a4s/pull/186) | 10-15 15:51:34 → 10-15 15:53:24 | 72 | 4 | 0 | 68 | 38 | 110 | D |
| [a4s#190](https://github.com/pablontiv/a4s/pull/190) | 10-15 16:06:22 → 10-15 16:08:02 | 78 | 4 | 0 | 74 | 22 | 100 | D |
| [a4s#192](https://github.com/pablontiv/a4s/pull/192) | 10-15 16:19:57 → 10-15 16:21:51 | 59 | 4 | 0 | 55 | 55 | 114 | D |
| [a4s#194](https://github.com/pablontiv/a4s/pull/194) | 10-15 16:29:05 → 10-15 16:31:15 | 68 | 4 | 0 | 64 | 62 | 130 | D |
| [a4s#195](https://github.com/pablontiv/a4s/pull/195) | 10-15 16:31:43 → 10-15 16:34:28 | 157 | 101 | 0 | 56 | 8 | 165 | D |
| [a4s#196](https://github.com/pablontiv/a4s/pull/196) | 10-15 16:34:43 → 10-15 16:37:18 | 131 | 87 | 0 | 44 | 24 | 155 | D |
| [a4s#198](https://github.com/pablontiv/a4s/pull/198) | 10-15 17:29:42 → 10-15 17:32:10 | 64 | 4 | 0 | 60 | 84 | 148 | D |
| [a4s#200](https://github.com/pablontiv/a4s/pull/200) | 10-15 17:41:40 → 10-15 17:43:27 | 56 | 3 | 0 | 53 | 51 | 107 | D |
| [a4s#206](https://github.com/pablontiv/a4s/pull/206) | 10-15 17:58:58 → 10-15 18:01:00 | 61 | 3 | 0 | 58 | 61 | 122 | D |
| [a4s#207](https://github.com/pablontiv/a4s/pull/207) | 10-15 18:02:18 → 10-15 18:07:26 | 242 | 187 | 0 | 55 | 66 | 308 | D |
| [a4s#210](https://github.com/pablontiv/a4s/pull/210) | 10-15 18:03:51 → 10-15 19:07:12 | 3748 | 3692 | 0 | 56 | 53 | 3801 | D |
| [a4s#213](https://github.com/pablontiv/a4s/pull/213) | 10-15 18:06:29 → 10-15 18:11:22 | 281 | 235 | 0 | 46 | 12 | 293 | D |
| [a4s#217](https://github.com/pablontiv/a4s/pull/217) | 10-15 18:18:32 → 10-15 18:20:13 | 61 | 3 | 0 | 58 | 40 | 101 | D |
| [a4s#218](https://github.com/pablontiv/a4s/pull/218) | 10-15 18:20:09 → 10-15 18:48:58 | 1717 | 1656 | 0 | 61 | 12 | 1729 | D |
| [a4s#219](https://github.com/pablontiv/a4s/pull/219) | 10-15 18:21:35 → 10-15 19:25:17 | 3785 | 3738 | 0 | 47 | 37 | 3822 | D |
| [a4s#224](https://github.com/pablontiv/a4s/pull/224) | 10-15 18:53:14 → 10-15 18:54:35 | 62 | 3 | 0 | 59 | 19 | 81 | D |
| [a4s#229](https://github.com/pablontiv/a4s/pull/229) | 10-15 19:13:50 → 10-15 19:15:45 | 66 | 5 | 0 | 61 | 49 | 115 | D |
| [a4s#231](https://github.com/pablontiv/a4s/pull/231) | 10-15 19:29:13 → 10-15 19:31:01 | 62 | 3 | 0 | 59 | 46 | 108 | D |
| [a4s#232](https://github.com/pablontiv/a4s/pull/232) | 10-15 19:32:17 → 10-15 19:44:22 | 650 | 587 | 0 | 63 | 75 | 725 | D |
| [a4s#238](https://github.com/pablontiv/a4s/pull/238) | 10-15 19:53:19 → 10-15 19:54:56 | 62 | 3 | 0 | 59 | 35 | 97 | D |
| [a4s#239](https://github.com/pablontiv/a4s/pull/239) | 10-15 19:56:19 → 10-15 20:25:20 | 1723 | 1662 | 0 | 61 | 18 | 1741 | D |
| [a4s#243](https://github.com/pablontiv/a4s/pull/243) | 10-15 20:17:01 → 10-15 20:19:22 | 60 | 3 | 0 | 57 | 81 | 141 | D |
| [a4s#245](https://github.com/pablontiv/a4s/pull/245) | 10-15 20:20:51 → 10-15 20:29:49 | 513 | 467 | 0 | 46 | 25 | 538 | D |
| [a4s#246](https://github.com/pablontiv/a4s/pull/246) | 10-15 20:35:03 → 10-15 20:36:30 | 65 | 4 | 0 | 61 | 22 | 87 | D |
| [a4s#256](https://github.com/pablontiv/a4s/pull/256) | 10-15 20:45:40 → 10-15 20:47:10 | 67 | 3 | 0 | 64 | 23 | 90 | D |
| [a4s#462](https://github.com/pablontiv/a4s/pull/462) | 10-21 00:37:42 → 10-21 00:43:22 | 238 | 2 | 0 | 236 | 102 | 340 | D |
| [a4s#464](https://github.com/pablontiv/a4s/pull/464) | 10-21 05:28:25 → 10-21 05:32:46 | 240 | 3 | 0 | 237 | 21 | 261 | D |
| [a4s#465](https://github.com/pablontiv/a4s/pull/465) | 10-21 05:31:49 → 10-21 06:15:57 | 2629 | 879 | 1614 | 136 | 19 | 2648 | D |
| [a4s#467](https://github.com/pablontiv/a4s/pull/467) | 10-21 06:56:30 → 10-21 07:00:38 | 245 | 4 | 0 | 241 | 3 | 248 | D |
| [a4s#469](https://github.com/pablontiv/a4s/pull/469) | 10-21 07:53:30 → 10-21 07:57:45 | 247 | 4 | 0 | 243 | 8 | 255 | D |
| [a4s#471](https://github.com/pablontiv/a4s/pull/471) | 10-21 08:36:27 → 10-21 09:29:12 | 3094 | 2858 | 0 | 236 | 71 | 3165 | D |
| [a4s#472](https://github.com/pablontiv/a4s/pull/472) | 10-21 09:45:01 → 10-21 11:05:37 | 4826 | 4590 | 0 | 236 | 10 | 4836 | D |
| [a4s#473](https://github.com/pablontiv/a4s/pull/473) | 10-21 10:45:07 → 10-21 10:49:27 | 248 | 4 | 0 | 244 | 12 | 260 | D |
| [a4s#474](https://github.com/pablontiv/a4s/pull/474) | 10-21 11:16:13 → 10-21 11:40:55 | 1477 | 1238 | 0 | 239 | 5 | 1482 | D |
| [a4s#475](https://github.com/pablontiv/a4s/pull/475) | 10-21 11:58:54 → 10-21 12:14:39 | 929 | 688 | 0 | 241 | 16 | 945 | D |
| [a4s#477](https://github.com/pablontiv/a4s/pull/477) | 10-21 12:06:14 → 10-21 12:59:45 | 1981 | 1749 | 0 | 232 | 1230 | 3211 | D |
| [a4s#480](https://github.com/pablontiv/a4s/pull/480) | 10-21 13:16:22 → 10-21 15:52:31 | 9337 | 9090 | 0 | 247 | 32 | 9369 | D |
| [a4s#481](https://github.com/pablontiv/a4s/pull/481) | 10-21 13:51:14 → 10-21 13:55:51 | 253 | 3 | 0 | 250 | 24 | 277 | D |
| [a4s#491](https://github.com/pablontiv/a4s/pull/491) | 10-21 15:59:44 → 10-21 20:09:11 | 14941 | 14686 | 0 | 255 | 26 | 14967 | D |
| [a4s#494](https://github.com/pablontiv/a4s/pull/494) | 10-21 17:59:07 → 10-21 18:25:22 | 253 | 4 | 0 | 249 | 1322 | 1575 | D |
| [a4s#506](https://github.com/pablontiv/a4s/pull/506) | 10-21 23:11:07 → 10-21 23:25:21 | 851 | 603 | 0 | 248 | 3 | 854 | D |
| [a4s#507](https://github.com/pablontiv/a4s/pull/507) | 10-21 23:23:56 → 10-21 23:27:55 | 236 | 3 | 0 | 233 | 3 | 239 | D |
| [a4s#508](https://github.com/pablontiv/a4s/pull/508) | 10-22 01:12:16 → 10-22 01:16:24 | 239 | 4 | 0 | 235 | 9 | 248 | D |
| [a4s#509](https://github.com/pablontiv/a4s/pull/509) | 10-22 03:40:20 → 10-22 05:58:10 | 8264 | 8055 | 0 | 209 | 6 | 8270 | D |
| [a4s#523](https://github.com/pablontiv/a4s/pull/523) | 10-22 05:16:31 → 10-22 05:20:48 | 242 | 3 | 0 | 239 | 15 | 257 | D |
| [a4s#525](https://github.com/pablontiv/a4s/pull/525) | 10-22 05:44:32 → 10-22 05:48:55 | 255 | 3 | 0 | 252 | 8 | 263 | D |
| [a4s#526](https://github.com/pablontiv/a4s/pull/526) | 10-22 05:56:56 → 10-22 07:41:09 | 6238 | 5730 | 0 | 508 | 15 | 6253 | D |
| [a4s#538](https://github.com/pablontiv/a4s/pull/538) | 10-22 06:28:31 → 10-22 06:33:09 | 250 | 3 | 0 | 247 | 28 | 278 | D |
| [a4s#539](https://github.com/pablontiv/a4s/pull/539) | 10-22 06:45:02 → 10-22 07:02:52 | 1064 | 818 | 0 | 246 | 6 | 1070 | D |
| [a4s#540](https://github.com/pablontiv/a4s/pull/540) | 10-22 08:22:58 → 10-22 08:27:36 | 268 | 4 | 0 | 264 | 10 | 278 | D |
| [a4s#541](https://github.com/pablontiv/a4s/pull/541) | 10-22 08:31:10 → 10-22 22:33:11 | 47914 | 47599 | 0 | 315 | 2607 | 50521 | D |
| [a4s#543](https://github.com/pablontiv/a4s/pull/543) | 10-22 09:10:20 → 10-22 09:14:48 | 263 | 4 | 0 | 259 | 5 | 268 | D |
| [a4s#544](https://github.com/pablontiv/a4s/pull/544) | 10-22 09:54:15 → 10-22 09:59:54 | 334 | 3 | 0 | 331 | 5 | 339 | D |
| [a4s#547](https://github.com/pablontiv/a4s/pull/547) | 10-22 12:49:48 → 10-22 13:53:40 | 336 | 3 | 0 | 333 | 3496 | 3832 | D |
| [a4s#548](https://github.com/pablontiv/a4s/pull/548) | 10-22 13:49:09 → 10-22 17:09:30 | 11997 | 11660 | 0 | 337 | 24 | 12021 | D |
| [a4s#550](https://github.com/pablontiv/a4s/pull/550) | 10-22 14:52:05 → 10-22 15:01:34 | 335 | 4 | 0 | 331 | 234 | 569 | D |
| [a4s#555](https://github.com/pablontiv/a4s/pull/555) | 10-22 18:18:16 → 10-22 18:23:56 | 320 | 3 | 0 | 317 | 20 | 340 | D |
| [backscroll#183](https://github.com/pablontiv/backscroll/pull/183) | 10-15 16:12:19 → 10-15 16:26:24 | 706 | 4 | 0 | 702 | 139 | 845 | D |
| [backscroll#184](https://github.com/pablontiv/backscroll/pull/184) | 10-15 17:13:14 → 10-15 17:25:45 | 665 | 4 | 0 | 661 | 86 | 751 | D |
| [backscroll#185](https://github.com/pablontiv/backscroll/pull/185) | 10-15 17:31:45 → 10-15 18:05:37 | 2026 | 1375 | 0 | 651 | 6 | 2032 | D |
| [backscroll#186](https://github.com/pablontiv/backscroll/pull/186) | 10-15 17:49:18 → 10-15 18:23:21 | 2000 | 1306 | 0 | 694 | 43 | 2043 | D |
| [backscroll#188](https://github.com/pablontiv/backscroll/pull/188) | 10-15 18:31:06 → 10-15 18:50:44 | 1153 | 5 | 468 | 680 | 25 | 1178 | D |
| [backscroll#192](https://github.com/pablontiv/backscroll/pull/192) | 10-15 19:13:49 → 10-15 19:27:10 | 727 | 4 | 0 | 723 | 74 | 801 | D |
| [backscroll#194](https://github.com/pablontiv/backscroll/pull/194) | 10-15 19:45:05 → 10-15 19:46:49 | 76 | 5 | 0 | 71 | 28 | 104 | D |
| [backscroll#195](https://github.com/pablontiv/backscroll/pull/195) | 10-15 20:15:14 → 10-15 20:17:23 | 97 | 4 | 0 | 93 | 32 | 129 | D |
| [backscroll#210](https://github.com/pablontiv/backscroll/pull/210) | 10-21 00:03:54 → 10-21 00:22:24 | 1107 | 1015 | 0 | 92 | 3 | 1110 | D |
| [backscroll#212](https://github.com/pablontiv/backscroll/pull/212) | 10-21 17:55:56 → 10-21 17:57:27 | 88 | 4 | 0 | 84 | 3 | 91 | D |
| [backscroll#213](https://github.com/pablontiv/backscroll/pull/213) | 10-21 19:29:29 → 10-21 19:31:41 | 99 | 4 | 0 | 95 | 33 | 132 | D |
| [backscroll#214](https://github.com/pablontiv/backscroll/pull/214) | 10-21 19:45:21 → 10-21 22:43:11 | 10667 | 10574 | 0 | 93 | 3 | 10670 | D |
| [backscroll#215](https://github.com/pablontiv/backscroll/pull/215) | 10-21 19:50:09 → 10-21 23:11:07 | 12053 | 11954 | 0 | 99 | 5 | 12058 | D |
| [backscroll#216](https://github.com/pablontiv/backscroll/pull/216) | 10-21 19:57:18 → 10-21 22:01:09 | 7427 | 7354 | 0 | 73 | 4 | 7431 | D |
| [backscroll#217](https://github.com/pablontiv/backscroll/pull/217) | 10-21 20:05:33 → 10-21 20:07:03 | 87 | 4 | 0 | 83 | 3 | 90 | D |
| [backscroll#218](https://github.com/pablontiv/backscroll/pull/218) | 10-21 20:10:47 → 10-21 20:45:24 | 2074 | 1996 | 0 | 78 | 3 | 2077 | D |
| [backscroll#219](https://github.com/pablontiv/backscroll/pull/219) | 10-21 20:28:25 → 10-21 23:29:26 | 10859 | 10757 | 0 | 102 | 2 | 10861 | D |
| [backscroll#220](https://github.com/pablontiv/backscroll/pull/220) | 10-21 20:28:37 → 10-21 22:17:18 | 6513 | 6413 | 0 | 100 | 8 | 6521 | D |
| [backscroll#221](https://github.com/pablontiv/backscroll/pull/221) | 10-21 20:28:55 → 10-21 22:30:31 | 7291 | 7218 | 0 | 73 | 5 | 7296 | D |
| [backscroll#222](https://github.com/pablontiv/backscroll/pull/222) | 10-21 20:50:26 → 10-21 22:55:25 | 7496 | 7407 | 0 | 89 | 3 | 7499 | D |
| [backscroll#224](https://github.com/pablontiv/backscroll/pull/224) | 10-22 01:55:59 → 10-22 01:57:40 | 90 | 3 | 0 | 87 | 11 | 101 | D |
| [backscroll#228](https://github.com/pablontiv/backscroll/pull/228) | 10-22 12:03:47 → 10-22 12:05:51 | 110 | 4 | 0 | 106 | 14 | 124 | D |
| [backscroll#229](https://github.com/pablontiv/backscroll/pull/229) | 10-22 12:06:55 → 10-22 12:15:11 | 492 | 373 | 0 | 119 | 4 | 496 | D |
| [backscroll#231](https://github.com/pablontiv/backscroll/pull/231) | 10-22 13:25:57 → 10-22 13:27:49 | 107 | 4 | 0 | 103 | 5 | 112 | D |
| [backscroll#232](https://github.com/pablontiv/backscroll/pull/232) | 10-22 14:44:56 → 10-22 14:47:18 | 114 | 4 | 0 | 110 | 28 | 142 | D |
| [backscroll#234](https://github.com/pablontiv/backscroll/pull/234) | 10-22 15:40:13 → 10-22 15:42:04 | 90 | 4 | 0 | 86 | 21 | 111 | D |

## Head and workflow ledger

Each section names every head recovered from the PR, retained Actions runs or force-push events. `h0`, `h1`, … are local to that PR; `*` marks the final head. A head without a force-push timestamp has only its first Actions creation as an upper bound on publication, not a fabricated push time. `initial` means first observed, not a proven exhaustive push audit. GitHub does not expose a durable audit of ordinary branch pushes; pushes with neither retained runs nor force-push events are unavailable. For no observed replacement, the push reason is not applicable. For ambiguous replacements the missing reason is stated instead of guessing one of the three requested categories.

Workflow rows use `run ID.attempt`, head, creation UTC, queue seconds, execution seconds, and conclusion. Start = creation + queue; end = start + execution. Execution ends at the latest completed Actions job, avoiding later administrative `updated_at` changes. `—` is missing, not zero. Non-Actions CodeQL check runs are not Actions workflows. All workflow attempts in the PR observation window are listed, including failed/cancelled runs; no job duration is mistaken for workflow duration.

### a4s#137

- h0*: `5edcb47e6eacdb689328444166cd46712a977f41`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38658766842.1](https://github.com/pablontiv/a4s/actions/runs/38658766842) | h0 | 10-15 00:13:16 | 0 | 62 | success |

### a4s#142

- h0*: `08a4f904cf7e152f4edbc50de14266dac965bd93`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38661985296.1](https://github.com/pablontiv/a4s/actions/runs/38661985296) | h0 | 10-15 00:47:03 | 0 | 73 | success |

### a4s#144

- h0*: `0ef79dde0767d72acf41d4f47e73b1704044a94e`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38671365367.1](https://github.com/pablontiv/a4s/actions/runs/38671365367) | h0 | 10-15 02:30:38 | 0 | 51 | success |

### a4s#145

- h0: `289339c485d3176a34aecb11ec89f2ad899a9ac0`.
- h1*: `718369a3b138fa0b37a9d049db6c51e3457c88d7`.
- 10-15 02:35:52: h0 → h1; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38671472252.1](https://github.com/pablontiv/a4s/actions/runs/38671472252) | h0 | 10-15 02:31:49 | 0 | 51 | success |
| [38671835932.1](https://github.com/pablontiv/a4s/actions/runs/38671835932) | h1 | 10-15 02:35:56 | 0 | 62 | success |

### a4s#148

- h0*: `79b8a9a88c735efeaad48b504cebd12c3a657dc8`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38673717802.1](https://github.com/pablontiv/a4s/actions/runs/38673717802) | h0 | 10-15 02:57:24 | 0 | 66 | success |

### a4s#152

- h0*: `8254d5f5caa9714cf29d3a674a156960010f2f46`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38675862541.1](https://github.com/pablontiv/a4s/actions/runs/38675862541) | h0 | 10-15 03:21:46 | 0 | 66 | success |

### a4s#153

- h0: `0919611e030ca973895ced1550a423f9877964d3`.
- h1*: `4a1f26d0c1f2ebea052fd45545bafbba96e3cdb2`.
- 10-15 03:25:13: h0 → h1; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38675969508.1](https://github.com/pablontiv/a4s/actions/runs/38675969508) | h0 | 10-15 03:22:59 | 0 | 48 | success |
| [38676176567.1](https://github.com/pablontiv/a4s/actions/runs/38676176567) | h1 | 10-15 03:25:17 | 0 | 65 | success |

### a4s#156

- h0*: `51c42a75817bf6338ee8062fa6fcc2f852174f13`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38683483252.1](https://github.com/pablontiv/a4s/actions/runs/38683483252) | h0 | 10-15 04:49:27 | 0 | 70 | success |

### a4s#158

- h0*: `6af69594c01249317473b70192e902a09add6d7c`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38685321912.1](https://github.com/pablontiv/a4s/actions/runs/38685321912) | h0 | 10-15 05:10:08 | 0 | 66 | success |

### a4s#160

- h0*: `7079646b66eb591239a61cda1ea6503f87e0b959`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38688950669.1](https://github.com/pablontiv/a4s/actions/runs/38688950669) | h0 | 10-15 05:50:16 | 0 | 69 | success |

### a4s#161

- h0*: `095a307bfcf3f582f94151cd8faebe64442c9b47`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38693460323.1](https://github.com/pablontiv/a4s/actions/runs/38693460323) | h0 | 10-15 06:36:53 | 0 | 64 | success |

### a4s#162

- h0: `b698fc6d8d5f9e18c5e5ce614cdfbd929f5f142d`.
- h1*: `bcdaf6f97f11fc1a6428a9b60207de666c5e91d3`.
- 10-15 07:40:13: h0 → h1; unresolved: changed patch after failed CI; CI-failure fix vs quality correction not proven.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38696341664.1](https://github.com/pablontiv/a4s/actions/runs/38696341664) | h0 | 10-15 07:04:31 | 0 | 41 | failure |
| [38700315348.1](https://github.com/pablontiv/a4s/actions/runs/38700315348) | h1 | 10-15 07:40:17 | 0 | 72 | success |

### a4s#163

- h0*: `ede67fc1411cc66f196d152d44b434fc9a9437be`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38704706637.1](https://github.com/pablontiv/a4s/actions/runs/38704706637) | h0 | 10-15 08:18:20 | 0 | 68 | success |

### a4s#164

- h0: `ac1b63dc5e85b540d73c0fcb6d2d022838d52a33`.
- h1*: `fd225beeb442fefd38ee170e9c15dcb0d6ffff43`.
- 10-15 13:44:26: h0 → h1; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38739632939.1](https://github.com/pablontiv/a4s/actions/runs/38739632939) | h0 | 10-15 13:04:23 | 0 | 77 | success |
| [38745284275.1](https://github.com/pablontiv/a4s/actions/runs/38745284275) | h1 | 10-15 13:44:31 | 0 | 60 | success |

### a4s#165

- h0*: `fd325fce4093518b34748f3775ec67b0353d52d0`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38746331206.1](https://github.com/pablontiv/a4s/actions/runs/38746331206) | h0 | 10-15 13:51:49 | 0 | 55 | success |

### a4s#170

- h0*: `69bd3491070f3eca37430efff939dabab2997746`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38748180391.1](https://github.com/pablontiv/a4s/actions/runs/38748180391) | h0 | 10-15 14:04:38 | 0 | 66 | success |

### a4s#172

- h0*: `1e223d5e6bd72b33d74361b0115a7a2c9589d778`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38748855539.1](https://github.com/pablontiv/a4s/actions/runs/38748855539) | h0 | 10-15 14:09:14 | 0 | 70 | success |

### a4s#173

- h0: `917a162f632a49f982ba57e0136990e5aa462f6f`.
- h1: `2c9742079c427100d45d74fe876ef1c01fd45698`.
- h2*: `05ab1c8ed506894aab888f659bdff091e597b8c7`.
- 10-15 14:14:03: h0 → h1; rebase (equivalent complete patch, changed parent).
- 10-15 14:17:14: h1 → h2; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38749125029.1](https://github.com/pablontiv/a4s/actions/runs/38749125029) | h0 | 10-15 14:11:04 | 0 | 70 | success |
| [38749570919.1](https://github.com/pablontiv/a4s/actions/runs/38749570919) | h1 | 10-15 14:14:07 | 0 | 65 | success |
| [38750045944.1](https://github.com/pablontiv/a4s/actions/runs/38750045944) | h2 | 10-15 14:17:19 | 0 | 69 | success |

### a4s#174

- h0*: `a43a836b995a318c98144daf8596348f4ee86bbc`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38749377185.1](https://github.com/pablontiv/a4s/actions/runs/38749377185) | h0 | 10-15 14:12:49 | 0 | 72 | success |

### a4s#177

- h0*: `0e6d6466713c8c7c99d840b90a90b7ef1b6d98b2`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38754993504.1](https://github.com/pablontiv/a4s/actions/runs/38754993504) | h0 | 10-15 14:50:29 | 0 | 70 | success |

### a4s#178

- h0: `7083548ac991cd2de9c6c380af1911822bf024b1`.
- h1*: `95b72a520de9f3493bf611b73bc17a08d4a25851`.
- 10-15 15:08:57: h0 → h1; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38757098171.1](https://github.com/pablontiv/a4s/actions/runs/38757098171) | h0 | 10-15 15:04:32 | 0 | 64 | success |
| [38757761436.1](https://github.com/pablontiv/a4s/actions/runs/38757761436) | h1 | 10-15 15:09:03 | 0 | 72 | success |

### a4s#179

- h0: `b03c03533600fc0967ee4e06a3f4d8d5ea22aa10`.
- h1*: `a1af14df92d9030b6f3cb606bd4d275d31e1ed34`.
- 10-15 15:38:48: h0 → h1; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38757919174.1](https://github.com/pablontiv/a4s/actions/runs/38757919174) | h0 | 10-15 15:10:07 | 0 | 67 | success |
| [38762168172.1](https://github.com/pablontiv/a4s/actions/runs/38762168172) | h1 | 10-15 15:38:53 | 0 | 71 | success |

### a4s#181

- h0*: `a8642ada716486fe6892cebbc99d317db4ca40c7`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38758841990.1](https://github.com/pablontiv/a4s/actions/runs/38758841990) | h0 | 10-15 15:16:20 | 0 | 61 | success |

### a4s#183

- h0*: `5ec9aef94f473c73755f9cf87da19ce3ac7ad017`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38760135053.1](https://github.com/pablontiv/a4s/actions/runs/38760135053) | h0 | 10-15 15:25:05 | 0 | 67 | success |

### a4s#184

- h0*: `6e320dd51414b92680f9728222c9d3986a2f79bb`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38760627134.1](https://github.com/pablontiv/a4s/actions/runs/38760627134) | h0 | 10-15 15:28:27 | 0 | 62 | success |

### a4s#186

- h0*: `7c72eff38d408622094b9761e6b4451b2bc8f46f`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38764019971.1](https://github.com/pablontiv/a4s/actions/runs/38764019971) | h0 | 10-15 15:51:38 | 0 | 68 | success |

### a4s#190

- h0*: `d49ad9a1f1cd386fe9b7998064bd3a4d15c94861`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38766168688.1](https://github.com/pablontiv/a4s/actions/runs/38766168688) | h0 | 10-15 16:06:26 | 0 | 74 | success |

### a4s#192

- h0*: `ea8045ab0b7ee85375432a0679cdf5877788e9b1`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38768099095.1](https://github.com/pablontiv/a4s/actions/runs/38768099095) | h0 | 10-15 16:20:01 | 0 | 55 | success |

### a4s#194

- h0*: `e26b905e9a0dedb96136a7645987e1c3a61c9b88`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38769381221.1](https://github.com/pablontiv/a4s/actions/runs/38769381221) | h0 | 10-15 16:29:09 | 0 | 64 | success |

### a4s#195

- h0: `e204497ae835f494c0a363d7fd523ec050b58fed`.
- h1*: `1d5d592303ef6675bfdeb68c450ae9446b4cb777`.
- 10-15 16:33:20: h0 → h1; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38769759690.1](https://github.com/pablontiv/a4s/actions/runs/38769759690) | h0 | 10-15 16:31:47 | 0 | 68 | success |
| [38769989604.1](https://github.com/pablontiv/a4s/actions/runs/38769989604) | h1 | 10-15 16:33:24 | 0 | 56 | success |

### a4s#196

- h0: `36714829ffb06d5a0510d237531f6b86fef557bc`.
- h1*: `a91347943e9012623669d96e861e7fb2c75ee848`.
- 10-15 16:36:06: h0 → h1; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38770183893.1](https://github.com/pablontiv/a4s/actions/runs/38770183893) | h0 | 10-15 16:34:47 | 0 | 61 | success |
| [38770375686.1](https://github.com/pablontiv/a4s/actions/runs/38770375686) | h1 | 10-15 16:36:10 | 0 | 44 | success |

### a4s#198

- h0*: `dbac9b49848e34ecdc397112eebee1e72e158809`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38777805682.1](https://github.com/pablontiv/a4s/actions/runs/38777805682) | h0 | 10-15 17:29:46 | 0 | 60 | success |

### a4s#200

- h0*: `788ca9647e897143b8bc3a0ed4441161ef3ee20e`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38779459975.1](https://github.com/pablontiv/a4s/actions/runs/38779459975) | h0 | 10-15 17:41:43 | 0 | 53 | success |

### a4s#206

- h0*: `94854fd5c9983879e139645dda678875ed01d348`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38781826434.1](https://github.com/pablontiv/a4s/actions/runs/38781826434) | h0 | 10-15 17:59:01 | 0 | 58 | success |

### a4s#207

- h0: `9944b1165314d136fb3a9a353b0aca6e28b0a337`.
- h1*: `1d4975c385f855e176721d3b0204496b87df2428`.
- 10-15 18:05:20: h0 → h1; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38782291828.1](https://github.com/pablontiv/a4s/actions/runs/38782291828) | h0 | 10-15 18:02:21 | 0 | 71 | success |
| [38782718330.1](https://github.com/pablontiv/a4s/actions/runs/38782718330) | h1 | 10-15 18:05:25 | 0 | 55 | success |

### a4s#210

- h0: `42dc5cf0d708bbdadb8bf2d77a5df7784048a303`.
- h1: `80555216b143cd790b4aca1ee6aa3debaada2c12`.
- h2: `ef28ea55e61ea8d205e3512c3ce11dc49775debf`.
- h3: `ed785188deef152f57bb9ab23df630402ac3e642`.
- h4: `9ceb0024b793336cba0df99bd7b6e3d0eeb05c52`.
- h5*: `8483bf5be685cccbe4fe92b9060906b43d29c9b7`.
- 10-15 18:07:57: h0 → h1; rebase (equivalent complete patch, changed parent).
- 10-15 18:12:14: h1 → h2; rebase (equivalent complete patch, changed parent).
- 10-15 18:19:08: h2 → h3; rebase (equivalent complete patch, changed parent).
- 10-15 18:56:21: h3 → h4; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.
- 10-15 19:05:19: h4 → h5; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38782507561.1](https://github.com/pablontiv/a4s/actions/runs/38782507561) | h0 | 10-15 18:03:55 | 0 | 46 | success |
| [38783080625.1](https://github.com/pablontiv/a4s/actions/runs/38783080625) | h1 | 10-15 18:08:00 | 0 | 47 | success |
| [38783670199.1](https://github.com/pablontiv/a4s/actions/runs/38783670199) | h2 | 10-15 18:12:18 | 0 | 50 | success |
| [38784629583.1](https://github.com/pablontiv/a4s/actions/runs/38784629583) | h3 | 10-15 18:19:14 | 0 | 46 | success |
| [38789763212.1](https://github.com/pablontiv/a4s/actions/runs/38789763212) | h4 | 10-15 18:56:24 | 0 | 64 | success |
| [38791015456.1](https://github.com/pablontiv/a4s/actions/runs/38791015456) | h5 | 10-15 19:05:23 | 0 | 56 | success |

### a4s#213

- h0: `0ae031afbd72a4d8003c2e13890415b5735c707e`.
- h1*: `23701b58cd0d1098bda9768246699ae1de8466ea`.
- 10-15 18:10:19: h0 → h1; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38782875900.1](https://github.com/pablontiv/a4s/actions/runs/38782875900) | h0 | 10-15 18:06:33 | 0 | 62 | success |
| [38783406887.1](https://github.com/pablontiv/a4s/actions/runs/38783406887) | h1 | 10-15 18:10:24 | 0 | 46 | success |

### a4s#217

- h0*: `a551e873d6a77bbef229a21d3f099ff025cd323c`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38784541795.1](https://github.com/pablontiv/a4s/actions/runs/38784541795) | h0 | 10-15 18:18:35 | 0 | 58 | success |

### a4s#218

- h0: `191c535cb560725b43c446b3d2df7b5e16d5f9b8`.
- h1*: `e6bdd4fcd501a16343d4538d08ab1d9e677d01bd`.
- 10-15 18:47:41: h0 → h1; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38784768263.1](https://github.com/pablontiv/a4s/actions/runs/38784768263) | h0 | 10-15 18:20:14 | 0 | 48 | success |
| [38788573231.1](https://github.com/pablontiv/a4s/actions/runs/38788573231) | h1 | 10-15 18:47:45 | 0 | 61 | success |

### a4s#219

- h0: `2c2a463d590f3bed27819083947cf6f96d86ef0c`.
- h1: `44337f01b6934f96e2b706b4e32029a8800cb96e`.
- h2: `dcaa49699e0a480e6228724d619a68dda82aaefe`.
- h3: `e1deee3a90c7cee6d70074e010afa1aaa6f5a004`.
- h4*: `1931775c16668e6af1c883851bcde2c92dd63f50`.
- h5: `3dcbb254b2debc26e83d255f8428642561f18568` — no retained Actions run in the observation window.
- 10-15 18:48:54: h5 → h0; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.
- 10-15 18:59:38: h0 → h1; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.
- 10-15 19:11:15: h1 → h2; rebase (equivalent complete patch, changed parent).
- 10-15 19:18:08: h2 → h3; unresolved: changed patch after failed CI; CI-failure fix vs quality correction not proven.
- 10-15 19:23:49: h3 → h4; unresolved: changed patch after failed CI; CI-failure fix vs quality correction not proven.
- h5: replacement timestamp/reason missing; ordinary push not audited by timeline.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38788738566.1](https://github.com/pablontiv/a4s/actions/runs/38788738566) | h0 | 10-15 18:48:58 | 0 | 45 | success |
| [38790217587.1](https://github.com/pablontiv/a4s/actions/runs/38790217587) | h1 | 10-15 18:59:43 | 0 | 43 | failure |
| [38791828793.1](https://github.com/pablontiv/a4s/actions/runs/38791828793) | h2 | 10-15 19:11:19 | 0 | 39 | failure |
| [38792781246.1](https://github.com/pablontiv/a4s/actions/runs/38792781246) | h3 | 10-15 19:18:12 | 0 | 28 | failure |
| [38793562665.1](https://github.com/pablontiv/a4s/actions/runs/38793562665) | h4 | 10-15 19:23:53 | 0 | 47 | success |

### a4s#224

- h0*: `7fd2e4a826c6bceb208b6c4e2ec57312e5c8dbe8`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38789329317.1](https://github.com/pablontiv/a4s/actions/runs/38789329317) | h0 | 10-15 18:53:17 | 0 | 59 | success |

### a4s#229

- h0*: `15c85be3265923c51e13a1992c665592c9e15b84`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38792186269.1](https://github.com/pablontiv/a4s/actions/runs/38792186269) | h0 | 10-15 19:13:55 | 0 | 61 | success |

### a4s#231

- h0*: `d36490be824625b3d497eac93e16dd328232cba6`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38794293979.1](https://github.com/pablontiv/a4s/actions/runs/38794293979) | h0 | 10-15 19:29:16 | 0 | 59 | success |

### a4s#232

- h0: `724070c9befe272cfebefa810e1ac78b0d3ae02b`.
- h1*: `f830bee72eb7f544b7d21e7fa53a5cb0bfaa5ffe`.
- 10-15 19:42:00: h0 → h1; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38794728243.1](https://github.com/pablontiv/a4s/actions/runs/38794728243) | h0 | 10-15 19:32:25 | 0 | 62 | success |
| [38796026634.1](https://github.com/pablontiv/a4s/actions/runs/38796026634) | h1 | 10-15 19:42:04 | 0 | 63 | success |

### a4s#238

- h0*: `6b11b00f8ce1df328b56e2605903b7c6937884fb`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38797514701.1](https://github.com/pablontiv/a4s/actions/runs/38797514701) | h0 | 10-15 19:53:22 | 0 | 59 | success |

### a4s#239

- h0: `80a0651a2551c66bbc7fe21294ae81e09fbf1307`.
- h1*: `f141fa8ee1826c168ab3c5ec6cae7266ce06ecc1`.
- h2: `3b73eadaa2dd552124ad1d84a510e62d0c51ddad` — no retained Actions run in the observation window.
- 10-15 20:21:07: h2 → h0; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.
- 10-15 20:23:57: h0 → h1; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.
- h2: replacement timestamp/reason missing; ordinary push not audited by timeline.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38801231562.1](https://github.com/pablontiv/a4s/actions/runs/38801231562) | h0 | 10-15 20:21:11 | 0 | 68 | success |
| [38801620132.1](https://github.com/pablontiv/a4s/actions/runs/38801620132) | h1 | 10-15 20:24:01 | 0 | 61 | success |

### a4s#243

- h0*: `7bfc522ef5ca552cb82c097647e85b372463fecc`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38800679519.1](https://github.com/pablontiv/a4s/actions/runs/38800679519) | h0 | 10-15 20:17:04 | 0 | 57 | success |

### a4s#245

- h0: `916530e669113660fc6e2f52f76b3ea5d4b1d5db`.
- h1: `7c0a6dd73de6c2a531d773bc3c45ab90386f4966`.
- h2*: `d0fcfbdc191b7a77ec410a9d9c93c548af37db77`.
- 10-15 20:25:35: h0 → h1; rebase (equivalent complete patch, changed parent).
- 10-15 20:28:34: h1 → h2; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38801195415.1](https://github.com/pablontiv/a4s/actions/runs/38801195415) | h0 | 10-15 20:20:55 | 0 | 63 | success |
| [38801847640.1](https://github.com/pablontiv/a4s/actions/runs/38801847640) | h1 | 10-15 20:25:39 | 0 | 62 | success |
| [38802248256.1](https://github.com/pablontiv/a4s/actions/runs/38802248256) | h2 | 10-15 20:28:38 | 0 | 46 | success |

### a4s#246

- h0*: `8411623366f2a342ee108a81d97bbb691c3bd399`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38803137577.1](https://github.com/pablontiv/a4s/actions/runs/38803137577) | h0 | 10-15 20:35:07 | 0 | 61 | success |

### a4s#256

- h0*: `0b62a569be7981e0a33432dd69bc39aee1e3655e`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38804552870.1](https://github.com/pablontiv/a4s/actions/runs/38804552870) | h0 | 10-15 20:45:43 | 0 | 64 | success |

### a4s#462

- h0*: `ef77e10593f8065d092760357a24c804be1f7ae7`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39522460139.1](https://github.com/pablontiv/a4s/actions/runs/39522460139) | h0 | 10-21 00:37:44 | 0 | 236 | success |

### a4s#464

- h0*: `e6e3475121fff89d5294f713b8e1c67cec49c70a`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39549751736.1](https://github.com/pablontiv/a4s/actions/runs/39549751736) | h0 | 10-21 05:28:28 | 0 | 237 | success |

### a4s#465

- h0: `11ae97822b6a6c84fa8d89f5b7b81b164abaae58`.
- h1*: `3c90710572b07f2368a2c9d755e13cbf430282ba`.
- 10-21 05:46:24: h0 → h1; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39550076996.1](https://github.com/pablontiv/a4s/actions/runs/39550076996) | h0 | 10-21 05:31:52 | 0 | 234 | success |
| [39551461448.1](https://github.com/pablontiv/a4s/actions/runs/39551461448) | h1 | 10-21 05:46:28 | 0 | 238 | failure |
| [39551461448.2](https://github.com/pablontiv/a4s/actions/runs/39551461448) | h1 | 10-21 05:46:28 | 1614 | 136 | success |

### a4s#467

- h0*: `d4eb10a3fc5ad61580d20fc4c90ff3192697953b`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39558592868.1](https://github.com/pablontiv/a4s/actions/runs/39558592868) | h0 | 10-21 06:56:34 | 0 | 241 | success |

### a4s#469

- h0*: `8a5bb1f83470fb5071bd60fa444a9821e009abec`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39565199780.1](https://github.com/pablontiv/a4s/actions/runs/39565199780) | h0 | 10-21 07:53:34 | 0 | 243 | success |

### a4s#471

- h0: `1f23aa78f42c54bd3dfcdc656fe6b0362a33ace2`.
- h1*: `1a273f22185b40ec138a776c654e828ac08d025f`.
- 10-21 09:24:01: h0 → h1; unresolved: changed patch after failed CI; CI-failure fix vs quality correction not proven.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39570559375.1](https://github.com/pablontiv/a4s/actions/runs/39570559375) | h0 | 10-21 08:36:31 | 0 | 235 | failure |
| [39576661179.1](https://github.com/pablontiv/a4s/actions/runs/39576661179) | h1 | 10-21 09:24:05 | 0 | 236 | success |

### a4s#472

- h0: `3da4b98fd3e53f852905663b9db7bcfbfe3b36e4`.
- h1*: `62a54e43edc0d4a8ba11ea5b50bcff8a2ebbc533`.
- 10-21 11:01:28: h0 → h1; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39579367292.1](https://github.com/pablontiv/a4s/actions/runs/39579367292) | h0 | 10-21 09:45:05 | 0 | 238 | failure |
| [39588869378.1](https://github.com/pablontiv/a4s/actions/runs/39588869378) | h1 | 10-21 11:01:31 | 0 | 236 | success |

### a4s#473

- h0*: `c94336c729a7614f0ec4f82b3930fa4df6fd4922`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39586877498.1](https://github.com/pablontiv/a4s/actions/runs/39586877498) | h0 | 10-21 10:45:11 | 0 | 244 | success |

### a4s#474

- h0: `02d633c69c97e534f52d406d4e0216342045e416`.
- h1*: `e83c52a749ea99a1fba1cdf71019daa0608d74d2`.
- 10-21 11:36:48: h0 → h1; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39590703628.1](https://github.com/pablontiv/a4s/actions/runs/39590703628) | h0 | 10-21 11:16:16 | 0 | 233 | success |
| [39593249560.1](https://github.com/pablontiv/a4s/actions/runs/39593249560) | h1 | 10-21 11:36:51 | 0 | 239 | success |

### a4s#475

- h0: `4c450b56915a2899b98e47d8422d47833949041c`.
- h1*: `c216104d04b94827eab762f363c68440e6c35dce`.
- 10-21 12:10:18: h0 → h1; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39596007033.1](https://github.com/pablontiv/a4s/actions/runs/39596007033) | h0 | 10-21 11:58:58 | 0 | 241 | success |
| [39597484532.1](https://github.com/pablontiv/a4s/actions/runs/39597484532) | h1 | 10-21 12:10:22 | 0 | 241 | success |

### a4s#477

- h0: `4382c0cb0eacc71bee47ea001e9358e30cdcd1aa`.
- h1*: `b8d9249cdae892e91f0ef0562319790f26912500`.
- h2: `9f39a7cd6b5ff94532d7ff1f41afa8d8496738fa` — no retained Actions run in the observation window.
- 10-21 12:23:18: h2 → h0; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.
- 10-21 12:35:20: h0 → h1; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.
- h2: replacement timestamp/reason missing; ordinary push not audited by timeline.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39599198907.1](https://github.com/pablontiv/a4s/actions/runs/39599198907) | h0 | 10-21 12:23:23 | 0 | 258 | success |
| [39600809564.1](https://github.com/pablontiv/a4s/actions/runs/39600809564) | h1 | 10-21 12:35:23 | 0 | 232 | success |

### a4s#480

- h0: `2cea4bc71afb786db135dbb7884134791309cf21`.
- h1*: `c5be62bc80ae4d54178b2a98ecbe786142e02ebc`.
- 10-21 15:47:48: h0 → h1; unresolved: changed patch after failed CI; CI-failure fix vs quality correction not proven.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39606546764.1](https://github.com/pablontiv/a4s/actions/runs/39606546764) | h0 | 10-21 13:16:26 | 0 | 237 | failure |
| [39628923204.1](https://github.com/pablontiv/a4s/actions/runs/39628923204) | h1 | 10-21 15:47:52 | 0 | 247 | success |

### a4s#481

- h0*: `5d28f271c9132cb3077162610a2200cf7263e0c4`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39611644784.1](https://github.com/pablontiv/a4s/actions/runs/39611644784) | h0 | 10-21 13:51:17 | 0 | 250 | success |

### a4s#491

- h0: `e7a1539f6d80842758996d3a5e67a72dec5bc301`.
- h1: `9d7082af3e7f57cce2ba4894134c1e91172f593f`.
- h2*: `eabd78561a7eb8875ad4e7023b84931c4ec272e4`.
- 10-21 16:13:12: h0 → h1; rebase (equivalent complete patch, changed parent).
- 10-21 20:04:24: h1 → h2; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39630733242.1](https://github.com/pablontiv/a4s/actions/runs/39630733242) | h0 | 10-21 15:59:48 | 0 | 251 | success |
| [39632811017.1](https://github.com/pablontiv/a4s/actions/runs/39632811017) | h1 | 10-21 16:13:16 | 0 | 250 | failure |
| [39667131693.1](https://github.com/pablontiv/a4s/actions/runs/39667131693) | h2 | 10-21 20:04:30 | 0 | 255 | success |

### a4s#494

- h0*: `f34dda6154dab699fdf8de7c81fe80e925ce538a`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39648639210.1](https://github.com/pablontiv/a4s/actions/runs/39648639210) | h0 | 10-21 17:59:11 | 0 | 249 | success |

### a4s#506

- h0: `78412cdb952ea6c267cc07b6210983dbe9232e18`.
- h1*: `64e176b85408991805043543f0b70f08bbd0a2d5`.
- 10-21 23:21:06: h0 → h1; quality correction: unsigned to verified metadata rewrite; identical tree and parents.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39691736857.1](https://github.com/pablontiv/a4s/actions/runs/39691736857) | h0 | 10-21 23:11:11 | 0 | 252 | success |
| [39692850538.1](https://github.com/pablontiv/a4s/actions/runs/39692850538) | h1 | 10-21 23:21:10 | 0 | 248 | success |

### a4s#507

- h0*: `4ae9b041fd6b6389af109377036b7b8fbe78843c`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39693156834.1](https://github.com/pablontiv/a4s/actions/runs/39693156834) | h0 | 10-21 23:23:59 | 0 | 233 | success |

### a4s#508

- h0*: `3fc80933b9f197ffb86e12784a5763cf6316488e`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39704318222.1](https://github.com/pablontiv/a4s/actions/runs/39704318222) | h0 | 10-22 01:12:20 | 0 | 235 | success |

### a4s#509

- h0: `0b1a289aca79b47e6ae4d9b07117a64d1815c300`.
- h1*: `5ada5e4cc2ba8073f492738ecbe362506483a9a6`.
- 10-22 05:54:31: h0 → h1; unresolved: changed patch after failed CI; CI-failure fix vs quality correction not proven.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39718122992.1](https://github.com/pablontiv/a4s/actions/runs/39718122992) | h0 | 10-22 03:40:23 | 0 | 204 | failure |
| [39730719244.1](https://github.com/pablontiv/a4s/actions/runs/39730719244) | h1 | 10-22 05:54:35 | 0 | 209 | success |

### a4s#523

- h0*: `8c360a04c066a977cdb68e9659abc1f14ce14721`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39727087506.1](https://github.com/pablontiv/a4s/actions/runs/39727087506) | h0 | 10-22 05:16:34 | 0 | 239 | success |

### a4s#525

- h0*: `c3db4e342fc854ab76b86bd9b3ab5fbaafc89aa7`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39729758156.1](https://github.com/pablontiv/a4s/actions/runs/39729758156) | h0 | 10-22 05:44:35 | 0 | 252 | success |

### a4s#526

- h0: `7a3e24b0fe5a91dbe27c76e7ecb0bbcf508b3483`.
- h1: `dd4820e62e91975086293b26ca7ef096b7fe2807`.
- h2*: `10f75a0dd6239ca248337f43d6ca6bf35978a929`.
- h3: `b906d913977d99a5811f0e9d153f20af1e38947a` — no retained Actions run in the observation window.
- 10-22 06:36:15: h0 → h3; rebase (equivalent complete patch, changed parent).
- 10-22 06:51:22: h3 → h1; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.
- 10-22 07:32:22: h1 → h2; unresolved: changed patch after failed CI; CI-failure fix vs quality correction not proven.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39730949123.1](https://github.com/pablontiv/a4s/actions/runs/39730949123) | h0 | 10-22 05:56:59 | 0 | 253 | success |
| [39736584679.1](https://github.com/pablontiv/a4s/actions/runs/39736584679) | h1 | 10-22 06:51:26 | 0 | 258 | failure |
| [39741192049.1](https://github.com/pablontiv/a4s/actions/runs/39741192049) | h2 | 10-22 07:32:26 | 0 | 508 | success |

### a4s#538

- h0*: `98a11a868337a27747e9d6e2a9cebf5829681543`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39734157752.1](https://github.com/pablontiv/a4s/actions/runs/39734157752) | h0 | 10-22 06:28:34 | 0 | 247 | success |

### a4s#539

- h0*: `5674f8080ea2cb1066f7d43cddb66cafb342d79a`.
- h1: `4e6493ae124108e04f2da194fde012c41cf9f70d` — no retained Actions run in the observation window.
- 10-22 06:58:35: h1 → h0; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.
- h1: replacement timestamp/reason missing; ordinary push not audited by timeline.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39737348673.1](https://github.com/pablontiv/a4s/actions/runs/39737348673) | h0 | 10-22 06:58:40 | 0 | 246 | success |

### a4s#540

- h0*: `a2a78ce3e5b81cc19a744d6a9f9263fbcab4d2fc`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39747316778.1](https://github.com/pablontiv/a4s/actions/runs/39747316778) | h0 | 10-22 08:23:02 | 0 | 264 | success |

### a4s#541

- h0: `998430e0efb4d0c160bad89c43421faed0cac3c7`.
- h1*: `1570f6007416b6e1bdb461a30537a68584c3f08d`.
- h2: `515e2984d8400b2fd0e6b90545286b9514d5e8d1` — no retained Actions run in the observation window.
- h3: `89894b0c496b1e3a564fc0e707d11c98bd05f461` — no retained Actions run in the observation window.
- 10-22 10:05:41: h2 → h3; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.
- 10-22 11:57:37: h3 → h0; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.
- 10-22 21:44:26: h0 → h1; unresolved: changed patch after failed CI; CI-failure fix vs quality correction not proven.
- h2: replacement timestamp/reason missing; ordinary push not audited by timeline.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39774530959.1](https://github.com/pablontiv/a4s/actions/runs/39774530959) | h0 | 10-22 11:57:41 | 0 | 468 | failure |
| [39859673832.1](https://github.com/pablontiv/a4s/actions/runs/39859673832) | h1 | 10-22 21:44:29 | 0 | 315 | success |

### a4s#543

- h0*: `b1484cc19d84dfdd971b4e66187322b9b14e4a21`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39753353800.1](https://github.com/pablontiv/a4s/actions/runs/39753353800) | h0 | 10-22 09:10:24 | 0 | 259 | success |

### a4s#544

- h0*: `9b4a3bbc4e543aa3bed7048ecf2fc3c47f16588c`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39759007887.1](https://github.com/pablontiv/a4s/actions/runs/39759007887) | h0 | 10-22 09:54:18 | 0 | 331 | success |

### a4s#547

- h0*: `1265e4661bc725b4aa4a222067717ed930b09ac0`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39781594442.1](https://github.com/pablontiv/a4s/actions/runs/39781594442) | h0 | 10-22 12:49:51 | 0 | 333 | success |

### a4s#548

- h0: `76b015c1bea717412aaf3e3d136477b1d53ef1a2`.
- h1: `d68603c8bde4911771f50c863cfcdc2e283e9a55`.
- h2*: `dfcdbddfb3f6f8d9f270d24315b8b5856e0413f9`.
- 10-22 15:45:43: h0 → h1; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.
- 10-22 17:03:25: h1 → h2; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39790245574.1](https://github.com/pablontiv/a4s/actions/runs/39790245574) | h0 | 10-22 13:49:12 | 0 | 329 | success |
| [39807864223.1](https://github.com/pablontiv/a4s/actions/runs/39807864223) | h1 | 10-22 15:45:47 | 0 | 321 | success |
| [39819311816.1](https://github.com/pablontiv/a4s/actions/runs/39819311816) | h2 | 10-22 17:03:29 | 0 | 337 | success |

### a4s#550

- h0*: `d95b4e12a826562eb856fa80fc9f4796773ca03f`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39799488441.1](https://github.com/pablontiv/a4s/actions/runs/39799488441) | h0 | 10-22 14:52:09 | 0 | 331 | success |

### a4s#555

- h0*: `90e8a16fde87c7e47d2b4904d78a5bd71e4b3430`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39830156704.1](https://github.com/pablontiv/a4s/actions/runs/39830156704) | h0 | 10-22 18:18:19 | 0 | 317 | success |

### backscroll#183

- h0*: `b65e5de549a6fe6ab68f95bb9b7f7412222d803d`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38767008911.1](https://github.com/pablontiv/backscroll/actions/runs/38767008911) | h0 | 10-15 16:12:23 | 0 | 702 | success |

### backscroll#184

- h0*: `9df6b69fbcb583b7793297746c9095cb8aa5b518`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38775504959.1](https://github.com/pablontiv/backscroll/actions/runs/38775504959) | h0 | 10-15 17:13:18 | 0 | 661 | success |

### backscroll#185

- h0*: `8b1055bc42017d47169303f9c294ed0394dacd40`.
- h1: `4133a44779be46b249cce3671ab494bf82a4c928` — no retained Actions run in the observation window.
- 10-15 17:54:33: h1 → h0; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.
- h1: replacement timestamp/reason missing; ordinary push not audited by timeline.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38781237810.1](https://github.com/pablontiv/backscroll/actions/runs/38781237810) | h0 | 10-15 17:54:40 | 0 | 651 | success |

### backscroll#186

- h0*: `b2d2cff896eb5075b95aad5a786649bb0216ce0c`.
- h1: `cfac27cc17ecd2e6772e089de211c2125bba0b02` — no retained Actions run in the observation window.
- 10-15 18:10:59: h1 → h0; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.
- h1: replacement timestamp/reason missing; ordinary push not audited by timeline.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38783498956.1](https://github.com/pablontiv/backscroll/actions/runs/38783498956) | h0 | 10-15 18:11:04 | 0 | 694 | success |

### backscroll#188

- h0*: `2cc0c8550708829570f3cefaadf615f919073b30`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38786295313.1](https://github.com/pablontiv/backscroll/actions/runs/38786295313) | h0 | 10-15 18:31:11 | 0 | 440 | failure |
| [38786295313.2](https://github.com/pablontiv/backscroll/actions/runs/38786295313) | h0 | 10-15 18:31:11 | 468 | 680 | success |

### backscroll#192

- h0*: `939cc5bac4e46c4a441a00f29c66be1d89278e54`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38792181824.1](https://github.com/pablontiv/backscroll/actions/runs/38792181824) | h0 | 10-15 19:13:53 | 0 | 723 | success |

### backscroll#194

- h0*: `ddeb67fbca926dbc965f632f808ca105b3483629`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38796433306.1](https://github.com/pablontiv/backscroll/actions/runs/38796433306) | h0 | 10-15 19:45:10 | 0 | 71 | success |

### backscroll#195

- h0*: `b0ad0bce82296f9e3b6defb748cdc10882170152`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [38800441268.1](https://github.com/pablontiv/backscroll/actions/runs/38800441268) | h0 | 10-15 20:15:18 | 0 | 93 | success |

### backscroll#210

- h0: `164a3eb9bd90deea36e9220c0ae1bc24cc91e049`.
- h1*: `0140132593fe34d16381a99c7444154c067bf4f7`.
- 10-21 00:20:44: h0 → h1; unresolved: changed patch after failed CI; CI-failure fix vs quality correction not proven.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39518991952.1](https://github.com/pablontiv/backscroll/actions/runs/39518991952) | h0 | 10-21 00:03:58 | 0 | 72 | failure |
| [39520755042.1](https://github.com/pablontiv/backscroll/actions/runs/39520755042) | h1 | 10-21 00:20:49 | 0 | 92 | success |

### backscroll#212

- h0*: `5c604eadb79117b45b34eb5362247c57ac81fc5c`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39648176548.1](https://github.com/pablontiv/backscroll/actions/runs/39648176548) | h0 | 10-21 17:56:00 | 0 | 84 | success |

### backscroll#213

- h0*: `0981957b79e0004ecbb7616eb9876f07d9ba5b3b`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39662097073.1](https://github.com/pablontiv/backscroll/actions/runs/39662097073) | h0 | 10-21 19:29:33 | 0 | 95 | success |

### backscroll#214

- h0: `cb90035953e445db6f641ed3a7ecbd00cf3b8843`.
- h1: `45d4326c89835f781271e390e7245b73e0d8979f`.
- h2: `a85762be19a60631a144d95dd4e3370aca8687ab`.
- h3: `63a5d8fd239e5e6593e5305165b92b97c7503ece`.
- h4: `c15100708d690ffb9452e9eac8a0ae6264dd9afc`.
- h5: `5b3a5c83d4924b45c3a0326af4d7703798fe645a`.
- h6*: `7c828903237e6ac88ffc0880f9a90968388ee85a`.
- 10-21 20:40:42: h0 → h1; rebase (equivalent complete patch, changed parent).
- 10-21 21:54:21: h1 → h2; rebase (equivalent complete patch, changed parent).
- 10-21 22:08:14: h2 → h3; rebase (equivalent complete patch, changed parent).
- 10-21 22:23:08: h3 → h4; rebase (equivalent complete patch, changed parent).
- 10-21 22:30:44: h4 → h5; rebase (equivalent complete patch, changed parent).
- 10-21 22:41:30: h5 → h6; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39664395075.1](https://github.com/pablontiv/backscroll/actions/runs/39664395075) | h0 | 10-21 19:45:24 | 0 | 102 | success |
| [39672379626.1](https://github.com/pablontiv/backscroll/actions/runs/39672379626) | h1 | 10-21 20:40:46 | 0 | 96 | success |
| [39682485694.1](https://github.com/pablontiv/backscroll/actions/runs/39682485694) | h2 | 10-21 21:54:25 | 0 | 94 | success |
| [39684256209.1](https://github.com/pablontiv/backscroll/actions/runs/39684256209) | h3 | 10-21 22:08:18 | 0 | 82 | success |
| [39686108045.1](https://github.com/pablontiv/backscroll/actions/runs/39686108045) | h4 | 10-21 22:23:13 | 0 | 89 | success |
| [39687028549.1](https://github.com/pablontiv/backscroll/actions/runs/39687028549) | h5 | 10-21 22:30:47 | 0 | 99 | success |
| [39688314831.1](https://github.com/pablontiv/backscroll/actions/runs/39688314831) | h6 | 10-21 22:41:35 | 0 | 93 | success |

### backscroll#215

- h0: `28d8a8e55a8360ab2a56bb1f6a96f9e084eb8db9`.
- h1: `70a6c3d6fe4963ea8da0cc743f65efe96c2adfec`.
- h2: `e1ee60ab2210494844f667d2035d1d0693062605`.
- h3: `d28897c51b2a15990cf06ccfdf885d5e6e8d860b`.
- h4: `cba1273cdca288692369534462f89ee7f5066072`.
- h5*: `0c3cc90850f44d9678ffa33d367bd09d66bdd768`.
- 10-21 20:46:51: h0 → h1; rebase (equivalent complete patch, changed parent).
- 10-21 22:00:45: h1 → h2; rebase (equivalent complete patch, changed parent).
- 10-21 22:41:53: h2 → h3; rebase (equivalent complete patch, changed parent).
- 10-21 22:56:26: h3 → h4; rebase (equivalent complete patch, changed parent).
- 10-21 23:09:19: h4 → h5; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39665078745.1](https://github.com/pablontiv/backscroll/actions/runs/39665078745) | h0 | 10-21 19:50:12 | 0 | 82 | success |
| [39673266556.1](https://github.com/pablontiv/backscroll/actions/runs/39673266556) | h1 | 10-21 20:46:55 | 0 | 107 | success |
| [39683297526.1](https://github.com/pablontiv/backscroll/actions/runs/39683297526) | h2 | 10-21 22:00:50 | 0 | 74 | success |
| [39688358621.1](https://github.com/pablontiv/backscroll/actions/runs/39688358621) | h3 | 10-21 22:41:56 | 0 | 96 | success |
| [39690051595.1](https://github.com/pablontiv/backscroll/actions/runs/39690051595) | h4 | 10-21 22:56:29 | 0 | 93 | success |
| [39691532730.1](https://github.com/pablontiv/backscroll/actions/runs/39691532730) | h5 | 10-21 23:09:23 | 0 | 99 | success |

### backscroll#216

- h0: `6d71c363ad84f62b1f922a02651165c06d1181a0`.
- h1: `093cc8ee7ddc4a64092252eadb62e822d7d20fce`.
- h2*: `d02bd12fac4853925113b63c6da0fa22f6617567`.
- 10-21 20:47:01: h0 → h1; rebase (equivalent complete patch, changed parent).
- 10-21 21:59:49: h1 → h2; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39666096763.1](https://github.com/pablontiv/backscroll/actions/runs/39666096763) | h0 | 10-21 19:57:21 | 0 | 93 | success |
| [39673290560.1](https://github.com/pablontiv/backscroll/actions/runs/39673290560) | h1 | 10-21 20:47:06 | 0 | 97 | success |
| [39683167130.1](https://github.com/pablontiv/backscroll/actions/runs/39683167130) | h2 | 10-21 21:59:52 | 0 | 73 | success |

### backscroll#217

- h0*: `d42124478987bd25fa4247c0e8f1a07642f33258`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39667293402.1](https://github.com/pablontiv/backscroll/actions/runs/39667293402) | h0 | 10-21 20:05:37 | 0 | 83 | success |

### backscroll#218

- h0: `3d0e34a565173b091f24e7c93f47b773697499d5`.
- h1*: `45360ea4d33909782d0c71005c32c8809077d9c2`.
- 10-21 20:43:59: h0 → h1; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39668043898.1](https://github.com/pablontiv/backscroll/actions/runs/39668043898) | h0 | 10-21 20:10:52 | 0 | 81 | success |
| [39672850413.1](https://github.com/pablontiv/backscroll/actions/runs/39672850413) | h1 | 10-21 20:44:03 | 0 | 78 | success |

### backscroll#219

- h0: `a018f60f1698fbcf8d5be66f8aa0086125deda4c`.
- h1: `ce88f7480658c18427fcc48eee225b5330b462c0`.
- h2: `12acbf742792845b1ee054152fed0203c32ab094`.
- h3: `d721c21973655228e7954a8e25a2313b4a396df5`.
- h4: `452b8e9ce46944e7348cf29c83a90f45f34c082e`.
- h5: `aeac1da040155045169d679c151a42007d0e34cb`.
- h6*: `51d60270a67676cd5132bdbb94288e41295b4319`.
- h7: `678d3329477c85caecfd4b6409153ae0b303b03f` — no retained Actions run in the observation window.
- 10-21 22:08:43: h0 → h1; rebase (equivalent complete patch, changed parent).
- 10-21 22:23:20: h1 → h2; rebase (equivalent complete patch, changed parent).
- 10-21 22:38:16: h2 → h3; rebase (equivalent complete patch, changed parent).
- 10-21 22:50:25: h3 → h4; rebase (equivalent complete patch, changed parent).
- 10-21 23:00:10: h4 → h7; rebase (equivalent complete patch, changed parent).
- 10-21 23:18:47: h7 → h5; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.
- 10-21 23:27:38: h5 → h6; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39670603194.1](https://github.com/pablontiv/backscroll/actions/runs/39670603194) | h0 | 10-21 20:28:29 | 0 | 90 | success |
| [39684314427.1](https://github.com/pablontiv/backscroll/actions/runs/39684314427) | h1 | 10-21 22:08:47 | 0 | 91 | success |
| [39686129251.1](https://github.com/pablontiv/backscroll/actions/runs/39686129251) | h2 | 10-21 22:23:24 | 0 | 77 | success |
| [39687926770.1](https://github.com/pablontiv/backscroll/actions/runs/39687926770) | h3 | 10-21 22:38:19 | 0 | 96 | success |
| [39689366486.1](https://github.com/pablontiv/backscroll/actions/runs/39689366486) | h4 | 10-21 22:50:29 | 0 | 100 | success |
| [39692597059.1](https://github.com/pablontiv/backscroll/actions/runs/39692597059) | h5 | 10-21 23:18:51 | 0 | 85 | success |
| [39693560606.1](https://github.com/pablontiv/backscroll/actions/runs/39693560606) | h6 | 10-21 23:27:42 | 0 | 102 | success |

### backscroll#220

- h0: `b2a0b61cd577ebead8c24929c3ed4291050d85b5`.
- h1: `e8d7bc75dc12f9846a5b78143a0fadc0ea244493`.
- h2: `722cc97030108829e151fa07d6de24e862a5db71`.
- h3*: `2a5115dedb9749b4dca6f88f17a49abf9d5066b2`.
- 10-21 20:54:27: h0 → h1; rebase (equivalent complete patch, changed parent).
- 10-21 21:59:35: h1 → h2; rebase (equivalent complete patch, changed parent).
- 10-21 22:15:25: h2 → h3; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39670632284.1](https://github.com/pablontiv/backscroll/actions/runs/39670632284) | h0 | 10-21 20:28:40 | 0 | 96 | success |
| [39674352402.1](https://github.com/pablontiv/backscroll/actions/runs/39674352402) | h1 | 10-21 20:54:32 | 0 | 67 | success |
| [39683142460.1](https://github.com/pablontiv/backscroll/actions/runs/39683142460) | h2 | 10-21 21:59:40 | 0 | 97 | success |
| [39685164598.1](https://github.com/pablontiv/backscroll/actions/runs/39685164598) | h3 | 10-21 22:15:30 | 0 | 100 | success |

### backscroll#221

- h0: `d1757d0314359fd909780ee0d5574868d7eb81a7`.
- h1: `80c2102718ea9ef9d1c84fa413d63e94327b5a3a`.
- h2: `88d6d7f617f4a6cd030acd14e1214dcbbd6c4a4c`.
- h3: `bb458c13a3e19fc9718b320173b80d0ffa7fe857`.
- h4*: `c3c2dd0340ab008f8f63f18854edc9ffd5b2c13a`.
- 10-21 20:54:18: h0 → h1; rebase (equivalent complete patch, changed parent).
- 10-21 22:00:09: h1 → h2; rebase (equivalent complete patch, changed parent).
- 10-21 22:15:38: h2 → h3; rebase (equivalent complete patch, changed parent).
- 10-21 22:29:09: h3 → h4; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39670676729.1](https://github.com/pablontiv/backscroll/actions/runs/39670676729) | h0 | 10-21 20:28:59 | 0 | 89 | success |
| [39674332113.1](https://github.com/pablontiv/backscroll/actions/runs/39674332113) | h1 | 10-21 20:54:23 | 0 | 91 | success |
| [39683210914.1](https://github.com/pablontiv/backscroll/actions/runs/39683210914) | h2 | 10-21 22:00:12 | 0 | 76 | success |
| [39685192602.1](https://github.com/pablontiv/backscroll/actions/runs/39685192602) | h3 | 10-21 22:15:44 | 0 | 94 | success |
| [39686831200.1](https://github.com/pablontiv/backscroll/actions/runs/39686831200) | h4 | 10-21 22:29:13 | 0 | 73 | success |

### backscroll#222

- h0: `3c9aa16a981862d73e4df010a1dc0658e4c7631a`.
- h1: `fd2261b23f2cf4f29364f8f4eb0cc705f091c414`.
- h2*: `0908ade5d870657f2b9ec49c36959fb96028e2ca`.
- h3: `300426876bb83aa4a78b04178bf2b1c447b50ef3` — no retained Actions run in the observation window.
- 10-21 22:08:32: h0 → h1; rebase (equivalent complete patch, changed parent).
- 10-21 22:19:58: h1 → h3; rebase (equivalent complete patch, changed parent).
- 10-21 22:53:49: h3 → h2; missing reason: changed patch; rebase resolution vs quality correction not distinguishable from retained API data.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39673783208.1](https://github.com/pablontiv/backscroll/actions/runs/39673783208) | h0 | 10-21 20:50:31 | 0 | 93 | success |
| [39684290747.1](https://github.com/pablontiv/backscroll/actions/runs/39684290747) | h1 | 10-21 22:08:35 | 0 | 102 | success |
| [39689754796.1](https://github.com/pablontiv/backscroll/actions/runs/39689754796) | h2 | 10-21 22:53:53 | 0 | 89 | success |

### backscroll#224

- h0*: `28a807ca0db31f4c3c1a2b57132a2b1d4bf53c83`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39708518718.1](https://github.com/pablontiv/backscroll/actions/runs/39708518718) | h0 | 10-22 01:56:02 | 0 | 87 | success |

### backscroll#228

- h0*: `15dbc34cc0cfb18d83c120d42ca43b70fec810a1`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39775331140.1](https://github.com/pablontiv/backscroll/actions/runs/39775331140) | h0 | 10-22 12:03:51 | 0 | 106 | success |

### backscroll#229

- h0: `367f1818e2bb338038642e61d049d3c896bf23f5`.
- h1*: `b9eedee2f133f1fe90a8513a09bc6743efc7b75c`.
- 10-22 12:13:05: h0 → h1; rebase (equivalent complete patch, changed parent).

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39775738782.1](https://github.com/pablontiv/backscroll/actions/runs/39775738782) | h0 | 10-22 12:07:00 | 0 | 77 | success |
| [39776543705.1](https://github.com/pablontiv/backscroll/actions/runs/39776543705) | h1 | 10-22 12:13:08 | 0 | 119 | success |

### backscroll#231

- h0*: `07d92ad6e3744e3943bd63d107732c10bce015b9`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39786780338.1](https://github.com/pablontiv/backscroll/actions/runs/39786780338) | h0 | 10-22 13:26:01 | 0 | 103 | success |

### backscroll#232

- h0*: `7b509d6b2a191d7eca53624434c65febccda77c5`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39798404470.1](https://github.com/pablontiv/backscroll/actions/runs/39798404470) | h0 | 10-22 14:45:00 | 0 | 110 | success |

### backscroll#234

- h0*: `dc8ad7477b22eb437f0bce77451f308edf84f9b2`.
- No post-creation head replacement observed.

| Run.attempt | Head | Created UTC | Queue | Execution | Conclusion |
|---|---|---|---:|---:|---|
| [39807009887.1](https://github.com/pablontiv/backscroll/actions/runs/39807009887) | h0 | 10-22 15:40:17 | 0 | 86 | success |

## Publication handoff and remediation drafts

These are **local drafts**, not created GitHub issues. Dagu owns publication of this report on #563 and creation/linking of the follow-ups. No comment or issue was published by the implement role. The eventual issue numbers must replace the draft labels in Dagu's publication; they are intentionally not fabricated here.

### R1 — Sign the candidate before publishing its first required-CI head

**Proposed title:** `fix(omp-dagu): publish signature-complete candidates before PR CI`

**Measured basis:** On [a4s#506](https://github.com/pablontiv/a4s/pull/506), the first workflow succeeded, then head `78412cdb952ea6c267cc07b6210983dbe9232e18` was replaced by `64e176b85408991805043543f0b70f08bbd0a2d5`. Both commits have tree `5caf46306768a1d0560a7e1e7044c989829c1c30`, parent `a4ddd5233bd13e454622472b18f785b9c241724f`, and the same message; the first is unverified/unsigned, the replacement is GitHub-verified. No code or base changed. This is a metadata/signature quality correction, not a CI-failure fix or a demonstrated rebase. The median witness's 603-second pre-final-run interval is detailed above. Avoid claiming all 603 seconds were cryptographic signing CPU time: it includes the earlier CI execution and the interval before head replacement.

**Change:** Trace the existing candidate-signing/publication path and make the first PR-visible candidate signature-complete without a subsequent same-tree/same-parent signing rewrite. Preserve the repository's signature policy and all checks; do not waive verification or reuse a check from a different SHA. Integrate with, rather than duplicate, [concurrent-candidate integration #516](https://github.com/pablontiv/a4s/issues/516).

**Acceptance:** (1) A candidate satisfying current signing policy is the first head sent to PR CI. (2) A same-tree/same-parent signature-only rewrite no longer replaces a successful required-CI head in the exercised normal path. (3) Required checks remain bound to the actual merge candidate SHA; a genuine code/base change still triggers fresh validation. (4) A recorded end-to-end example accounts separately for initial publication, any replacement, and each CI run. (5) Replay #506's observed transition and demonstrate which publication step eliminates the duplicate validation; do not claim an unmeasured latency saving.

### R2 — Project overlapping native CI/merge waits without losing the historical source

**Proposed title:** `feat(observability): preserve native wait intervals and project their overlap`

**Measured basis:** All 108 PRs in this report lack corresponding historical native journals on the reachable current station. `dagu history feature --limit 100` exposes only October 27–29; retained `feature` journals likewise have no October 15/21/22 run. An explicit lookup for `a4s-issue-323` returns `dag-run ID not found`. This does not prove when or why evidence disappeared. The reported `await_merge` median increase remains 167 seconds unallocated. PR #330's original DAG makes `await_ci` and `await_merge` siblings depending on `auto_merge`; each waits for merged successful checks. Their intervals overlap and must not be added or interpreted as disjoint CI/merge phases.

**Change:** Extend the existing [general timing projection #485](https://github.com/pablontiv/a4s/issues/485), not a second telemetry convention, to retain a small deterministic projection before native source rotation/station migration. Record source availability explicitly; preserve native start/end/attempt identity and the overlap/union of waits. Identify the supported retention location and lifecycle in the operator-owned configuration. This draft is an evidence-remediation issue, **not** a measured explanation of the 167-second latency increase.

**Acceptance:** (1) A completed representative feature run has source-backed `await_ci`/`await_merge` intervals and overlap/union durations keyed by PR/head/run/attempt. (2) The projection survives the supported source-retention lifecycle and is queryable for a later comparison. (3) Missing native input produces an explicit unavailable/residual result, never fabricated intervals. (4) Parallel waits are not summed; observer/poll delay is not called service or runner time without evidence. (5) A historical-cohort query either reproduces the median and its component sum within 10%, or reports the residual and its reason. No new retention policy, transition, or station mutation is authorized by this measurement issue.

### R3 — Apply serialized current-base integration to repeated green candidate rebases

**Proposed title:** `fix(integration): avoid repeated green-head rebases in concurrent backscroll candidates`

**Measured basis:** The October 21 backscroll median is witnessed by #220 and #221: both repeatedly replace successful heads with equivalent complete patches on changed parents (three and four rebases, respectively). Their mean lead is 6,902 seconds: 3.5 seconds initial dispatch, 305 seconds earlier successful workflows, 6,490.5 seconds between those workflow completions and the next rebase event, 16.5 seconds rebase-event→next-run dispatch, and 86.5 seconds final workflow. These are elapsed intervals, not rebase CPU time or proven BEHIND occupancy.

**Change:** Make this a measured application/acceptance slice of [#516](https://github.com/pablontiv/a4s/issues/516), preserving its coordinator-owned integration policy. Integrate candidates against the current target at the authorized admission point instead of repeatedly rewriting already-green competing heads. Do not disable current-base or required-check policy, adopt merge-queue support without capability evidence, or add a separate integration authority.

**Acceptance:** (1) Replay an equivalent concurrent-candidate sequence and record every head, parent and required check. (2) A successful candidate is not repeatedly rebased behind other admitted candidates before its own integration turn. (3) The actual merge SHA is validated against the required current target; failures and genuine code changes still receive fresh checks. (4) Compare earlier-CI, inter-run wait, dispatch and final-CI intervals with this report's #220/#221 baseline, reporting residuals rather than claiming all waiting was eliminated. (5) Link #563 and #516 when Dagu creates the issue; close as duplicate rather than invent a second implementation if #516 already contains this exact application.

### Existing integration and blocker work: do not create unsupported duplicates

[Concurrent integration #516](https://github.com/pablontiv/a4s/issues/516) already owns stale-target integration; [blocker evidence #489](https://github.com/pablontiv/a4s/issues/489) and timing projection #485 own the broader source problem. Changed-parent equivalent-patch transitions justify R3 as an acceptance/application slice of #516, not a second integration architecture; changed patch content alone does not prove a rebase or its elapsed CPU time. No runner-capacity issue is justified by zero workflow created→started clocks: these clocks cannot measure per-job runner queueing. No polling-speed optimization is justified without the missing native intervals. The **measured, actionable latency components** have R1 and R3 follow-ups; R2 covers the explicit attribution residual, rather than pretending the residual is a measured component.
