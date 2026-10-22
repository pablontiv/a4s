---
name: agent-throughput
metadata:
  author: pablontiv
  updated: "2026-10-22"
description: Measure tokens per PR, agent time per project/day, throughput, and active time without user waits across all local OMP, Pi, Claude Code and Codex projects. Use for tokens per merged PR, active agent-hours, daily wall-clock utilization, and issue/PR attribution coverage. Subscription-only accounting, with no dollar costs.
---

# Agent throughput

## What it answers

**Tokens per merged PR is the key unit.** For all projects represented in retained local sessions, report:

- Total tokens, tokens excluding cacheRead, active agent-hours, merged PRs, tokens/PR and hours/PR per project.
- Attributed tokens and hours per PR, the top 20 PRs by attributed tokens, and per-repository attribution coverage and median/p90 distributions.
- Tokens, agent-hours, wall-clock hours and merged PRs per local day, plus per-harness totals.

Project tokens/PR uses **all observed project tokens / PRs merged in the window**, including unattributed usage. It is a window-level throughput ratio, not the complete lifetime cost of each PR. Individual PR estimates use only attributed events. Projects without a local git repository show `n/a` for merged PRs and appear in the separate “No PR source (not a repository)” notes. A real repository whose GitHub identity or PR fetch fails shows `unavailable`. Daily PR counts are plain integers when all repository sources succeeded, and carry a `known` suffix when a repository source is unavailable or explicitly skipped.

This complements `skills/cost-analyzer`, which handles session-level topology/cost rather than cross-project active-time and tokens-per-merged-PR accounting.

## Data sources and fields

Only Python 3's standard library is required. `git` resolves working trees; optional authenticated `gh` supplies GitHub repository identities, the current author, and merged PRs. The script reads local stores and GitHub metadata without changing either.

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

## Token model

For OMP/Pi, total = input + output + cacheRead + cacheWrite. Auxiliary OMP model usage counts too. For Claude, deduplicate repeated content-block records by `message.id`, keeping the latest usage and unioning tool references; map its four usage fields onto the same categories.

Codex reports cumulative usage. Subtract the previous counters, resetting to current values when `input_tokens` decreases. `input_tokens` already includes `cached_input_tokens`, so uncached input = delta input − delta cached input; cacheRead = delta cached input; cacheWrite = delta `cache_write_input_tokens`; output = delta `output_tokens`. Reasoning output is already included in output. The first retained cumulative record establishes observed usage; earlier records in a selected file establish the baseline even when outside the window.

Every table's **Mtok** is total / 1,000,000; **Mtok excluding cacheRead** subtracts only cacheRead, retaining cacheWrite. These are token-volume metrics, not currency or billing estimates. The operator uses subscriptions.

## Project mapping

1. Cwds under `/tmp`, `/private/tmp`, `/var/folders` (also `/private/var/folders`), `~/.dagu/data`, or containing `.dagu-data`, map to `(tmp/poc)`.
2. Cwd equal to `$HOME` or `/Users/Shared` maps to `(no repo)`: these are parents of many projects, not a project. Cwds under `/Documents/Codex/`, `.chatgpt-projects`, or `Application Support/Claude` map to `(chat without repo)`.
3. Strip `/.workspace/worktrees/…`, `/.claude/worktrees/…`, and `/.orca/workspaces/…`. If cwd no longer exists, walk up to its nearest existing ancestor. Resolve its common repository with `git -C <dir> rev-parse --path-format=absolute --git-common-dir`, removing the final `/.git`. For example, a deleted `a4s/skills/roadmap/references` directory resolves through an existing ancestor inside a4s.
4. Collect known repository roots from successful local git resolutions in this run, then recover the remaining paths. A deleted sibling clone whose basename starts with a known root's basename plus `-`, in the same parent directory, maps to that root (for example `a4s-main` and `a4s-mechanical-routing-read` → `a4s`). Prefer the longest matching root basename when names overlap. Existing sibling directories keep their own git identity.
5. `~/.local/share/<name>/worktrees/…` maps to the known repository root whose basename is `<name>` when that basename identifies exactly one root (for example rootline's `issue-296` and `issue-297`). Ambiguous names retain ordinary ancestor/git resolution rather than selecting an arbitrary clone.
6. Resolve each verified git root with `gh repo view --json nameWithOwner`. Different clones of the same GitHub repository merge into one project. If local git recovery fails, preserve the original stripped path as a project with `n/a` PR metrics. Failed GitHub resolution preserves the verified local root with unavailable PR metrics. Special categories `(tmp/poc)`, `(no repo)`, `(chat without repo)` and `(unknown cwd)` also have `n/a` PR metrics. Missing cwd is `(unknown cwd)`; a subagent can inherit a retained main session's cwd.

`--no-prs` skips **all gh calls**, including repository identity resolution. Projects then use local common-root paths, so distinct clones are not merged by GitHub identity. Verified git repositories have explicitly skipped, unavailable PR sources; non-repository projects retain `n/a` PR metrics. Only unavailable repository sources make daily PR counts partial.

## PR fetching and author filter

Resolve the authenticated author with `gh api user -q .login`. Fetch each repository in a thread pool (8 workers):

```sh
gh pr list -R OWNER/REPO --state merged \
  --search 'merged:>=2026-09-22 merged:<=2026-10-22 author:LOGIN' \
  --limit 1000 \
  --json number,title,author,createdAt,mergedAt,headRefName,closingIssuesReferences
```

Apply the exact timestamp window and author filter again locally. Count only the authenticated author's PRs, so upstream/vendor changes and bots do not inflate throughput. The search uses inclusive UTC calendar dates derived from the window endpoints to cover local timezone offsets; exact local filtering supplies the requested boundaries. A full 1000-result response is reported as unavailable with an instruction to narrow the window. Missing gh, failed authentication, offline network and per-repo failures produce unavailable PR metrics rather than aborting local token/time accounting. A genuine successful empty response produces zero PRs and undefined per-PR ratios.

## PR attribution and coverage

Extract references from JSON-encoded **tool-call arguments**, and from OMP/Pi subagent `session_init.task` for file-level fallback:

- Issues: `issue-N`, `issue://N`, `issue://owner/repo/N`, `gh issue <verb> N`, `/issues/N`.
- PRs: `gh pr <verb> N`, `pr://N`, `pr://owner/repo/N`, `/pull/N`.

Map issues to merged PRs using both `closingIssuesReferences[].number` and `issue-(\d+)` in `headRefName`. Direct PR references match the merged set. One issue can map to multiple PRs.

For each token event, use direct turn references; otherwise use the file's references **only when they map to exactly one PR**; otherwise try its main session's references with the same uniqueness rule. Time gaps carry the latest assistant references forward and then use the same fallback. Codex token-count records carry the current turn's latest tool references. Split tokens/hours evenly among all directly referenced matching PRs; repeated references count once.

The coverage table includes repositories with at least one merged PR in the window, reporting PRs, PRs with attributed tokens, **% tokens attributed**, **% hours attributed**, median/p90 Mtok/PR and h/PR. The project table also includes repositories with a successful zero-PR result. Coverage denominators include all observed repository tokens/time. Percentiles use PRs with positive attributed tokens and positive attributed hours respectively (linear interpolation); missing attribution is not an observed zero-cost PR. JSON preserves raw token/hour units and the project source status (`available`, `unavailable` or `not_repository`); Markdown scales token fields to Mtok.

## Limitations

- **Raw session retention bounds usage coverage: tokens only exist while the JSONL files exist.** Backscroll `~/.backscroll.db` retains text and timestamps but has **no usage columns**, so it cannot recover token totals. Codex raw files expire sooner; comparisons across harnesses/dates can be biased by unequal retention.
- Regex attribution is approximate, so **report coverage with every PR comparison**. References mention work, not causality. Repository-qualified references are interpreted by number in the session's mapped repository; cross-repository coordination can misattribute them. Human prose without a tool/task reference is not matched.
- Work may occur before or after the selected merge window, span several PRs, or produce no PR. Low coverage and window-level ratios are not proof of individual PR lifetime expenditure or agent quality.
- Active time is observed wall time while the main session is working, not CPU time or human labor. The gap cap trades overcounting hung sessions for undercounting legitimate long operations. Agent-hours can exceed wall-clock hours because of concurrency.
- Only projects present in retained, mtime-selected session files are queried. Missing/deleted projects, unavailable GitHub metadata and missing raw files limit all-project completeness; partial daily PR counts are explicitly marked.

## Usage

Run from the repository root:

```sh
# Rolling 30 × 24 hours ending now, all local harnesses and projects.
python3 skills/agent-throughput/assets/throughput.py --days 30

# Inclusive local start, exclusive local end: includes every event on October 15.
python3 skills/agent-throughput/assets/throughput.py \
  --since 2026-10-15 --until 2026-10-16 --out /tmp/agent-throughput.md

# Local stores only, shorter gap cap, machine-readable raw token/hour units.
python3 skills/agent-throughput/assets/throughput.py \
  --days 7 --cap-minutes 15 --no-prs --json --out /tmp/agent-throughput.json

# Regression suite (small synthetic JSONL fixtures, no gh or real stores).
cd skills/agent-throughput/assets && python3 -m unittest -v
```

`--days` defaults to 30 and is mutually exclusive with `--since`; `--until` requires `--since` and otherwise defaults to now. Dates use the machine's local timezone. Each report records the exact offset-bearing timestamp boundaries, local timezone abbreviation(s), cap and runtime. `--out` writes the requested format to that file instead of stdout. All temporary fixtures are owned and removed by the tests.
