---
name: agent-throughput
metadata:
  author: pablontiv
  updated: "2026-10-22"
description: Measure tokens per PR, agent time per project/day, throughput, and active time without user waits across all local OMP, Pi, Claude Code and Codex projects. Use for tokens per merged PR, active agent-hours, daily wall-clock utilization, and issue/PR attribution coverage. Subscription-only accounting, with no dollar costs.
---

# Agent throughput

## What it answers

**Tokens per merged PR is the key unit.** For all workspaces represented in retained local sessions, report:

- Total tokens, tokens excluding cacheRead, active agent-hours, member repositories, merged PRs, tokens/PR and hours/PR per workspace.
- Attributed tokens and hours for **every merged PR in JSON**, the top 20 PRs by attributed tokens in Markdown, and per-repository attribution coverage and median/p90 distributions.
- Tokens, agent-hours, wall-clock hours, distinct active main sessions, peak/mean main-session concurrency, subagent token share and merged PRs per local day, plus per-harness totals.

Workspace tokens/PR uses **all observed workspace tokens / the union of member-repository PRs merged in the window**, including unattributed usage. It is a window-level throughput ratio, not the complete lifetime cost of each PR. Individual PR estimates use only attributed events. Workspaces without a supported PR source show `n/a` and appear in “No supported PR source” notes; this includes git repositories with no origin or a non-GitHub/non-Azure origin. If a supported member's provider CLI, authentication or fetch fails, its workspace shows `unavailable`, retaining known partial counts in JSON. Daily PR counts are plain integers when all supported sources succeeded, and carry a `known` suffix when a supported source is unavailable or explicitly skipped.

This complements `skills/cost-analyzer`, which handles session-level topology/cost rather than cross-project active-time and tokens-per-merged-PR accounting.

## Data sources and fields

Only Python 3's standard library is required. Local git markers and `commondir` resolve working trees; `git config` supplies the origin remote once per common directory. Optional authenticated `gh` supplies GitHub PRs; optional `az` with the Azure DevOps extension supplies Azure PRs and linked work items. Optional Orca supplies folder and git registrations through `orca repo list --json` (`result.repos[].{kind,path}`). The script reads local stores, registrations and provider metadata without changing them.

Retained JSONL files are parsed in batches by up to four persistent Python worker processes. Attribution caches each session's reference fallback and repeated turn-reference sets; provider CLI calls use threads.

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
3. Sessions whose cwd is the declared folder itself, or is inside any member repository/worktree, roll up to that folder's row. The folder's merged PR count is the union of `(repository, PR number)` across all members, including members without sessions in the window. An individual repository outside a declared folder reports as itself. When declarations overlap, prefer the most deeply containing folder, with deterministic path order for otherwise equal ownership.
4. Undeclared cwds under `/tmp`, `/private/tmp`, `/var/folders` (also `/private/var/folders`), `~/.dagu/data`, or containing `.dagu-data`, map to `(tmp/poc)`. `$HOME` and `/Users/Shared` map to `(no repo)` unless explicitly declared as folders; the same classification applies when ancestor walking discovers their git markers. A folder-cwd session belongs to its declared workspace and uses that workspace's member repositories for attribution. Cwds under `/Documents/Codex/`, `.chatgpt-projects`, or `Application Support/Claude` map to `(chat without repo)`. Missing cwd maps to `(unknown cwd)`; a subagent can inherit a retained main session's cwd.
5. Strip `/.workspace/worktrees/…`, `/.claude/worktrees/…`, and `/.orca/workspaces/…`. Resolve existing or nearest existing ancestor directories by walking git markers and linked-worktree `commondir` files, removing the common root's final `/.git`. A deleted `a4s/skills/roadmap/references` directory can resolve through an existing ancestor inside a4s. Cache marker and origin resolution by directory; session parsing does not spawn per-session git/remote commands.
6. Collect known common roots from sessions and registrations, then recover deleted sibling clones in the same parent when their basename starts with a known root basename plus `-` (for example `a4s-main` → `a4s`). Prefer the longest matching basename. Existing sibling directories retain their own git identity. `~/.local/share/<name>/worktrees/…` maps to a known root whose basename is `<name>` only when unique.
7. If local git recovery fails, retain the stripped path with `n/a` PR metrics. A git member with no supported origin retains its local root as its identity and also has `n/a` metrics. Special categories have `n/a` metrics. A folder has an applicable PR denominator whenever at least one member has a GitHub/Azure origin; unsupported members contribute usage but not unavailable PR sources.

`--no-prs` skips **all gh/az calls**. Origin identities and folder rollup still resolve locally, so same-remote clones merge normally. Supported provider sources are explicitly skipped/unavailable; unsupported origins, folders without supported members and non-repository workspaces retain `n/a`. Only unavailable supported sources make daily PR counts partial.

## PR fetching and author filter

Provider authentication, repository fetches and Azure work-item lookups use an eight-worker thread pool. Orca registration discovery overlaps local parsing.

**GitHub:** resolve the authenticated author with `gh api user -q .login`, then fetch each GitHub origin:

```sh
gh pr list -R OWNER/REPO --state merged \
  --search 'merged:>=2026-09-22 merged:<=2026-10-22 author:LOGIN' \
  --limit 1000 \
  --json number,title,author,createdAt,mergedAt,headRefName,closingIssuesReferences
```

Apply the exact timestamp window and case-insensitive author filter again locally. Count only the authenticated author's PRs, so upstream/vendor changes and bots do not inflate throughput. GitHub search uses inclusive UTC calendar dates derived from the window endpoints to cover local timezone offsets; exact local filtering supplies the requested boundaries.

**Azure DevOps:** resolve the author with `az account show --query user.name -o tsv`, then:

```sh
az repos pr list --org https://dev.azure.com/ORG \
  --project PROJECT --repository REPO --status completed --top 1000 -o json
az repos pr work-item list --id PR_NUMBER --org https://dev.azure.com/ORG \
  --query '[].id' -o json
```

Azure fields are `pullRequestId`, `status`, `createdBy.uniqueName`, `creationDate`, `closedDate`, `title` and `sourceRefName`. A merged PR has `status: completed`, `closedDate` inside the exact window and `createdBy.uniqueName` equal to the Azure account user, case-insensitively. Fetch linked work-item IDs for each selected PR in the shared thread pool. Normalize both providers to the same number/title/merge-time/branch/linked-issue representation.

A full 1000-result response is unavailable with an instruction to narrow the window. Missing CLIs, failed authentication, offline network and per-repository failures produce unavailable metrics **only for affected provider repositories** rather than aborting local accounting. A successful empty response produces zero PRs and undefined per-PR ratios.

## PR attribution and coverage

Extract references from JSON-encoded **tool-call arguments**, and from OMP/Pi subagent `session_init.task` for file-level fallback:

- Issues: `issue-N`, `issue://N`, `issue://owner/repo/N`, `gh issue <verb> N`, `/issues/N`.
- PRs: `gh pr <verb> N`, `pr://N`, `pr://owner/repo/N`, `/pull/N`.
- Qualified member references: `gh issue/pr <verb> N -R owner/repo` (also `--repo`), `owner/repo#N`, full GitHub issue/PR URLs, `issue://owner/repo/N` and `pr://owner/repo/N`. Hash references may identify either a merged PR or an issue linked to one.
- Azure PRs: `/pullrequest/N`, `az repos pr <verb> … --id N`; work items: `AB#N`, `/_workitems/edit/N`, `az boards work-item <verb> … --id N`. Full Azure PR URLs qualify the organization/project/repository; work-item URLs qualify their project (or repository when present). Azure command flags `--org`, `--project` and `--repository` narrow the scope when supplied.
- PR sibling-clone paths such as `DSPRIMA.PlatformNG-pr213-host-qa` reference PR 213, qualified by repository basename. The basename must resolve uniquely among workspace members.
- Source branches with `feature/`, `feat/`, `fix/`, `hotfix/`, `docs/` or `ci/` prefixes, optionally under `refs/heads/`, match the exact merged PR source branch. Azure `az repos pr create --source-branch …` also supplies a branch reference, with any supplied repository/project/organization qualification.

Map GitHub issues to merged PRs using both `closingIssuesReferences[].number` and `issue-(\d+)` in `headRefName`. Azure work-item mapping uses linked work-item IDs, `issue-N` branches and a work-item number at the start of a branch component such as `feature/783-poster`. A source-branch reference first matches its exact PR branch; when that branch is absent from the merged set, a numeric branch component falls back to linked work-item mapping. Direct PR references match the merged set. One issue/work item can map to multiple PRs.

Repository-cwd sessions resolve references within that repository; qualification must match it. For folder-cwd sessions, qualified references narrow member candidates, including Azure commands that supply only `--repository` or `--project`. An unqualified, basename-qualified or partially scoped reference is accepted only when exactly one matching member repository maps it to merged PRs; overlapping references across members remain unattributed. An ambiguous direct reference also remains unattributed when a unique file fallback exists.

For each token event, use direct turn references; otherwise use the file's references **only when they map to exactly one PR**; otherwise try its main session's references with the same uniqueness rule. Time gaps carry the latest assistant references forward and then use the same fallback. Codex token-count records carry the current turn's latest tool references. Split tokens/hours evenly among all directly referenced matching PRs; repeated references count once.

The JSON `prs` array contains every fetched merged PR, including records with zero attributed usage: `repo`, `number`, `title`, `mergedAt`, `headRefName`, `tokens`, `agent_hours` and provider metadata. Each record's `refs_sources` lists the observed attribution provenance, grouped by consuming session file and selection kind (`direct`, `file_fallback`, `main_fallback`): harness, consuming `session_file`, `reference_file`, matched `references` tuples, attributed tokens and hours. References include only those selecting that PR; fallback provenance identifies the file supplying the references. Source amounts sum to that PR's amounts, including even splits. An unattributed PR has an empty source list; it is not a zero-cost observation. JSON units are raw tokens and hours, not Mtok.

The coverage table remains **per repository**, using provider-qualified names, for repositories with at least one merged PR in the window. It reports PRs, PRs with attributed tokens, **% tokens attributed**, **% hours attributed**, median/p90 Mtok/PR and h/PR. Repository coverage denominators include all observed usage in repository-cwd sessions and single-member folder sessions. In multi-member folder-cwd sessions, only repository-resolvable portions can enter repository denominators; ambiguous/unreferenced usage stays in workspace/day/harness totals. Thus repository coverage alone does not measure all folder-level attribution. The workspace table also includes successful zero-PR results. Percentiles use PRs with positive attributed tokens and positive attributed hours respectively (linear interpolation); missing attribution is not an observed zero-cost PR. JSON preserves raw token/hour units, member repositories, known partial merge counts, a `repositories` summary including zero-PR members, and source status (`available`, `unavailable` or `not_applicable`); Markdown scales tokens to Mtok.

## Investigating an outlier day

1. **Compare neighboring days before proposing a cause.** Batch issue creation and subagent use persist on both high- and low-throughput days, so their presence alone is not a differentiator. Inspect active/peak/mean main-session concurrency and subagent token share, then inspect coordinator roles and the length of the implementation → acceptance → merge path. Main-session counts include all roles; retained session content establishes which were coordinators. Keep event-day, merge-day and attribution-window boundaries explicit.
2. **Reconstruct Dagu from retained runs.** Read the latest status snapshot in `~/.dagu/data/dag-runs/<dag>/dag-runs/YYYY/MM/DD/dag-run_*/a_*/status.jsonl` and the run's `dag.json`, including encoded `yamlData`/`baseConfigData`. Use that immutable definition and params `REPO`, `BRANCH`, `GATE`, `REQUIRED_CHECK`, `OMP_SESSION_ID`; the last field identifies the owning coordinator, not necessarily its implementation worker. Observed status codes are 4=succeeded, 2=failed, 3=aborted, 7=waiting. UTC directory dates differ from local event days: filter timestamps, and clip intervals to the local day. Deduplicate step executions by run, step name and start timestamp across native attempts; group `-vN` reruns separately from checkpoint resumes. Extract implement, gate, PR, auto_merge, await_merge and quality-review durations when present. Distinguish human-task/checkpoint elapsed time from model runtime and command execution. Measure per-repository queue concurrency from actual running command intervals; waiting lifecycle runs can coexist outside queue occupancy. A succeeded feature run is not necessarily a merged PR: PoC-routed parents can succeed while delivery steps are skipped.
3. **Check GitHub's acceptance clock.** Run `gh pr view N -R OWNER/REPO --json statusCheckRollup,autoMergeRequest,mergedBy,reviews` alongside issue/PR creation and merge timestamps. Inspect auto-merge enablement, historical required-check identity from run params, check execution/completion and merge timing. A missing auto-merge request does not establish a manual merge, and the account shown as merger does not establish a human action. Separate issue → PR, PR → merge and issue → merge: the PR clock excludes implementation/local gates. Final-head rollups are not a complete history of all check attempts. Measure CI as three separate clocks: PR creation → required check completion, workflow span (`gh run view` created → updated), and required job duration. A required aggregate job that `needs` upstream jobs reports only its own seconds, so the lead-time clocks carry the CI cost.
4. **Compare fixed merge cohorts with equal follow-up.** Set a 2- or 6-day window relative to each original merge and a fixed evidence cutoff. Compare fully elapsed windows; label immature cohorts as censored. Collect R=targeted revert, E=explicit reference in a later merged PR/new issue, F=later fix PR with substantive-file overlap, O=reopened closing issue, L=new linked PR. Exclude lockfiles, generated bundles/build output and changelogs from substantive overlap. Report provenance-only R+E+O+L beside broad R+E+F+O+L, retaining exact references/timestamps. Deduplicate later merged PRs across the cohort and use the complete JSON `prs` export: **effective Mtok/PR = (cohort attributed Mtok + unique later outside-cohort attributed Mtok) / cohort PR count**. Preserve attribution coverage and the token observation window. These associations are not causal defect costs; planned follow-ups and shared-file hotspots can create signals.

Historical reference snapshot (GitHub merge cohorts in local UTC−6, 6-day mature follow-up; fixed attribution/evidence snapshot, **not expected current CLI output**):

| Merge day | PRs | Targeted reverts | Reopened closing issues | Provenance effective Mtok/PR | Broad effective Mtok/PR |
| --- | --- | --- | --- | --- | --- |
| 2026-10-13 | 57 | 0 | 0% | 4.26 | 8.06 |
| 2026-10-14 | 51 | 0 | 2% | 4.62 | 17.59 |
| 2026-10-15 | 120 | 0 | 8% | 10.15 | 16.97 |

In that October 15 cohort, closing issues reopened for 0/95 `dagu/`-branch PRs versus 10/25 other PRs. Branch naming describes the cohort rather than proving run execution or causal quality. The broad and provenance-only estimates deliberately answer different association questions.

## Limitations

- **Raw session retention bounds usage coverage: tokens only exist while the JSONL files exist.** Backscroll `~/.backscroll.db` retains text and timestamps but has **no usage columns**, so it cannot recover token totals. Codex raw files expire sooner; comparisons across harnesses/dates can be biased by unequal retention.
- Regex attribution is approximate, so **report coverage with every PR comparison**. References mention work, not causality. Qualified references resolve only within the session repository or declared folder members; unqualified references in multi-repository folders require a unique repository match. Human prose without a tool/task reference is not matched.
- Work may occur before or after the selected merge window, span several PRs, or produce no PR. Low coverage and window-level ratios are not proof of individual PR lifetime expenditure or agent quality.
- Active time is observed wall time while the main session is working, not CPU time or human labor. The gap cap trades overcounting hung sessions for undercounting legitimate long operations. Agent-hours can exceed wall-clock hours because of concurrency.
- Only workspaces present in retained, mtime-selected session files are reported; a declared folder's complete member set supplies its PR sources. Missing/deleted repositories, failed member discovery, unavailable provider metadata and missing raw files limit all-project completeness; partial daily PR counts are explicitly marked.
- Azure linked work items reflect the PR's current associations, which may have changed since completion.

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
  --days 7 --cap-minutes 15 --no-prs --json --out /tmp/agent-throughput.json

# Regression suite (small synthetic JSONL fixtures, no gh or real stores).
cd skills/agent-throughput/assets && python3 -m unittest -v
```

`--days` defaults to 30 and is mutually exclusive with `--since`; `--until` requires `--since` and otherwise defaults to now. Dates use the machine's local timezone. Each report records the exact offset-bearing timestamp boundaries, local timezone abbreviation(s), cap and runtime. `--out` writes the requested format to that file instead of stdout. All temporary fixtures are owned and removed by the tests.
