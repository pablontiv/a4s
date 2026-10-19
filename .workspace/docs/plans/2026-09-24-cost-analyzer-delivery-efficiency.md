# Cost Analyzer Delivery Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, read-only delivery-efficiency report that measures Cost per Durable Production Change (CDPC) without treating sessions, aggregate tokens, or raw commits as topology-efficiency rankings.

**Architecture:** A new `delivery_efficiency.py` module derives candidate SHAs from mtime-selected canonical Pi session records and evaluates them against local Git history. It resolves durability, code-path eligibility, cohort ownership, native-cost allocation, and guardrails before a pure renderer produces per-repository rows. `report.py` dispatches a new view; all existing views retain their current behavior and output contracts.

**Tech Stack:** Python 3.11+ standard library, `unittest`, local read-only Git commands, existing `SessionRecord` and `enrich_records` interfaces.

**Spec:** `.workspace/docs/specs/2026-09-24-cost-analyzer-delivery-efficiency.md`

## Global Constraints

- Select session JSONL files only by mtime; never select them with internal timestamps.
- Evaluate Git outcomes only for records already selected by that mtime range.
- Preserve `quad.py` S1–S4 classification signals and legacy tests unchanged.
- The delivery-efficiency view is opt-in and read-only; it may invoke only non-mutating Git inspection commands.
- A durable candidate must be production code, at least seven days old, reachable from a resolved local default branch, and free from an explicit default-branch revert.
- A SHA observed by more than one S1–S4 scenario is `mixed`, never duplicated in a scenario denominator.
- Scenario rankings require at least 80% attributable native-cost coverage and at least one durable production SHA; cross-repository aggregation is descriptive only.
- Existing budget reports may retain raw cost/tokens for budget diagnostics but must not call `$ / sesión`, tokens/session, or raw commits an efficiency ranking.

## Review Focus

- A seven-day-old commit that is not reachable from `origin/HEAD`, `main`, or `master` must be unknown, never durable; Task 1 tests fallback and withheld behavior.
- A code commit followed by `This reverts commit <SHA>` must not enter CDPC even though the original SHA remains in branch history; Task 1 tests explicit reversion.
- A session that observes two qualifying SHAs must split its native cost, not charge both changes the complete session cost; Task 2 tests allocation conservation.
- A SHA seen by S1 and S4 must move to `mixed`; Task 2 tests no duplicate denominator or scenario ranking.
- A repository cohort with less than 80% attributable cost must be visible but `insufficient-coverage`; Task 3 tests renderer status rather than silently ranking it.

---

### Task 1: Evaluate durable production commits from local Git evidence

**Files:**
- Create: `skills/cost-analyzer/assets/delivery_efficiency.py`
- Create: `skills/cost-analyzer/assets/test_delivery_efficiency.py`
- Modify: `skills/cost-analyzer/assets/enrich.py`

**Interfaces:**
- Produces `CommitEvidence(sha, repository, committed_at, path_categories, maturity, durability)` from `inspect_commit(repo: Path, sha: str, evaluation_date: date)`.
- Produces `resolve_default_ref(repo: Path) -> str | None`, trying `refs/remotes/origin/HEAD`, then `refs/heads/main`, then `refs/heads/master`.
- Produces `collect_candidate_observations(records, evaluation_date)` from enriched, mtime-selected `SessionRecord` values.
- `enrich_records` remains backward compatible and continues to set `commits` and `commit_coverage` exactly as today.

- [ ] **Step 1: Write failing Git-fixture tests**

Create a disposable local Git repository in `test_delivery_efficiency.py`; make a `main` branch, configure author identity, and create commits through `git -C <repo>`. Write these tests before creating the production module:

```python
def test_mature_code_commit_on_main_is_durable(self) -> None:
    sha = self.commit("src/app.py", "print('ok')", "feature")
    evidence = delivery_efficiency.inspect_commit(self.repo, sha, date(2026, 9, 24))
    self.assertEqual(evidence.maturity, "mature")
    self.assertEqual(evidence.durability, "durable")
    self.assertEqual(evidence.path_categories, frozenset({"code"}))


def test_doc_and_test_only_commits_are_excluded(self) -> None:
    doc_sha = self.commit("README.md", "docs", "docs")
    test_sha = self.commit("tests/test_app.py", "assert True", "test")
    self.assertEqual(delivery_efficiency.inspect_commit(self.repo, doc_sha, TODAY).eligibility, "excluded-noncode")
    self.assertEqual(delivery_efficiency.inspect_commit(self.repo, test_sha, TODAY).eligibility, "excluded-noncode")


def test_commit_inside_maturity_horizon_is_immature(self) -> None:
    sha = self.commit("src/new.py", "x = 1", "new", when="2026-09-22T12:00:00+00:00")
    self.assertEqual(delivery_efficiency.inspect_commit(self.repo, sha, date(2026, 9, 24)).maturity, "immature")
```

Add tests for an explicit `git revert` commit producing `durability == "reverted"`, no resolvable default ref producing `durability == "unknown-history"`, and a commit present only on a side branch producing `durability == "unknown-history"` or `not-on-default` according to the declared result type.

- [ ] **Step 2: Run the focused RED tests**

Run:

```bash
cd skills/cost-analyzer/assets
python3 -m unittest -v test_delivery_efficiency.DeliveryEvidenceTests
```

Expected: FAIL with `ModuleNotFoundError: No module named 'delivery_efficiency'`.

- [ ] **Step 3: Implement the minimal inspection module**

Create `delivery_efficiency.py` with immutable dataclasses and a single `run_git(repo, *args) -> str | None` wrapper using `subprocess.run(..., capture_output=True, text=True, timeout=15, check=False)`. Implement:

```python
def resolve_default_ref(repo: Path) -> str | None:
    for ref in ("refs/remotes/origin/HEAD", "refs/heads/main", "refs/heads/master"):
        if run_git(repo, "rev-parse", "--verify", "--quiet", ref) is not None:
            return ref
    return None


def is_explicitly_reverted(repo: Path, default_ref: str, sha: str) -> bool:
    return run_git(repo, "log", default_ref, "--format=%B", "--grep", f"This reverts commit {sha}") is not None
```

Use `git show --format=%cI --name-only --no-renames <sha>` to obtain commit timestamp and changed paths. Reuse `outcomes.categorize_path`. Use `merge-base --is-ancestor <sha> <default-ref>` to verify reachability. Do not mutate refs, working trees, remotes, or configuration. Treat command errors, absent refs, malformed timestamps, and shallow-history uncertainty as explicit unknown results.

- [ ] **Step 4: Run the full durability test module**

Run:

```bash
cd skills/cost-analyzer/assets
python3 -m unittest -v test_delivery_efficiency.DeliveryEvidenceTests
python3 -m unittest -v test_outcomes test_dataset
```

Expected: all tests pass; existing enrichment and classification contracts remain green.

- [ ] **Step 5: Commit the Git-evidence unit**

```bash
git add skills/cost-analyzer/assets/delivery_efficiency.py skills/cost-analyzer/assets/test_delivery_efficiency.py skills/cost-analyzer/assets/enrich.py
git commit -m "feat(cost-analyzer): evaluate durable production commits"
```

### Task 2: Attribute durable changes conservatively to topology cohorts

**Files:**
- Modify: `skills/cost-analyzer/assets/delivery_efficiency.py`
- Modify: `skills/cost-analyzer/assets/test_delivery_efficiency.py`

**Interfaces:**
- Produces `DeliveryCohort(repository, cohort, session_cost, attributable_cost, durable_shas, immature_count, reverted_count, unknown_count, coverage, median_lead_seconds)`.
- `cohort` is `S1`, `S2`, `S3`, `S4`, `mixed`, or `unknown`.
- Produces `analyze_delivery_efficiency(records, evaluation_date) -> list[DeliveryCohort]` without opening session JSONL files or reselecting records.

- [ ] **Step 1: Write failing attribution tests**

Extend the fixture with `SessionRecord` factories that set `cwd`, `started_at`, `ended_at`, `commits`, `cost_native_usd`, and `observed_topology`. Write these tests before implementing aggregation:

```python
def test_shared_sha_is_mixed_and_absent_from_scenario_denominators(self) -> None:
    rows = analyze_delivery_efficiency([
        self.record("S1", 10.0, {self.sha}),
        self.record("S4", 20.0, {self.sha}),
    ], evaluation_date=TODAY)
    self.assertEqual(self.cohort(rows, "mixed").durable_shas, {self.sha})
    self.assertFalse(any(row.cohort in {"S1", "S4"} and self.sha in row.durable_shas for row in rows))


def test_session_cost_is_split_across_its_durable_changes(self) -> None:
    rows = analyze_delivery_efficiency([self.record("S3", 30.0, {self.sha, self.other_sha})], TODAY)
    row = self.cohort(rows, "S3")
    self.assertEqual(row.attributable_cost, 30.0)
    self.assertEqual(row.cdpc, 15.0)
```

Add a coverage test where a $100 S3 session with no observable qualifying commit and a $100 S3 qualifying session produces `coverage == 0.5` and `status == "insufficient-coverage"`. Add a lead-time test that pins the median from session start to commit timestamp.

- [ ] **Step 2: Run the focused RED tests**

Run:

```bash
cd skills/cost-analyzer/assets
python3 -m unittest -v test_delivery_efficiency.DeliveryAttributionTests
```

Expected: FAIL because `analyze_delivery_efficiency` and `DeliveryCohort` do not exist.

- [ ] **Step 3: Implement cohort assignment and allocation**

Group candidate observations by `(repository, sha)`. Derive the scenario set from observing records: one scenario yields that cohort, multiple scenarios yields `mixed`, and absent/unknown evidence yields `unknown`. For a session whose cohort has `N` unique durable production SHAs, allocate `record.cost_native_usd / N` to each SHA; then sum exactly once per session in `DeliveryCohort.attributable_cost`. Compute coverage as attributable native cost divided by native cost of all selected Pi sessions in the same repository/cohort. Set `status` to:

```python
if unknown_history:
    status = "unknown-history"
elif not durable_shas:
    status = "no-durable-changes"
elif coverage < 0.80:
    status = "insufficient-coverage"
else:
    status = "ranked"
```

Do not generate an aggregate winner across repositories. Preserve `mixed` cohorts as descriptive rows and exclude them from all S1–S4 rankings.

- [ ] **Step 4: Run unit and regression tests**

Run:

```bash
cd skills/cost-analyzer/assets
python3 -m unittest -v test_delivery_efficiency test_outcomes test_quad test_views
```

Expected: all new attribution tests and all legacy report/classification tests pass.

- [ ] **Step 5: Commit the attribution unit**

```bash
git add skills/cost-analyzer/assets/delivery_efficiency.py skills/cost-analyzer/assets/test_delivery_efficiency.py
git commit -m "feat(cost-analyzer): attribute durable changes by cohort"
```

### Task 3: Expose the opt-in view and update the skill contract

**Files:**
- Modify: `skills/cost-analyzer/assets/report.py`
- Modify: `skills/cost-analyzer/assets/test_report.py`
- Modify: `skills/cost-analyzer/SKILL.md`
- Modify: `skills/cost-analyzer/assets/test_skill_contract.py`

**Interfaces:**
- `report.py --view delivery-efficiency [--evaluation-date YYYY-MM-DD]` renders delivery cohorts.
- `--evaluation-date` defaults to the current UTC date and changes only commit maturity evaluation, never session mtime selection.
- Existing `--view topology`, `--view harness`, full report path, and all existing CLI flags retain their behavior.

- [ ] **Step 1: Write failing CLI and documentation-contract tests**

Add a `test_report.py` test that patches `load_ledger`, `enrich_records`, and `analyze_delivery_efficiency`, invokes:

```python
with patch("sys.argv", [
    "report.py", "--since", "2026-09-01", "--until", "2026-09-16",
    "--view", "delivery-efficiency", "--evaluation-date", "2026-09-24",
]):
    report.main()
self.assertIn("COSTE POR CAMBIO DURABLE", stdout.getvalue())
self.assertIn("insufficient-coverage", stdout.getvalue())
```

Add a test proving an existing `--view topology` invocation returns its unchanged heading. Extend the skill contract test to require `delivery-efficiency`, `mtime`, `mixed`, `Cost per Durable Production Change`, and the seven-day maturity rule, while forbidding language that calls commits/session or tokens/session a topology-efficiency winner.

- [ ] **Step 2: Run the focused RED tests**

Run:

```bash
cd skills/cost-analyzer/assets
python3 -m unittest -v test_report.ReportViewTests test_skill_contract.SkillContractTests
```

Expected: FAIL because `delivery-efficiency` is not an accepted view and its skill contract does not exist.

- [ ] **Step 3: Implement CLI rendering and docs**

Extend `--view` choices with `delivery-efficiency` and add `--evaluation-date`. In that branch, load records with the unchanged `load_ledger(since, until)` call, enrich records once, analyze only Pi records with a native-cost field, and render a table with exactly these columns:

```text
Repository | Cohort | Native cost attributed | Durable changes | CDPC | Reverts | Median time | Coverage | Status
```

Print the session mtime range and evaluation date in the heading. Render candidate counts for durable, immature, reverted, excluded-noncode, mixed, and unknown. State that only `ranked` per-repository cohorts are comparable and that the command performs read-only local Git evaluation.

Update `SKILL.md` with the exact command, the definition and scope of CDPC, all guardrails, its 80% coverage gate, and the distinction between budget metrics and efficiency metrics.

- [ ] **Step 4: Run the focused GREEN tests**

Run:

```bash
cd skills/cost-analyzer/assets
python3 -m unittest -v test_report.ReportViewTests test_skill_contract.SkillContractTests
python3 report.py --help
```

Expected: new view and help flag are present; legacy view tests remain green.

- [ ] **Step 5: Commit the report surface**

```bash
git add skills/cost-analyzer/assets/report.py skills/cost-analyzer/assets/test_report.py skills/cost-analyzer/SKILL.md skills/cost-analyzer/assets/test_skill_contract.py
git commit -m "feat(cost-analyzer): report delivery efficiency"
```

### Task 4: Verify end-to-end invariants and documentation governance

**Files:**
- Modify: `.workspace/docs/specs/2026-09-24-cost-analyzer-delivery-efficiency.md` only if tests reveal a specification ambiguity.
- Modify: `.workspace/docs/plans/2026-09-24-cost-analyzer-delivery-efficiency.md` only to check completed steps during execution.

- [ ] **Step 1: Run the complete asset test suite**

Run:

```bash
cd skills/cost-analyzer/assets
python3 -m unittest discover -v
```

Expected: all existing and delivery-efficiency tests pass.

- [ ] **Step 2: Run a disposable-repository CLI proof**

Create fixture records and a disposable Git repository through the test helper; invoke `report.main()` with `--view delivery-efficiency --evaluation-date 2026-09-24`. Assert that the output has one ranked per-repository row, no cross-repository winner, and a separate `mixed` cohort if the same SHA is observed by two scenarios.

- [ ] **Step 3: Validate durable documentation and inspect changes**

Run:

```bash
rootline validate .workspace/docs/specs/2026-09-24-cost-analyzer-delivery-efficiency.md -o json
rootline validate .workspace/docs/plans/2026-09-24-cost-analyzer-delivery-efficiency.md -o json
rootline validate .workspace/docs/adr/0036-medir-eficiencia-por-cambio-durable.md -o json
git diff --check
git status --short
```

Expected: all governed documents validate, no whitespace errors, and only intended CCDP files differ from the base branch.

- [ ] **Step 4: Commit final documentation adjustments only when needed**

```bash
git add .workspace/docs/specs/2026-09-24-cost-analyzer-delivery-efficiency.md .workspace/docs/plans/2026-09-24-cost-analyzer-delivery-efficiency.md
git commit -m "docs(cost-analyzer): verify delivery efficiency design"
```

Skip this commit when no tracked documentation changed after the initial design commit.
