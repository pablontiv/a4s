# Cross-Harness Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report token-normalized work efficiency and S1–S4 topology for Pi, Claude Code, and Codex from one enriched `SessionRecord` ledger.

**Architecture:** Parsers capture direct topology evidence into `SessionRecord`; a canonical classifier derives topology and confidence. Immutable Git enrichment records coverage and SHAs. Every report consumes those records through `views.py`; legacy Pi CLIs become wrappers rather than independently parsing JSONL.

**Tech Stack:** Python 3 standard library, `unittest`, JSONL logs, Git CLI.

**Spec:** `docs/superpowers/specs/2026-09-21-cross-harness-efficiency-design.md`

## Global Constraints

- Rank cross-harness cohorts only by `total_tokens / unique_commit_shas`; lower is better.
- Preserve all token components; never estimate or rank Claude/Codex USD.
- Commits are work output, not user-value proof; retain PR/bead results separately.
- S3/S4 require coordination evidence; malformed sources are `unknown`.
- Deduplicate SHAs inside the displayed cohort and report commit coverage.
- Preserve current Pi S1–S4 and j0k3r compatibility results.

## Review Focus

- Codex `originator: Claude Code` must still be `harness='codex'` (Task 2).
- Cumulative Codex `token_count` uses only its latest snapshot (Task 2).
- A Claude `Agent` call maps to delegation without inventing coordination (Task 2).
- Invalid Git cwd/window records coverage failure and cannot improve tokens/SHA (Task 3).
- A zero-SHA cohort is displayed but cannot be named winner (Task 4).

---

### Task 1: Extend canonical record and topology classifier

**Files:**
- Modify: `assets/dataset.py`
- Modify: `assets/test_dataset.py`

**Interfaces:**
- Produces `TopologyEvidence(delegation: bool, coordination: bool, direct_coordination: bool)`.
- Produces `classify_topology(evidence, parseable) -> tuple[str, str]`.
- `SessionRecord` adds `observed_topology`, `topology_confidence`, and `topology_evidence`.

- [ ] **Step 1: Write failing record/classifier tests**

```python
def test_classifier_marks_direct_delegation_without_coordination_as_s2():
    topology, confidence = classify_topology(TopologyEvidence(delegation=True), parseable=True)
    self.assertEqual((topology, confidence), ('S2', 'direct'))

def test_unparseable_source_is_unknown():
    self.assertEqual(classify_topology(TopologyEvidence(), parseable=False), ('unknown', 'unknown'))
```

- [ ] **Step 2: Run the tests**

Run: `cd assets && python3 -m unittest -v test_dataset.py`
Expected: FAIL because `TopologyEvidence` and `classify_topology` do not exist.

- [ ] **Step 3: Implement the dataclass and classifier**

```python
@dataclass(frozen=True)
class TopologyEvidence:
    delegation: bool = False
    coordination: bool = False
    direct_coordination: bool = False


def classify_topology(evidence: TopologyEvidence, parseable: bool) -> tuple[str, str]:
    if not parseable:
        return 'unknown', 'unknown'
    topology = 'S4' if evidence.coordination and evidence.delegation else \
               'S3' if evidence.coordination else 'S2' if evidence.delegation else 'S1'
    confidence = 'direct' if evidence.delegation or evidence.direct_coordination else 'inferred'
    return topology, confidence
```

- [ ] **Step 4: Run tests and legacy Pi regression**

Run: `cd assets && python3 -m unittest -v test_dataset.py test_quad.py`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assets/dataset.py assets/test_dataset.py
git commit -m "feat: add canonical topology evidence"
```

### Task 2: Capture Claude and Codex topology evidence in parsers

**Files:**
- Modify: `assets/dataset.py`
- Modify: `assets/test_dataset.py`

**Interfaces:**
- `parse_claude_session(path) -> SessionRecord` detects assistant `tool_use` / tool call `Agent`.
- `parse_codex_session(path) -> SessionRecord` detects `spawn_agent` and `followup_task` response items.
- Both emit S2/direct for delegation-only fixtures.

- [ ] **Step 1: Write failing harness fixtures**

```python
def test_claude_agent_tool_is_s2_direct(self):
    record = parse_claude_session(write_jsonl({'type':'assistant','message':{'content':[{'type':'tool_use','name':'Agent'}]}}))
    self.assertEqual((record.observed_topology, record.topology_confidence), ('S2', 'direct'))

def test_codex_spawn_agent_is_s2_direct(self):
    record = parse_codex_session(write_jsonl({'type':'response_item','payload':{'type':'function_call','name':'spawn_agent'}}))
    self.assertEqual(record.observed_topology, 'S2')
```

- [ ] **Step 2: Run tests**

Run: `cd assets && python3 -m unittest -v test_dataset.py`
Expected: FAIL because parsers do not scan these tool surfaces.

- [ ] **Step 3: Implement direct evidence extraction**

Scan Claude assistant content blocks for `name == 'Agent'`. Scan Codex `response_item` and `event_msg` payloads for names in `{'spawn_agent', 'followup_task'}`. Keep Codex harness determined by its root/parser, never `originator`.

- [ ] **Step 4: Run parser suite**

Run: `cd assets && python3 -m unittest -v test_dataset.py`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assets/dataset.py assets/test_dataset.py
git commit -m "feat: classify Claude and Codex delegation"
```

### Task 3: Add immutable commit coverage enrichment

**Files:**
- Modify: `assets/enrich.py`
- Create: `assets/test_enrich.py`

**Interfaces:**
- `enrich_records(records) -> list[SessionRecord]` sets `commits` and `commit_coverage`.
- Coverage values: `observable`, `not-a-repo`, `no-timestamps`, `error`.

- [ ] **Step 1: Write failing coverage tests**

```python
def test_missing_window_sets_no_timestamps_without_mutating_input(self):
    result = enrich_records([record_without_window])[0]
    self.assertEqual(result.commit_coverage, 'no-timestamps')
    self.assertEqual(record_without_window.commit_coverage, 'not-a-repo')
```

- [ ] **Step 2: Run test**

Run: `cd assets && python3 -m unittest -v test_enrich.py`
Expected: FAIL because `commit_coverage` is absent.

- [ ] **Step 3: Implement coverage-aware enrichment**

Use `dataclasses.replace`; map missing cwd to `not-a-repo`, missing window to `no-timestamps`, Git failures to `error`, and completed Git queries to `observable`, including zero commits.

- [ ] **Step 4: Run tests**

Run: `cd assets && python3 -m unittest -v test_enrich.py test_outcomes.py`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assets/enrich.py assets/test_enrich.py
git commit -m "feat: expose Git coverage in ledger enrichment"
```

### Task 4: Build universal harness and topology views

**Files:**
- Modify: `assets/views.py`
- Modify: `assets/test_views.py`

**Interfaces:**
- `aggregate(records, dimensions: tuple[str, ...]) -> dict[tuple[str, ...], CohortSummary]`.
- `CohortSummary.tokens_per_sha() -> int | None` returns `None` for zero SHAs.
- `render_harness_overview` and new `render_topology_overview` display input/output/cache read/cache write, SHAs, commits/session, tokens/SHA, and coverage.

- [ ] **Step 1: Write failing ranking tests**

```python
def test_zero_sha_cohort_is_not_ranked():
    summary = CohortSummary(sessions=2, total_tokens=100, commits=set())
    self.assertIsNone(summary.tokens_per_sha())

def test_sha_is_deduped_per_cohort():
    summary = aggregate([record_with_sha('a'), record_with_sha('a')], ('harness',))['pi']
    self.assertEqual(summary.unique_shas, 1)
```

- [ ] **Step 2: Run tests**

Run: `cd assets && python3 -m unittest -v test_views.py`
Expected: FAIL because `CohortSummary` and generic aggregation do not exist.

- [ ] **Step 3: Implement cohort summary and renderers**

Keep native USD columns, but print `—` for unavailable values and never render a cross-harness USD winner. Render `unknown` topology as its own unranked cohort.

- [ ] **Step 4: Run view tests**

Run: `cd assets && python3 -m unittest -v test_views.py`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assets/views.py assets/test_views.py
git commit -m "feat: report tokens per SHA across harnesses"
```

### Task 5: Route report CLI through canonical views

**Files:**
- Modify: `assets/report.py`
- Modify: `SKILL.md`
- Create: `assets/test_report.py`

**Interfaces:**
- `report.py --view harness|topology --with-commits` loads once through `load_ledger`, enriches once when requested, and renders canonical views.

- [ ] **Step 1: Write failing CLI tests**

```python
def test_topology_view_uses_all_harnesses(capsys):
    main(['--since','2026-09-01','--until','2026-09-01','--view','topology'])
    assert 'Claude' in capsys.readouterr().out
    assert 'Codex' in capsys.readouterr().out
```

- [ ] **Step 2: Run test**

Run: `cd assets && python3 -m unittest -v test_report.py`
Expected: FAIL because the topology view still calls `quad.scan_sessions`.

- [ ] **Step 3: Implement single-load dispatch**

Load and optionally enrich once. Keep the existing no-`--view` output as the Pi-native cost compatibility report. Make `--view topology` cross-tab `harness × topology`; make `--view harness` token/SHA ranking.

- [ ] **Step 4: Update usage documentation and run tests**

Run: `cd assets && python3 -m unittest -v test_report.py test_dataset.py test_views.py`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assets/report.py assets/test_report.py SKILL.md
git commit -m "feat: add cross-harness report views"
```

### Task 6: Convert legacy Pi scripts into compatibility wrappers and verify real data

**Files:**
- Modify: `assets/quad.py`
- Modify: `assets/outcomes.py`
- Modify: `assets/extensions.py`
- Modify: `assets/attribution.py`
- Modify: `assets/test_quad.py`
- Modify: `assets/test_extensions.py`

**Interfaces:**
- Legacy command flags remain available.
- Each script consumes canonical `SessionRecord` records rather than reopening JSONL.

- [ ] **Step 1: Write Pi compatibility assertions**

```python
def test_legacy_pi_fixture_keeps_s4_after_wrapper_migration(self):
    assert scan_sessions('2026-09-01', base=fixture_root)['S4']['n'] == 1
```

- [ ] **Step 2: Run tests**

Run: `cd assets && python3 -m unittest -v test_quad.py test_extensions.py`
Expected: FAIL during migration until wrappers map canonical fields to their legacy cells.

- [ ] **Step 3: Implement wrappers and preserve output labels**

Build legacy cells from records filtered to `harness == 'pi'`; preserve mtime date selection and S1–S4 labels. Retain the j0k3r cutover exclusions and attribution matching semantics.

- [ ] **Step 4: Run complete regression and smoke reports**

Run:
```bash
cd assets
python3 -m unittest -v test_*.py
python3 report.py --since 2026-05-01 --until 2026-09-30 --view harness --with-commits
python3 report.py --since 2026-05-01 --until 2026-09-30 --view topology --with-commits
python3 extensions.py --since 2026-05-01 --until 2026-09-30
```
Expected: all tests pass; reports show Pi, Claude, Codex, no cross-harness USD winner, and token/SHA only for cohorts with SHAs.

- [ ] **Step 5: Commit**

```bash
git add assets
git commit -m "refactor: unify cost analyzer on canonical ledger"
```

## Final verification

- [ ] Run `python3 -m unittest -v test_*.py` from `assets/`.
- [ ] Run both cross-harness reports over May through September with `--with-commits`.
- [ ] Validate the ADR store: `rootline validate --all docs/adr -o json`.
- [ ] Remove generated `__pycache__/` directories.
