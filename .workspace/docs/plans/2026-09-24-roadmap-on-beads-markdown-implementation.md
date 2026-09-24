---
tipo: plan
---
# Roadmap on Beads Markdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the public `beads-loop` skill with a Markdown-only Roadmap bundle whose Plan, tree, Doctor and loop recipes operate directly on Beads.

**Architecture:** Roadmap is documentation, not software. `SKILL.md` routes four modes to focused Markdown references; those references tell the agent which direct `bd` commands to run, when to ask for approval, how to interpret topology and how to combine Bead acceptance with `.workspace` DoD. No custom runtime, parser, adapter or test framework is introduced.

**Tech Stack:** Agent Skills Markdown, Beads 1.3.0 CLI, `.workspace/config.yaml`, Rootline only for governed project documentation, Superpowers subagents.

**Spec:** `.workspace/docs/specs/2026-09-24-roadmap-on-beads-design.md`

## Global Constraints

- Every new Roadmap artifact under `skills/roadmap/` is Markdown.
- Do not create Python, JavaScript, TypeScript, shell helpers, runtime dependencies, schemas, extensions or custom command adapters.
- Do not create Roadmap unit, integration or E2E tests.
- Use direct installed `bd` commands exactly as documented by Beads 1.3.0.
- Roadmap creates only `epic` and `task`; new nested epics are forbidden.
- `parent-child` expresses hierarchy; only `blocks` controls execution order.
- `roadmap plan` asks explicit approval before the first Beads mutation.
- Bare `roadmap` is read-only and explains every non-closed record before reporting no executable task.
- `roadmap doctor` is read-only first and asks approval before applying exact proposed `bd` commands.
- `roadmap loop` claims and executes one topologically ready task at a time.
- Roadmap heartbeats directly with `bd heartbeat` between bounded implementation, review and delivery stages.
- Closure requires Bead acceptance plus the effective `.workspace` DoD and uses conditional `bd update` guards.
- No `beads-loop` compatibility alias remains.
- Historical `.workspace/docs` and `reports/beads-loop` records remain unchanged.
- Skill verification uses before/after pressure scenarios under `writing-skills`; existing repository checks may be run, but no new test suite is authored.
- Global runtime symlinks change only after merge and separate operator authorization; never target a worktree.

## Review Focus

- Plan must not materialize before an explicit approval turn.
- An empty `bd ready` result must trigger full-graph explanation, not a finished verdict.
- Doctor must not apply ambiguous reparenting, inferred dependencies or status conversion without approval.
- Passing tests alone must not close a task when `.workspace` DoD is missing or unknown.
- Loop must reject pressure to execute multiple Beads concurrently.

---

### Task 1: Author the Markdown-only Roadmap skill and remove Beads-loop

**Files:**
- Create: `skills/roadmap/SKILL.md`
- Create: `skills/roadmap/README.md`
- Create: `skills/roadmap/references/contracts.md`
- Create: `skills/roadmap/references/plan.md`
- Create: `skills/roadmap/references/tree.md`
- Create: `skills/roadmap/references/doctor.md`
- Create: `skills/roadmap/references/loop.md`
- Delete: `skills/beads-loop/README.md`
- Delete: `skills/beads-loop/SKILL.md`
- Delete: `skills/beads-loop/scripts/beads_todo_loop.py`
- Delete: `skills/beads-loop/tests/`
- Delete: `skills/beads-loop/fixtures/`

**Interfaces:**
- Consumes: `$ARGUMENTS`, the current repository, direct Beads CLI output and effective `.workspace/config.yaml`.
- Produces: four documented workflows; no executable artifact.

- [ ] **Step 1: Preserve the observed pressure RED in the SDD ledger**

Record these already-observed baseline failures verbatim in the plan ledger:

```text
Doctor ambiguity: previewed conversions would be applied without explicit approval.
Missing workspace DoD: passing unit tests was treated as sufficient to close.
Parallelism pressure: all dependency-free tasks would be executed concurrently.
```

The other two probes already behaved correctly: missing Plan requirements caused no write, and empty `bd ready` prompted full backlog inspection.

- [ ] **Step 2: Write the concise public skill router**

`skills/roadmap/SKILL.md` must contain:

```yaml
---
name: roadmap
description: Use when planning work into Beads, inspecting pending backlog topology, aligning existing Beads with the Roadmap contract, or implementing the repository backlog sequentially.
argument-hint: "[plan|doctor|loop] [requirements]"
user-invocable: true
---
```

Keep the body under 500 words. Route exactly:

| Input | Reference |
| --- | --- |
| starts with `plan` | `references/plan.md` |
| empty | `references/tree.md` |
| starts with `doctor` | `references/doctor.md` |
| starts with `loop` | `references/loop.md` |

State the common invariants once: Beads is durable state, `.workspace` is DoD authority, Rootline is not backlog storage, only `epic/task`, only `blocks` orders work, and no mode silently broadens scope.

- [ ] **Step 3: Write the canonical contract reference**

`references/contracts.md` defines:

```text
epic → optional non-executable aggregate
task → one-session executable unit, direct or one epic child
parent-child → hierarchy only
blocks → execution order
```

Define the complete epic and task fields from the approved spec. Mark an incomplete contract as visible but non-executable. State that requirements live in Beads description/design/acceptance fields and execution evidence is appended to notes by repository-relative path.

- [ ] **Step 4: Write the Plan recipe with direct Beads commands**

`references/plan.md` must require this order:

1. Read bounded repository context and related Beads.
2. Propose the full epic/task tree and `blocks` edges.
3. Validate every contract and ensure each active component has an executable root or explicit external gate.
4. Present the complete proposal and ask approval.
5. After approval only, write the exact graph input below `.superpowers/roadmap/`.
6. Run:

```bash
bd create --graph .superpowers/roadmap/approved-plan.json --dry-run --json
```

7. Treat any warning or unknown field as failure.
8. Apply the unchanged graph:

```bash
bd create --graph .superpowers/roadmap/approved-plan.json --json
```

9. Re-read IDs, parent links, acceptance criteria and dependencies with `bd show` and `bd dep list`.
10. Report mismatches without inventing rollback or retry.

Use `acceptance_criteria`, not `acceptance`, in graph nodes.

- [ ] **Step 5: Write the pending-tree recipe**

`references/tree.md` uses direct read-only commands:

```bash
bd list --status open,in_progress,blocked,deferred --brief --limit 0 --json
bd dep list bd-a bd-b --json
bd list --ready --brief --sort priority --limit 0 --json
```

The second command is illustrative: collect every literal non-closed ID from the first JSON response and pass each as its own `bd dep list` argument; never copy `bd-a` or `bd-b` unless those are real returned IDs.

The agent excludes epics from execution, validates task contracts, derives the `blocks` frontier, compares it with provider-ready IDs and renders one reason for every non-closed record. A mismatch is `readiness drift` and routes to Doctor. Empty provider-ready output alone never means complete.

- [ ] **Step 6: Write the Doctor recipe**

`references/doctor.md` diagnoses the exact finding classes in the spec. It separates deterministic corrections, decisions and unresolvable gaps. Before mutation it displays every proposed command and asks approval.

Permitted direct commands include `bd update`, `bd dep add`, `bd dep remove`, `bd dep cycles`, and narrowly scoped `bd reclaim --id`. Forbid `--any-replica`, requirement invention, implicit nested-epic flattening and status-parking conversion inferred from prose.

After apply, re-read affected Beads and run `bd dep cycles` plus the tree recipe.

- [ ] **Step 7: Write the sequential loop recipe**

`references/loop.md` requires:

1. Resolve `.workspace/config.yaml`; missing required DoD is `unknown` and stops mutation.
2. Run the tree recipe and select one task from topology/provider-ready intersection.
3. Claim with:

```bash
bd update "$BEAD_ID" --claim --json
```

4. Verify exact assignee and `in_progress` by re-reading the Bead.
5. Run `bd heartbeat "$BEAD_ID"` before and after each bounded implementation, review and delivery stage.
6. Use fresh Superpowers implementer and reviewer subagents; only the controller delegates and no child delegates.
7. Write a repository-contained Markdown evidence report.
8. Close only with:

```bash
bd update "$BEAD_ID" --status closed \
  --if-assignee "$ACTOR" --if-status in_progress \
  --append-notes "PASS evidence=$EVIDENCE_REF" --json
```

9. Never retry exit 13 or ownership loss.
10. Re-read the graph and ask before selecting the next task.
11. Close an epic only after all child tasks and epic success criteria have evidence.

- [ ] **Step 8: Write the operator README and remove Beads-loop**

README documents the four commands, direct dependencies (`bd`, Git, `.workspace` for mutating loop work), pressure-verification method, and post-merge activation boundary.

Remove the entire `skills/beads-loop/` directory only after all Roadmap Markdown files exist. Do not copy its Python or tests into Roadmap.

- [ ] **Step 9: Review only the Markdown diff and commit**

Run:

```bash
find skills/roadmap -type f -print | sort
find skills/roadmap -type f ! -name '*.md' -print
rg -n 'rootline (query|tree|graph|set|new)|roadmapctl|beads-loop alias' skills/roadmap
wc -w skills/roadmap/SKILL.md
git diff --check
```

Expected: only Markdown files; second and third commands print nothing; `SKILL.md` is under 500 words.

Commit:

```bash
git add -A skills/roadmap skills/beads-loop
git commit -m "feat(roadmap): adopt Beads-backed workflow"
```

### Task 2: Align current Markdown consumers with Roadmap

**Files:**
- Modify: `README.md`
- Modify: `profiles/pablontiv/PROFILE.md`
- Modify: `skills/context-save/SKILL.md`
- Modify: `skills/herdr/SKILL.md`

**Interfaces:**
- Consumes: ADR 0043, ADR 0044 and the new Roadmap skill.
- Produces: current Markdown authority surfaces with no live `beads-loop` route or Rootline-backed Roadmap assumption.

- [ ] **Step 1: Update the A4S capability inventory**

Replace the README Beads autonomous-loop capability with Roadmap. Describe it as a Markdown workflow over Beads for Plan, pending tree, Doctor and sequential loop. Do not claim a custom runtime.

- [ ] **Step 2: Update profile routing**

Replace the `beads-loop` bullet with one `roadmap` trigger-only bullet covering:

```text
planning work into Beads, viewing pending topology, aligning existing Beads, and executing the backlog sequentially
```

Preserve every other route, including the previously repaired `cost-analyzer` route.

- [ ] **Step 3: Update context-save's Roadmap state recipe**

Remove `.claude/roadmap.local.md` and Rootline roadmap-root discovery. When `.beads/` exists, capture read-only state with:

```bash
bd list --status open,in_progress,blocked,deferred --brief --limit 0 --json
```

Keep Rootline commands only for Markdown records that Rootline still governs.

- [ ] **Step 4: Scope Herdr's no-subagent language**

Replace blanket statements that the subagent extension is globally decommissioned with this distinction:

```text
An ordinary Herdr peer worker does not recursively delegate. A workflow such as Roadmap may own a bounded Superpowers controller under ADR 0043; only that controller dispatches subagents, and its children never delegate.
```

Do not change Herdr helpers, reconciler code or scripts in this Roadmap delivery.

- [ ] **Step 5: Inspect active Markdown references and commit**

Run:

```bash
rg -n 'beads-loop|\.claude/roadmap\.local\.md|roadmap-root' \
  README.md profiles/pablontiv/PROFILE.md skills/context-save/SKILL.md skills/herdr/SKILL.md
rg -n 'cost-analyzer.*se activa' profiles/pablontiv/PROFILE.md
git diff --check
```

Expected: first command prints no active old Roadmap/Beads-loop contract; second prints exactly the preserved cost-analyzer route.

Commit:

```bash
git add README.md profiles/pablontiv/PROFILE.md skills/context-save/SKILL.md skills/herdr/SKILL.md
git commit -m "docs(a4s): route work through Roadmap"
```

### Task 3: Pressure-test the Markdown skill and prepare delivery

**Files:**
- Modify only when a pressure failure proves a prose gap: `skills/roadmap/*.md`, `skills/roadmap/references/*.md`
- Modify: `skills/roadmap/README.md` only if activation/readback instructions need correction
- No new test or runtime files

**Interfaces:**
- Consumes: the five Review Focus scenarios and the completed Markdown bundle.
- Produces: pressure GREEN evidence in the ignored SDD ledger and a review-ready branch.

- [ ] **Step 1: Run five fresh pressure probes with Roadmap loaded**

Dispatch one fresh read-only agent per Review Focus scenario. Each receives only the scenario plus the instruction to read `skills/roadmap/SKILL.md` and its routed reference first.

Required verdicts:

```text
Plan approval: no Beads mutation before explicit approval.
False empty frontier: inspect and explain every non-closed record.
Doctor ambiguity: preview exact commands and wait for approval.
Missing workspace DoD: retain unknown and refuse closure.
Parallelism pressure: execute one task at a time.
```

Record each bounded response and verdict in the ignored SDD ledger. Do not add a Roadmap tests directory.

- [ ] **Step 2: Apply the writing-skills GREEN loop only when needed**

For any failed scenario:

1. record the exact rationalization;
2. amend only the Markdown guidance implicated by that failure;
3. rerun only that scenario with a fresh agent;
4. stop after it passes.

No code or automated test is introduced.

- [ ] **Step 3: Run documentation validation without unit tests**

Run only checks applicable to the Markdown delivery:

```bash
rootline validate --all .workspace/docs/adr -o json
rootline validate --all .workspace/docs/specs -o json
rootline validate --all .workspace/docs/plans -o json
find skills/roadmap -type f ! -name '*.md' -print
rg -n 'name: beads-loop|/skill:beads-loop|\.claude/roadmap\.local\.md' \
  README.md profiles/pablontiv/PROFILE.md skills/roadmap skills/context-save/SKILL.md skills/herdr/SKILL.md
git diff --check
```

Expected: Rootline passes; both `find` and `rg` print nothing; diff check is silent. Repository CI may continue running its pre-existing tests, but this delivery adds and requires no Roadmap unit-test step.

- [ ] **Step 4: Add the post-merge activation runbook**

README must state that activation is a separate operator-gated action after merge. The runbook:

```bash
test "$(git -C [REDACTED:shared-root]/harness/a4s branch --show-current)" = main
test -f [REDACTED:shared-root]/harness/a4s/skills/roadmap/SKILL.md
test ! -e "$HOME/.agents/skills/roadmap"
test ! -e "$HOME/.agents/skills/roadmap.new"
test "$(readlink "$HOME/.agents/skills/beads-loop")" = [REDACTED:shared-root]/harness/a4s/skills/beads-loop
ln -s [REDACTED:shared-root]/harness/a4s/skills/roadmap "$HOME/.agents/skills/roadmap.new"
mv "$HOME/.agents/skills/roadmap.new" "$HOME/.agents/skills/roadmap"
unlink "$HOME/.agents/skills/beads-loop"
test "$(readlink "$HOME/.agents/skills/roadmap")" = [REDACTED:shared-root]/harness/a4s/skills/roadmap
```

Never run this against the implementation worktree.

- [ ] **Step 5: Commit pressure-driven Markdown fixes, if any**

If pressure testing changed Markdown:

```bash
git add skills/roadmap
git commit -m "docs(roadmap): close pressure-test gaps"
```

If no file changed, record “pressure GREEN without prose changes” in the ledger and create no empty commit.

## Final review and delivery

After Task 3:

1. Generate a review package from the branch merge-base through HEAD.
2. Dispatch an independent final reviewer with the spec, this plan and ADR 0043/0044.
3. If findings require changes, use one Markdown-only fix dispatch and one scoped re-review.
4. Re-run the existing validation commands above.
5. Use `superpowers:finishing-a-development-branch`.
6. Push the validated branch and open a pull request to `main` according to `.workspace/config.yaml`.
7. Preserve the exact candidate SHA, review verdict and CI evidence.
8. Do not merge or change global skill symlinks; those actions remain operator-owned.
