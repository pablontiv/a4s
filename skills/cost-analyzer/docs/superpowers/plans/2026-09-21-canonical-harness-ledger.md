# Canonical Harness Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `s1-s4-cost-analyzer` to `cost-analyzer` and build one canonical ledger that powers Pi, Claude Code, Codex, extension, and topology efficiency views.

**Architecture:** Add a `dataset.py` boundary that parses source JSONL files into immutable `SessionRecord` values, then enriches each record with optional git outcomes. All reports aggregate the ledger; no view reparses JSONL. Pi remains the only harness with native logged USD cost, while Claude/Codex retain token accounting with null native cost.

**Tech Stack:** Python 3 standard library (`dataclasses`, `json`, `pathlib`, `unittest`), existing `git`, optional existing `gh` and `bd` CLIs.

**Spec:** `[REDACTED:home]/.agents/skills/cost-analyzer/references/canonical-dataset-design.md`

## Global Constraints

- Identify harness exclusively from source root: `.pi`, `.claude`, or `.codex`; never from internal `originator`.
- Preserve Pi topology classification, including both delegation representations: `customType='subagent-notify'` and embedded `toolCall` names `subagent`/`subagent_run`.
- Pi’s `usage.cost.total` is `cost_native_usd`; Claude/Codex native cost is `None`.
- Never calculate a cross-harness `$ / SHA` winner unless every cohort has native-cost coverage; instead show coverage and token/outcome metrics.
- Deduplicate SHAs inside each aggregate cohort.
- A Pi session crossing `2026-09-04T04:43:09Z` or lacking a window is `pi_extension='mixed/unknown'` and excluded from extension ranking.
- The target is a global skill directory, not a Git repository. Do not make Git commits.

## Review Focus

- Codex JSONL may declare `originator: Claude Code`; the parser must still emit `harness='codex'` because its storage root is `.codex`.
- Claude/Codex records without native cost must not become `$0` and must not be used in cross-harness `$ / SHA` rankings.
- Pi legacy `subagent_run` must still classify plain sessions as S2 and orchestrated worktree sessions as S4.
- A SHA visible in multiple overlapping records must count once per displayed cohort.
- A session that crosses the extension cutover must appear as `mixed/unknown`, never as j0k3r or pi-subagents.

---

## File Structure

```
~/.agents/skills/cost-analyzer/
├── SKILL.md
├── references/
│   └── canonical-dataset-design.md
├── docs/superpowers/plans/
│   └── 2026-09-21-canonical-harness-ledger.md
├── assets/
│   ├── dataset.py                 # SessionRecord + Pi/Claude/Codex parsers + ledger loader
│   ├── enrich.py                  # git/gh/bd outcome enrichment against SessionRecord
│   ├── views.py                   # harness, extension, topology and cross-tab aggregations
│   ├── report.py                  # CLI selecting ledger views
│   ├── quad.py                    # compatibility CLI delegating to ledger Pi topology view
│   ├── outcomes.py                # compatibility CLI delegating to ledger enrichment/view
│   ├── attribution.py             # consumes SessionRecord, no JSONL parsing
│   ├── extensions.py              # compatibility CLI delegating to extension view
│   ├── test_dataset.py
│   ├── test_views.py
│   ├── test_quad.py
│   ├── test_outcomes.py
│   └── test_extensions.py
└── examples/
    └── report-september-2026.md
```

## Task 1: Create the canonical record and Pi parser

**Files:**
- Create: `assets/dataset.py`
- Create: `assets/test_dataset.py`
- Modify: `assets/quad.py`

**Interfaces:**
- Produces `SessionRecord`, an immutable dataclass with the exact fields in the spec.
- Produces `parse_pi_session(path: Path) -> SessionRecord`.
- Produces `classify_pi_topology(directory: str, custom_types: Counter[str], spawn_tool_calls: int) -> Literal['S1','S2','S3','S4']`.
- `quad.py` consumes `load_ledger(..., harnesses={'pi'})` and retains its current CLI output format.

- [ ] **Step 1: Write failing Pi parser tests**

```python
from pathlib import Path
from dataset import parse_pi_session


def test_pi_parser_keeps_native_cost_and_legacy_s2(tmp_path: Path):
    path = tmp_path / 'plain.jsonl'
    path.write_text(
        '{"type":"session","timestamp":"2026-08-01T00:00:00Z","cwd":"/repo"}\n'
        '{"type":"message","timestamp":"2026-08-01T00:01:00Z","message":{"role":"assistant","content":[{"type":"toolCall","name":"subagent_run"}],"usage":{"cost":{"total":2.5},"input":10,"output":4}}}\n'
    )
    record = parse_pi_session(path)
    assert record.harness == 'pi'
    assert record.cost_native_usd == 2.5
    assert record.topology == 'S2'
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd ~/.agents/skills/s1-s4-cost-analyzer/assets && python3 -m unittest -v test_dataset.py`

Expected: FAIL because `dataset` does not exist.

- [ ] **Step 3: Implement the minimum Pi parser**

```python
@dataclass(frozen=True)
class SessionRecord:
    id: str | None
    harness: str
    source_path: str
    schema_version: str
    started_at: datetime | None
    ended_at: datetime | None
    cwd: str | None
    model: str | None
    provider: str | None
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    cost_native_usd: float | None
    topology: str | None
    pi_extension: str | None
    commits: frozenset[str] = frozenset()
    prs: frozenset[int] = frozenset()
    beads_closed: frozenset[str] = frozenset()
```

Implement `parse_pi_session()` by moving the existing `quad.py` parsing rules unchanged. Its delegation test is `subagent-notify OR {'subagent','subagent_run'}`; extension classification uses the verified cutover constant.

- [ ] **Step 4: Run the Pi parser tests and current topology regression tests**

Run: `python3 -m unittest -v test_dataset.py test_quad.py`

Expected: PASS. The legacy `subagent_run` regression remains S2.

- [ ] **Step 5: Make `quad.py` a compatibility wrapper**

Replace direct JSONL parsing in `quad.py` with `load_ledger()` + a Pi topology aggregate. Preserve `--since`, `--until`, `--json`, and `--files`; write a regression that its August result contains S2=66.

- [ ] **Step 6: Run all Task 1 tests**

Run: `python3 -m unittest -v test_dataset.py test_quad.py`

Expected: PASS.

## Task 2: Add Claude and Codex parsers

**Files:**
- Modify: `assets/dataset.py`
- Modify: `assets/test_dataset.py`

**Interfaces:**
- Produces `parse_claude_session(path: Path) -> SessionRecord`.
- Produces `parse_codex_session(path: Path) -> SessionRecord`.
- Produces `load_ledger(since: date, until: date | None, roots: Mapping[str, Path] = DEFAULT_ROOTS) -> list[SessionRecord]`.

- [ ] **Step 1: Write failing source-identification tests**

```python
def test_claude_parser_has_no_native_cost(tmp_path: Path):
    path = tmp_path / 'claude.jsonl'
    path.write_text(
        '{"type":"assistant","timestamp":"2026-09-01T00:00:00Z",'
        '"message":{"model":"claude-sonnet","usage":{"input_tokens":11,"output_tokens":3}}}\n'
    )
    record = parse_claude_session(path)
    assert record.harness == 'claude'
    assert record.cost_native_usd is None
    assert record.topology is None


def test_codex_parser_uses_source_not_originator(tmp_path: Path):
    path = tmp_path / 'codex.jsonl'
    path.write_text(
        '{"timestamp":"2026-09-01T00:00:00Z","type":"session_meta",'
        '"payload":{"originator":"Claude Code","cwd":"/repo"}}\n'
        '{"timestamp":"2026-09-01T00:01:00Z","type":"event_msg",'
        '"payload":{"type":"token_count","info":{"total_token_usage":'
        '{"input_tokens":20,"cached_input_tokens":5,"output_tokens":4}}}}\n'
    )
    record = parse_codex_session(path)
    assert record.harness == 'codex'
    assert record.input_tokens == 20
    assert record.cost_native_usd is None
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `python3 -m unittest -v test_dataset.py`

Expected: FAIL because the two parser functions do not exist.

- [ ] **Step 3: Implement Claude and Codex token extractors**

- Claude reads `type='assistant'`, uses `message.usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}`, and takes model from `message.model`.
- Codex reads `type='session_meta'` for id/cwd/window start and `type='event_msg', payload.type='token_count'` for the latest `payload.info.total_token_usage`; map `cached_input_tokens` and `cache_write_input_tokens`.
- Set topology and extension `None` for both parsers.
- `load_ledger()` chooses parser from its configured root key, not any inner field.

- [ ] **Step 4: Run parser tests**

Run: `python3 -m unittest -v test_dataset.py test_quad.py`

Expected: PASS.

- [ ] **Step 5: Smoke-test each real root without printing content**

Run:

```bash
python3 - <<'PY'
from datetime import date
from dataset import load_ledger
records = load_ledger(date(2026, 8, 1), date(2026, 9, 30))
for harness in ('pi', 'claude', 'codex'):
    print(harness, sum(r.harness == harness for r in records))
PY
```

Expected: all three counts are non-zero; no raw prompt content is emitted.

## Task 3: Move outcome enrichment to canonical records

**Files:**
- Create: `assets/enrich.py`
- Modify: `assets/outcomes.py`
- Modify: `assets/test_outcomes.py`
- Modify: `assets/attribution.py`

**Interfaces:**
- Produces `enrich_records(records: Iterable[SessionRecord], with_prs: bool, with_beads: bool) -> list[SessionRecord]`.
- Produces `unique_shas(records: Iterable[SessionRecord]) -> frozenset[str]`.
- `attribution.py` consumes Pi `SessionRecord` values and their timestamps/cwds.

- [ ] **Step 1: Write failing deduplication and no-cwd tests**

```python
def test_unique_shas_deduplicates_overlapping_records():
    records = [replace(RECORD_A, commits=frozenset({'abc'})), replace(RECORD_B, commits=frozenset({'abc', 'def'}))]
    assert unique_shas(records) == frozenset({'abc', 'def'})


def test_enrichment_keeps_record_with_no_cwd_unchanged():
    record = replace(RECORD_A, cwd=None)
    assert enrich_records([record], with_prs=False, with_beads=False)[0].commits == frozenset()
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `python3 -m unittest -v test_outcomes.py`

Expected: FAIL because `enrich_records` and `unique_shas` do not exist.

- [ ] **Step 3: Implement immutable enrichment**

Use `dataclasses.replace()` to add git SHAs, optional PR numbers, and optional bead IDs to each record. Do not mutate a record. Pi/Claude/Codex all use the same git enrichment when their `cwd` is a local Git repository; beads remain Pi/a4s-specific.

- [ ] **Step 4: Convert existing CLIs to records**

- `outcomes.py` loads ledger records, calls `enrich_records`, then renders the old Pi topology table.
- `attribution.py` accepts only records where `harness='pi'` and topology is S3/S4 or S1.

- [ ] **Step 5: Run outcome and attribution regressions**

Run: `python3 -m unittest -v test_outcomes.py test_extensions.py test_quad.py test_dataset.py`

Expected: PASS.

## Task 4: Implement canonical views and harness report

**Files:**
- Create: `assets/views.py`
- Create: `assets/test_views.py`
- Modify: `assets/report.py`

**Interfaces:**
- Produces `aggregate_harness(records) -> dict[str, HarnessSummary]`.
- Produces `aggregate_pi_extension(records) -> dict[str, ExtensionSummary]`.
- Produces `aggregate_pi_topology(records) -> dict[str, TopologySummary]`.
- Produces `render_harness_overview(summary) -> str`.

- [ ] **Step 1: Write failing cost-coverage test**

```python
def test_harness_view_does_not_rank_by_dollars_when_cost_coverage_is_partial():
    records = [
        replace(PI_RECORD, harness='pi', cost_native_usd=4.0, commits=frozenset({'a'})),
        replace(CLAUDE_RECORD, harness='claude', cost_native_usd=None, commits=frozenset({'b'})),
    ]
    text = render_harness_overview(aggregate_harness(records))
    assert 'winner $/SHA: unavailable' in text
    assert 'cost coverage 1/1' in text
    assert 'cost coverage 0/1' in text
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `python3 -m unittest -v test_views.py`

Expected: FAIL because `views` does not exist.

- [ ] **Step 3: Implement views**

- Harness overview: sessions, native-cost sum, native-cost coverage, input/output/cache tokens, unique SHAs, PRs, beads.
- Never calculate an all-harness `$ / SHA` winner while a harness lacks native cost.
- Pi extension overview: filter Pi, exclude `mixed/unknown` only from ranking, show it separately.
- Pi topology overview: Pi-only S1–S4 with model/provider breakdown available through `--cross-tab topology-model`.

- [ ] **Step 4: Make `report.py` select views**

Add:

```bash
python3 report.py --since 2026-08-01 --until 2026-09-30 --view harness
python3 report.py --since 2026-08-01 --until 2026-09-30 --view extension
python3 report.py --since 2026-08-01 --until 2026-09-30 --view topology
python3 report.py --since 2026-08-01 --until 2026-09-30 --view all
```

Default is `--view all`; `--no-prs` and `--no-beads` remain supported.

- [ ] **Step 5: Run views tests and one real smoke report**

Run:

```bash
python3 -m unittest -v test_views.py test_dataset.py test_outcomes.py test_quad.py test_extensions.py
python3 report.py --since 2026-08-01 --until 2026-09-30 --view harness --no-prs --no-beads
```

Expected: all tests PASS; smoke output contains harness rows Pi, Claude, Codex and explicitly displays native-cost coverage.

## Task 5: Rename and publish the skill

**Files:**
- Move: `~/.agents/skills/s1-s4-cost-analyzer/` → `~/.agents/skills/cost-analyzer/`
- Modify: `SKILL.md`
- Modify: all `references/*.md`, `docs/**/*.md`, `examples/*.md`, and script docstrings containing the old path/name.

**Interfaces:**
- Produces skill frontmatter `name: cost-analyzer`.
- Keeps `quad.py`, `extensions.py`, and `outcomes.py` as compatibility commands under the renamed root.

- [ ] **Step 1: Write a failing discovery test for the renamed public contract**

```python
def test_skill_frontmatter_uses_cost_analyzer_name():
    skill = Path(__file__).parents[1] / 'SKILL.md'
    assert skill.read_text().splitlines()[1] == 'name: cost-analyzer'
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `python3 -m unittest -v test_skill_contract.py`

Expected: FAIL because the file/test path still resolves to `s1-s4-cost-analyzer` or the frontmatter uses the old name.

- [ ] **Step 3: Move the skill and update all references**

```bash
mv ~/.agents/skills/s1-s4-cost-analyzer ~/.agents/skills/cost-analyzer
```

Update every hard-coded path and frontmatter name to `cost-analyzer`. Do not leave a symlink: skill discovery must expose one canonical name.

- [ ] **Step 4: Run the full suite from the renamed path**

Run:

```bash
cd ~/.agents/skills/cost-analyzer/assets
python3 -m unittest -v test_dataset.py test_outcomes.py test_views.py test_quad.py test_extensions.py test_skill_contract.py
python3 report.py --since 2026-08-01 --until 2026-09-30 --view all --no-prs --no-beads
```

Expected: all tests PASS; report renders Pi, Claude, Codex plus Pi extension/topology views.

- [ ] **Step 5: Clean generated Python artifacts and inspect final tree**

Run:

```bash
find ~/.agents/skills/cost-analyzer -type d -name __pycache__ -prune -exec rm -rf {} +
find ~/.agents/skills/cost-analyzer -type f | sort
```

Expected: no `__pycache__`; docs, source, tests, and examples exist under the renamed root.

## Plan Self-Review

- **Spec coverage:** Task 1 covers canonical Pi fields/topology/extension; Task 2 covers Claude/Codex and source-root identity; Task 3 covers immutable outcomes and SHA deduplication; Task 4 covers all four views and native-cost coverage; Task 5 covers the approved rename and compatibility commands.
- **Review focus coverage:** Codex originator is Task 2; partial cost coverage is Task 4; legacy Pi classification is Task 1; duplicate SHAs is Task 3; extension cutover is retained by Task 1 and existing `test_extensions.py`.
- **Type consistency:** `SessionRecord` is produced only by `dataset.py`, enriched only by `enrich.py`, and consumed by `views.py`/compatibility CLIs.
- **Placeholder scan:** no deferred work markers or implicit testing steps remain.

## Execution Handoff

Plan complete and saved to `[REDACTED:home]/.agents/skills/cost-analyzer/docs/superpowers/plans/2026-09-21-canonical-harness-ledger.md`.

Please review the plan. I recommend **Native** execution: parser, enrichment, views, and rename have coupled interfaces, and a single implementer can preserve the ledger contract more safely than concurrent edits. Does the plan capture what you want, and should I execute it natively?
