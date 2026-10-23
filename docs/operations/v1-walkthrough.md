# v1 source walkthrough — 23 October 2026

## Proposition and boundaries

PASS for read-only native discovery, a canonical reviewer source check, independent
skill installation, and a genuinely bootstrap-rendered isolated admission identity.
Target: integration/v1 source `05237b13461001cf2a2bc28b8b8e78380320bd2b`,
`@a4s/issue-lifecycle@0.4.1`; documentation-only #431 changes follow that baseline.
This is not a production deployment, feature-run, merge, visual widget, full
routing-policy matrix or post-release acceptance claim. The catalog records the
four #311 assets as pending; this walkthrough does not manufacture their sources.

All paths below are repo-relative or placeholders. Raw native profiles, session
transcripts, a local origin, source/PRIMARY clones and Dagu home were temporary,
outside the repository, and removed after evidence collection. Only the owned
loopback server was started/stopped. The production OMP profile, station settings,
scheduler, adopted lane renders and installed reconciler were not changed.

## 1. Isolated native OMP and `/workflows`

A fresh `PI_CODING_AGENT_DIR` held a copy of the existing `config.yml` and a symlink
to the existing `agent.db`; no credential files were copied. The copied config
suppressed ambient Claude-plugin discovery and configured the delivered root
skills. All changed model routes were confined to this profile. Session output
went to a fresh `PI_CODING_AGENT_SESSION_DIR`.

```sh
omp --version
omp --no-extensions --cwd "$A4S_ROOT" \
  -e "$A4S_ROOT/packages/issue-lifecycle" \
  -e "$A4S_ROOT/packages/review-routing" \
  --session-dir "$SMOKE_SESSIONS" --no-title --no-lsp --thinking off \
  --model anthropic/claude-opus-5 --mode json --no-tools -p /workflows
```

Observed: `omp/18.12.6`; `/workflows` exited 0 (headless command handling, not a
visual assertion). A separate native SDK `createAgentSession` under the same
profile used `disableExtensionDiscovery: true`, explicit package roots, isolated
agent directory and `hasUI: false`. Public `getSessionSlashCommands` returned:

```json
{"name":"workflows","description":"Toggle the Workflows widget fold, or pass expand / collapse / show / hide","source":"extension"}
```

`session.prompt('/workflows')` returned `false` (command consumed without invoking
the model), then the session was disposed. Public native discovery resolved all
seven lifecycle skills to `packages/issue-lifecycle/skills/<name>/SKILL.md` and
four independent skills to `skills/<name>/SKILL.md`. Agent discovery returned the
project `reviewer` at `.omp/agents/reviewer.md` and the package-owned
`triage-reviewer`/`plan-reviewer` definitions at their actual lifecycle paths.
Package definitions were classified `source=user` by native metadata; this label
is not a claim that their files live under the user's profile.

## 2. Real read-only parent and canonical reviewer

```sh
omp --no-extensions --cwd "$A4S_ROOT" \
  -e "$A4S_ROOT/packages/issue-lifecycle" \
  -e "$A4S_ROOT/packages/review-routing" \
  --session-dir "$SMOKE_SESSIONS" --no-title --no-lsp --thinking off \
  --model openai-codex/gpt-6.1-sol --mode json --tools read,task,wait \
  --max-time 480 -p "<read-only source-catalog assignment>"
```

The assignment requested actual `read skill://<name>` calls for all seven
lifecycle and all four root skills, one source-path/purpose per skill, a
`task(agent=reviewer)` checking the root/lifecycle manifests and each delivered
skill/agent file, and `wait` until the reviewer finished. It explicitly authorized
source reads only, with no workflow execution or configuration/GitHub mutations.
Observed exit 0; every requested skill resolved to the catalog's delivered source.
The root manifest was `a4s`, private; the package was `@a4s/issue-lifecycle`, private,
with seven skill directories and two package agent definitions.

Evidence correlation:

- Parent session `01a16827-c2cf-74c6-af3a-25158f71c842`.
- Task `CatalogReview431`, `agent=reviewer`, native `agentSource=project`.
- `wait` returned completed, duration 1m40s; persisted child file
  `<parent-session>/CatalogReview431.jsonl`.
- Child `session_init` runtime `18.12.6`, `agent=reviewer`; its system prompt
  contained the exact canonical `.omp/agents/reviewer.md` body. Independent native
  agent discovery also returned that actual filesystem source.
- The runtime selected `cursor/grok-4.7` for this child; its persisted transcript
  contains real `read`, `grep`, `glob` and read-only `bash` results. This observed
  source-check run is not a general claim about all provider/tool combinations.
- Native `readOnly=false`: the assignment, not an enforced sandbox, constrained
  behavior. No mutation, build, test or workflow was requested of this reviewer.

Task progress exposed `projectAgentsDir=null` and no selected definition path.
Therefore the task proof combines source class, exact prompt-body match and the
separate native resolver result; metadata alone does not emit the definition path.

## 3. Independent skill in an isolated consumer

Created `<consumer>/.omp/skills/` symlinks to the complete delivered directories
for `model-routing-audit`, `gpt-quota-audit`, `cost-analyzer`, `agent-throughput`,
and `<consumer>/.omp/agents/` symlinks to all six canonical role definitions.
The consumer received the delivered project model-policy file, not a global
activation. A new native SDK session with cwd set to this consumer resolved the
four skills through `<consumer>/.omp/skills/<name>/SKILL.md`, the canonical reviewer
through the consumer installation, and the lifecycle skills from its explicit
whole-package root. `/workflows` again consumed without a model turn; exit 0.

```sh
python3 "$CONSUMER/.omp/skills/model-routing-audit/scripts/audit.py" --help
```

Exit 0. The installed entry printed its actual read-only audit options, five
allowlisted CLI reads by default, zero inference/assignments, explicit optional
probe limits and result codes. This is a bounded installed-script invocation,
not an authenticated routing audit or automatic policy application.

## 4. Dagu version and station history (read-only)

```sh
dagu version
dagu history reconcile --format json --limit 5
```

Observed `2.20.1`, exit 0. History exited 0 at 09:45 UTC: run
`034kpyM8OMmuAoc040i4IT` was running; the preceding four minute-tick runs
(09:44–09:41 UTC) were succeeded. These observations carried bundle `0.3.120`.
They do not prove that the shared reconciler, old checked-in lane stamps and
candidate `0.4.1` installation are identical. The deployment runbook treats those
as distinct identities rather than silently upgrading production.

## 5. Genuine isolated bootstrap and admission identity

Created a temporary bare origin named `pablontiv/a4s.git` from the tested baseline,
with its default branch pointing to that baseline, then clean source and separate
PRIMARY clones. Source dependencies were linked from the prepared worktree. The
source clone retained that explicitly isolated origin: its HEAD passed the real
bootstrap origin/HEAD ancestry check without changing the production remote.
PRIMARY's origin identified `https://github.com/pablontiv/a4s.git` for bootstrap's
read-only `gh repo view`; the source and PRIMARY were canonical real paths.
An isolated Dagu home bound `127.0.0.1:59326`, `auth.mode=none`, with a server but
no scheduler. Policy outputs used a harmless `GATE=true` because no work ran.

```sh
DAGU_HOME="$SMOKE_DAGU_HOME" DAGU_URL=http://127.0.0.1:59326 dagu server
# In the same isolated environment:
dagu start --run-id docs-431-bootstrap-isolated \
  --only detect --only render --only reconcile \
  --output answers.GATE=true --output answers.REQUIRED_CHECK=validate \
  --output answers.TEST_PATHS=test --output answers.REBASE_RESOLVER= \
  --output answers.VALIDATION= --output answers.A4S_BLOCKER_REPORTING=ask \
  "$SMOKE_SOURCE/packages/issue-lifecycle/skills/issue-execution/dagu-feature-bootstrap.yaml" -- \
  PRIMARY="$SMOKE_PRIMARY" \
  SKILL_DIR="$SMOKE_SOURCE/packages/issue-lifecycle/skills/issue-execution"
```

The real detect/render/reconcile steps exited 0 in 5s. Answers, worktree setup,
GitHub mutation and final adoption confirmation were deliberately unexecuted.
Before the successful run, the real detector correctly exposed two setup errors:
noncanonical macOS `/var` versus `/private/var` PRIMARY spelling, then a local-only
PRIMARY remote unsupported by `gh repo view`. Correcting those isolated
prerequisites, rather than bypassing checks, produced this PASS.

Copied the four genuine `.git/dagu-feature/*.yaml` repository renders into the
isolated PRIMARY's `.workspace/dagu/dags/`; the real reconcile step had installed
its render only into the isolated Dagu home. No stamp was hand-edited.

```sh
node packages/issue-lifecycle/bin/dagu-feature-bundle.ts "$SMOKE_PRIMARY"
node "$SMOKE_SOURCE/packages/issue-lifecycle/bin/dagu-feature-bundle.ts" \
  admit --run-id docs-431-admission \
  "$SMOKE_PRIMARY/.workspace/dagu/dags/planning.yaml" -- \
  PRIMARY="$SMOKE_PRIMARY" OMP_SESSION_ID=docs-431-owner
```

Both exited 0. CLI inspection reported all four repository renders and reconciler
`version=0.4.1`, source `pablontiv/a4s@05237b13461001cf2a2bc28b8b8e78380320bd2b`,
bootstrap `docs-431-bootstrap-isolated`, `compat=ok`, and Dagu `2.20.1` compatible.
`admit` then created an immutable isolated receipt with the same source version,
commit, installed package/template/reconciler identities and actual isolated
runtime. It did not enqueue a planning run. This demonstrates real provenance
admission, not merely the weaker stamp-inspection CLI mode. Nothing in these
results authorizes reusing the harmless isolated policy in a production adoption.

## 6. Repository verification

The #431 targeted future command, adapted to the current package and retained
suite paths, was:

```sh
npm exec --workspace @a4s/issue-lifecycle -- tsx --test \
  test/planning-template.test.ts test/discovery-contract.test.ts \
  test/bundle-template.test.ts test/admission.test.ts
```

Exit 0: 20 tests, 17 passed, 3 explicitly guarded real-Dagu skips, 0 failed.
Those skipped cases are not live-test PASS claims; the separate bootstrap and
admission exercise above supplies its own bounded real-target proof.

Executed `npm test && npm run typecheck` once from the worktree root; both passed.
Across the eight workspaces: 683 tests, 655 passed, 28 guarded live-Dagu skips,
0 failed. All eight workspace typecheck commands completed successfully, including
the broker's `node --check` commands. No prose/source-shape tests were added.

## 7. Independent source-contract review

A second real native print-mode parent used the same explicit package roots and
`--tools read,task,wait`, requesting source-only review of all consolidated docs,
entry points and moved links against manifests, CLI parsing, bootstrap, semantic
jobs, station installation and checked-in lane renders.

Parent `01a16838-129a-736d-8ab9-b9685c41cbb5` dispatched
`ReviewIssue431Docs`, `agent=reviewer`, `agentSource=project`; `wait` returned
completed in 3m, and the parent exited 0. Verdict: **PASS, no actionable factual
errors**. The reviewer confirmed the inventory, pending destinations,
component/lane ownership, command targets and direct lifecycle publication path.

Coverage was source examination only: the reviewer did not independently replay
the recorded history, inspect production reconciler bytes/capacity, compare
upstream checksums or read the remote #311 issue body. Those observations are
separately bounded above. The preferred explicit Anthropic model override was
rejected by the native `reviewer` task API; its configured model
`cursor/grok-4.7` performed this read-only review successfully. No deployment,
rollback, global activation or additional verification gate was executed.
