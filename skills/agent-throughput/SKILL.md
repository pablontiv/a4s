---
name: agent-throughput
metadata:
  author: pablontiv
  updated: "2026-10-22"
description: Measure tokens per merged change, agent time per project/day, throughput, and active time without user waits across all local OMP, Pi, Claude Code and Codex projects. Use for tokens per merge, active agent-hours, daily wall-clock utilization, and issue/merge attribution coverage. Subscription-only accounting, with no dollar costs.
---

# Agent throughput

## What it answers

**Tokens per merged change is the key unit.** For all workspaces represented in retained local sessions, report:

- Total tokens, tokens excluding cacheRead, active agent-hours, member repositories, merged changes, tokens/merge and hours/merge per workspace.
- Attributed tokens and hours for **every merged change in JSON**, the top 20 merged changes by attributed tokens in Markdown, and per-repository attribution coverage and median/p90 distributions.
- Tokens, agent-hours, wall-clock hours, distinct active main sessions, peak/mean main-session concurrency, subagent token share and merged changes per local day, plus per-harness totals.

Workspace tokens/merge uses **all observed workspace tokens / the union of member-repository merge commits in the window**, including unattributed usage. It is a window-level throughput ratio, not the complete lifetime cost of each merged change. Individual merge estimates use only attributed events. Workspaces without accessible default-branch history show `n/a`; incomplete history makes counts partial rather than zero.

This complements `skills/cost-analyzer`, which handles session-level topology/cost rather than cross-project active-time and tokens-per-merge accounting.

## Data sources and fields

Only Python 3's standard library is required for local session accounting. Local git markers and `commondir` resolve working trees; `git config` supplies the origin remote once per common directory. Default-branch Git history supplies merge commits. Optional Orca supplies folder and git registrations through `orca repo list --json` (`result.repos[].{kind,path}`). Read local stores, registrations and history without changing them.

Retained JSONL files are parsed in batches by up to four persistent Python worker processes. Attribution caches each session's reference fallback and repeated turn-reference sets.

| Harness | Store | Usage and event fields |
| --- | --- | --- |
| OMP | `~/.omp/agent/sessions/**/*.jsonl` | `session.cwd`; assistant `message.usage.{input,output,cacheRead,cacheWrite}`, `provider`, `stopReason`; `message.content` tool calls and tool results; auxiliary `model_usage.usage` records |
| Pi | `~/.pi/agent/sessions/**/*.jsonl` | Same format as OMP, including `session_init.task` references; exclude provider `faux` usage and sessions whose only provider is `faux` (test sessions) |
| Claude Code | `~/.claude/projects/**/*.jsonl` | Record `cwd`, `timestamp`, `isSidechain`; assistant `message.id`, `usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}`, `stop_reason`; content `tool_use` and `tool_result` |
| Codex | `~/.codex/sessions/**/*.jsonl` and `~/.codex/archived_sessions/**/*.jsonl` | `session_meta.payload.{cwd,id,source}`; `event_msg` task start/end and `token_count.info.total_token_usage`; `response_item` calls and outputs linked by `call_id` |

Select files with mtime at or after the window start, but bucket/filter usage by **event timestamp**. Malformed JSONL lines and unreadable/vanished files are counted in the report's warnings. Reading a file already being appended may encounter a partial last line; rerun after the writer finishes if that warning matters.

OMP/Pi subagents live under `<project>/<main-session-stem>/<Name>.jsonl`, with deeper nesting for nested agents. Claude subagents live under `<session-id>/subagents/`; `isSidechain` records contribute usage but not the main timeline. Codex `source` objects containing `subagent` identify subagent threads; when available, `thread_spawn.parent_thread_id` links their main session. Duplicate live/archived Codex rollout UUIDs use the largest file. Codex turns whose `turn_id` starts with `external-import` are imported Claude history: skip their events/usage while updating the cumulative baseline so the next real turn does not inherit imported tokens.

## Time model

Sort each main session's events by timestamp, then classify the gap **after** each event:

- **Active:** a user message starts work, or an assistant tool call continues work. Normal tool execution and waiting on subagents are agent work.
- **Idle:** an assistant stop reason other than `toolUse`/`tool_use` ends work (including stop, aborted and error). Exclude time until the next user or assistant message resumes the session. The gap preceding that next message stays idle.
- **Ask:** while a question tool is pending, exclude time until its result arrives. Names include `ask`, `ask_user_question`, `AskUserQuestion`, `request_user_input`, and the observed `question`/`ask_user` aliases. Claude user records containing `tool_result` are results, not new user requests.
- Passive notices (`custom_message`, including dagu-state, irc:incoming, async-result and eval-state-context; developer/custom role messages) preserve the current state. A notice after an aborted turn leaves the session idle.

Cap each active inter-event gap at **30 minutes** by default (`--cap-minutes`). Retain the first capped portion, then clip to the requested window. This bounds hung tools, closed clients, and unanswered turns. Count only observed gaps with two endpoints, not an open tail from the last event to now. Ask/idle gaps contribute no hours.

**Agent-hours** sum active intervals from main sessions; overlapping sessions count separately. Subagent tokens count, but their time is already represented by the parent session and is not added. **Wall-clock hours** union all overlapping active main-session intervals across projects/harnesses. Split intervals at local midnight before day aggregation, including daylight-saving changes. Thus wall-h ≤ agent-h, and wall-h per local date is bounded by that date's actual length.

Daily **active main sessions** count distinct retained main-session files with a positive active interval that day, including non-coordinator sessions. **Peak concurrent mains** uses an exact half-open interval sweep, merging each session's overlapping/adjacent intervals first and processing ends before starts at identical timestamps. **Mean concurrency** is agent-h / wall-h. These measures use observed activity, rather than token timestamps or open clients. **Subagent token %** is 100 × subagent tokens / all tokens across harnesses; a day with no tokens or no active time reports zero for the corresponding share/mean. Split cross-midnight intervals before counting each day's sessions.

## Token model

For OMP/Pi, total = input + output + cacheRead + cacheWrite. Auxiliary OMP model usage counts too. For Claude, deduplicate repeated content-block records by `message.id`, keeping the latest usage and unioning tool references; map its four usage fields onto the same categories.

Codex reports cumulative usage. Subtract the previous counters, resetting to current values when `input_tokens` decreases. `input_tokens` already includes `cached_input_tokens`, so uncached input = delta input − delta cached input; cacheRead = delta cached input; cacheWrite = delta `cache_write_input_tokens`; output = delta `output_tokens`. Reasoning output is already included in output. The first retained cumulative record establishes observed usage; earlier records in a selected file establish the baseline even when outside the window.

Every table's **Mtok** is total / 1,000,000; **Mtok excluding cacheRead** subtracts only cacheRead, retaining cacheWrite. These are token-volume metrics, not currency or billing estimates. The operator uses subscriptions.

## Workspace and project mapping

The reporting unit is a **workspace**: a declared folder containing repositories, or a single repository. The project table's `Repos` column identifies its members with provider-qualified identities.

1. Read Orca registrations with `repo list --json`, distinguishing `kind: folder` from `kind: git`. Merge folder registrations with repeatable `--workspace PATH` flags. If Orca is unavailable, report that limitation and use explicit folder declarations plus locally resolved git repositories. Parent directories become folder workspaces only through these declarations.
2. Discover git markers (`.git` directory or file) at depths one and two below each declared folder. Resolve common git roots, including linked worktrees, and read each distinct common directory's **origin** remote. Normalize GitHub identities to `github:owner/repo` and Azure DevOps identities to `ado:org/project/repo`. GitHub HTTPS/SSH origins and Azure `dev.azure.com`, `org.visualstudio.com` (including `DefaultCollection`) and `ssh.dev.azure.com:v3/org/project/repo` origins are supported. URL-decode names and discard userinfo/credentials. Same-origin clones/worktrees merge case-insensitively, retaining deterministic Azure display casing.
3. Sessions whose cwd is the declared folder itself, or is inside any member repository/worktree, roll up to that folder's row. The folder's merged-change count is the union of `(repository, merge commit SHA)` across all members, including members without sessions in the window. An individual repository outside a declared folder reports as itself. When declarations overlap, prefer the most deeply containing folder, with deterministic path order for otherwise equal ownership.
4. Undeclared cwds under `/tmp`, `/private/tmp`, `/var/folders` (also `/private/var/folders`), `~/.dagu/data`, or containing `.dagu-data`, map to `(tmp/poc)`. `$HOME` and `/Users/Shared` map to `(no repo)` unless explicitly declared as folders; the same classification applies when ancestor walking discovers their git markers. A folder-cwd session belongs to its declared workspace and uses that workspace's member repositories for attribution. Cwds under `/Documents/Codex/`, `.chatgpt-projects`, or `Application Support/Claude` map to `(chat without repo)`. Missing cwd maps to `(unknown cwd)`; a subagent can inherit a retained main session's cwd.
5. Strip `/.workspace/worktrees/…`, `/.claude/worktrees/…`, and `/.orca/workspaces/…`. Resolve existing or nearest existing ancestor directories by walking git markers and linked-worktree `commondir` files, removing the common root's final `/.git`. A deleted `a4s/skills/roadmap/references` directory can resolve through an existing ancestor inside a4s. Cache marker and origin resolution by directory; session parsing does not spawn per-session git/remote commands.
6. Collect known common roots from sessions and registrations, then recover deleted sibling clones in the same parent when their basename starts with a known root basename plus `-` (for example `a4s-main` → `a4s`). Prefer the longest matching basename. Existing sibling directories retain their own git identity. `~/.local/share/<name>/worktrees/…` maps to a known root whose basename is `<name>` only when unique.
7. If local git recovery fails, retain the stripped path with `n/a` merge metrics. Special categories have `n/a` metrics. A folder has an applicable merge denominator whenever at least one member has accessible default-branch history; unavailable members contribute usage but not fabricated merge counts.

## Merge history and author filter

Work is committed in a worktree, merged locally into `main`, and pushed. CI runs after the push. Identify merged changes from the default branch's first-parent merge commits in the exact reporting window, deduplicated by repository and SHA. Record the author filter and timestamp convention used; local history alone does not prove that a merge was pushed. Missing or incomplete history produces unavailable or explicitly partial metrics only for affected repositories. An accessible history with no matching merges produces zero merged changes and undefined per-merge ratios.

## Merge attribution and coverage

Extract references from JSON-encoded **tool-call arguments**, and from OMP/Pi subagent `session_init.task` for file-level fallback:

- Issues: `issue-N`, `issue://N`, `issue://owner/repo/N`, `gh issue <verb> N`, `/issues/N`.
- Qualified member references: `gh issue <verb> N -R owner/repo` (also `--repo`), `owner/repo#N`, full issue URLs and `issue://owner/repo/N`.
- Commits: exact repository-qualified commit SHAs and source-branch references whose commits are included in a merge.
- Azure work items: `AB#N`, `/_workitems/edit/N`, `az boards work-item <verb> … --id N`. Organization/project/repository qualification narrows the scope when supplied.

Map issues and work items to merge commits only when commit messages or retained execution evidence explicitly link them. Repository-cwd sessions resolve references within that repository; qualification must match it. For folder-cwd sessions, accept a reference only when exactly one member repository resolves it. Ambiguous references remain unattributed.

For each token event, use direct turn references; otherwise use the file's references **only when they map to exactly one merge**; otherwise try its main session's references with the same uniqueness rule. Time gaps carry the latest assistant references forward and then use the same fallback. Codex token-count records carry the current turn's latest tool references. Split tokens/hours evenly among all directly referenced matching merges; repeated references count once.

Report every merged change, including records with zero attributed usage, with its repository, commit SHA, title, merge timestamp, tokens and agent-hours. Preserve attribution provenance grouped by consuming session file and selection kind (`direct`, `file_fallback`, `main_fallback`), including the reference file and matched references. Source amounts must sum to each merge's amounts, including even splits. An unattributed merge is not a zero-cost observation. JSON units are raw tokens and hours, not Mtok.

The coverage table remains **per repository**, using provider-qualified names, for repositories with at least one merge in the window. It reports merges, merges with attributed tokens, **% tokens attributed**, **% hours attributed**, median/p90 Mtok/merge and h/merge. Repository coverage denominators include all observed usage in repository-cwd sessions and single-member folder sessions. In multi-member folder-cwd sessions, only repository-resolvable portions can enter repository denominators; ambiguous/unreferenced usage stays in workspace/day/harness totals. Thus repository coverage alone does not measure all folder-level attribution. Include successful zero-merge results. Percentiles use merges with positive attributed tokens and positive attributed hours respectively (linear interpolation); missing attribution is not an observed zero-cost merge. Preserve raw units, member repositories, known partial merge counts and history availability; Markdown scales tokens to Mtok.

## Investigating an outlier day

1. **Compare neighboring days before proposing a cause.** Batch issue creation and subagent use persist on both high- and low-throughput days, so their presence alone is not a differentiator. Inspect active/peak/mean main-session concurrency and subagent token share, then inspect coordinator roles and the length of the implementation → acceptance → merge path. Main-session counts include all roles; retained session content establishes which were coordinators. Keep event-day, merge-day and attribution-window boundaries explicit.
2. **Reconstruct Dagu from retained runs.** Read the latest status snapshot in `~/.dagu/data/dag-runs/<dag>/dag-runs/YYYY/MM/DD/dag-run_*/a_*/status.jsonl` and the run's `dag.json`, including encoded `yamlData`/`baseConfigData`. Use that immutable definition and params `REPO`, `BRANCH`, `GATE`, `REQUIRED_CHECK`, `OMP_SESSION_ID`; the last field identifies the owning coordinator, not necessarily its implementation worker. Observed status codes are 4=succeeded, 2=failed, 3=aborted, 7=waiting. UTC directory dates differ from local event days: filter timestamps, and clip intervals to the local day. Deduplicate step executions by run, step name and start timestamp across native attempts; group `-vN` reruns separately from checkpoint resumes. Extract implementation, gate, local merge, push and quality-review durations when present. Distinguish human-task/checkpoint elapsed time from model runtime and command execution. Measure per-repository queue concurrency from actual running command intervals; waiting lifecycle runs can coexist outside queue occupancy. A succeeded feature run does not necessarily establish integration: inspect the local merge and push evidence.
3. **Check the integration clock.** Separate issue → commit, commit → local merge, merge → push and push → CI completion. CI runs after the push; use `gh run view` timestamps and job durations to distinguish workflow span from required job duration. A required aggregate job that `needs` upstream jobs reports only its own seconds, so lead-time clocks carry the CI cost. Record the pushed default-branch SHA and match CI to that SHA.
4. **Compare fixed merge cohorts with equal follow-up.** Set a 2- or 6-day window relative to each original merge and a fixed evidence cutoff. Compare fully elapsed windows; label immature cohorts as censored. Collect R=targeted revert, E=explicit reference in a later merged change/new issue, F=later fix with substantive-file overlap, O=reopened closing issue, L=new linked merged change. Exclude lockfiles, generated bundles/build output and changelogs from substantive overlap. Report provenance-only R+E+O+L beside broad R+E+F+O+L, retaining exact references/timestamps. Deduplicate later merged changes across the cohort: **effective Mtok/merge = (cohort attributed Mtok + unique later outside-cohort attributed Mtok) / cohort merge count**. Preserve attribution coverage and the token observation window. These associations are not causal defect costs; planned follow-ups and shared-file hotspots can create signals.

Historical reference snapshot (GitHub merge cohorts in local UTC−6, 6-day mature follow-up; fixed attribution/evidence snapshot, **not expected current CLI output**):

| Merge day | Merges | Targeted reverts | Reopened closing issues | Provenance effective Mtok/merge | Broad effective Mtok/merge |
| --- | --- | --- | --- | --- | --- |
| 2026-10-13 | 57 | 0 | 0% | 4.26 | 8.06 |
| 2026-10-14 | 51 | 0 | 2% | 4.62 | 17.59 |
| 2026-10-15 | 120 | 0 | 8% | 10.15 | 16.97 |

In that October 15 cohort, closing issues reopened for 0/95 `dagu/`-branch merged changes versus 10/25 other merged changes. Branch naming describes the cohort rather than proving run execution or causal quality. The broad and provenance-only estimates deliberately answer different association questions.

## Limitations

- **Raw session retention bounds usage coverage: tokens only exist while the JSONL files exist.** Backscroll `~/.backscroll.db` retains text and timestamps but has **no usage columns**, so it cannot recover token totals. Codex raw files expire sooner; comparisons across harnesses/dates can be biased by unequal retention.
- Regex attribution is approximate, so **report coverage with every merge comparison**. References mention work, not causality. Qualified references resolve only within the session repository or declared folder members; unqualified references in multi-repository folders require a unique repository match. Human prose without a tool/task reference is not matched.
- Work may occur before or after the selected merge window, span several merges, or produce no merge. Low coverage and window-level ratios are not proof of individual change lifetime expenditure or agent quality.
- Active time is observed wall time while the main session is working, not CPU time or human labor. The gap cap trades overcounting hung sessions for undercounting legitimate long operations. Agent-hours can exceed wall-clock hours because of concurrency.
- Only workspaces present in retained, mtime-selected session files are reported; a declared folder's complete member set supplies its merge history. Missing/deleted repositories, failed member discovery, incomplete history and missing raw files limit all-project completeness; partial daily merge counts must be explicitly marked.
- Issue and work-item links reflect retained evidence and may not capture later association changes.

## Usage

Run from the repository root:

```sh
# Rolling 30 × 24 hours ending now, all local harnesses and projects.
python3 skills/agent-throughput/assets/throughput.py --days 30

# Inclusive local start, exclusive local end: includes every event on October 15.
python3 skills/agent-throughput/assets/throughput.py \
  --since 2026-10-15 --until 2026-10-16 --out /tmp/agent-throughput.md

# Declare an additional multi-repository folder (repeat for several folders).
python3 skills/agent-throughput/assets/throughput.py \
  --days 30 --workspace /Users/Shared/dsprima --workspace /work/another-team

# Local stores only, shorter gap cap, machine-readable raw token/hour units.
python3 skills/agent-throughput/assets/throughput.py \
  --days 7 --cap-minutes 15 --json --out /tmp/agent-throughput.json

# Regression suite (small synthetic JSONL fixtures, no gh or real stores).
cd skills/agent-throughput/assets && python3 -m unittest -v
```

`--days` defaults to 30 and is mutually exclusive with `--since`; `--until` requires `--since` and otherwise defaults to now. Dates use the machine's local timezone. Each report records the exact offset-bearing timestamp boundaries, local timezone abbreviation(s), cap and runtime. `--out` writes the requested format to that file instead of stdout. All temporary fixtures are owned and removed by the tests.
