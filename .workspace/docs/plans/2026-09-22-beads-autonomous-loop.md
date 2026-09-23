# Beads Autonomous Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a portable Beads loop whose deterministic Python adapter lets Pi and Claude execute canonical ready work one Bead at a time from the current repository.

**Architecture:** `skills/beads-loop/` is self-contained. Its standard-library Python adapter owns repository detection, safe `bd` subprocess calls, JSON validation, atomic claim verification, evidence-bound finalization, and stable result envelopes. `SKILL.md` is only the Pi/Claude workflow that invokes the adapter and executes the claimed Bead; it never selects work itself.

**Tech Stack:** Python 3.11+ standard library, `unittest`, installed `bd` 1.3.0, shell subprocesses, Agent Skills Markdown.

**Spec:** `.workspace/docs/specs/2026-09-22-beads-autonomous-loop-design.md`

## Global Constraints

- `/beads-loop` runs only in the current Git checkout containing `.beads/`; no repo path or Bead ID input.
- `bd` alone selects and atomically claims work through `bd ready --sort priority --claim --json`.
- Never use `bd --global`, `bd remember`, `bd memories`, Rootline, Herdr, a queue, daemon, scheduler, or state store.
- `bd prime --no-memories` runs but its text is discarded structurally.
- Generic `bd doctor --agent --json` may fall back only on its documented `embedded_unsupported` result to `bd doctor --check conventions --agent --json`.
- `pass` closes with an evidence path; `fail` blocks with an evidence path; no `--claim-next` or `--continue`.
- Every deliverable has focused unit tests, a real temporary-repository headless check, and documented manual verification.

## Review Focus

- Invocation outside Git or without `.beads/` must make no `bd` write.
- Doctor failure other than `embedded_unsupported` must stop; no fallback is permitted.
- Any `bd prime` body, including `remember` instructions, must never be returned to the skill.
- A concurrent claimant or mismatched post-claim assignee/status must never start work.
- Evidence paths outside the repository, symlinks, or missing files must never close or block a Bead.

---

### Task 1: Build the read-only adapter contract

**Files:**
- Create: `skills/beads-loop/scripts/beads_loop.py`
- Create: `skills/beads-loop/tests/test_beads_loop.py`
- Create: `skills/beads-loop/fixtures/`

**Interfaces:**
- Produces `main(argv: Sequence[str]) -> int` with `prime` subcommand.
- Produces `run_bd(cwd: Path, args: Sequence[str]) -> CompletedProcess[str]` and `Envelope(kind: str, details: dict[str, object])` serialized as one JSON object.
- Produces `prime(cwd: Path) -> Envelope` with `ready|no_ready|blocked|not_beads_repo|doctor_failed`.

- [ ] **Step 1: Write failing unit tests for repository and doctor behavior**

```python
def test_prime_rejects_non_beads_directory_without_subprocess() -> None:
    result = run_adapter(tmp_path, "prime")
    assert result["kind"] == "not_beads_repo"
    assert fake.calls == []

def test_prime_uses_conventions_only_for_embedded_unsupported() -> None:
    fake.reply(["doctor", "--agent", "--json"], stderr_json({"code": "embedded_unsupported"}), 1)
    fake.reply(["doctor", "--check", "conventions", "--agent", "--json"], stdout_json({"status": "ok"}))
    assert prime(repo)["kind"] in {"ready", "no_ready", "blocked"}
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `python3 -m unittest skills/beads-loop/tests/test_beads_loop.py -v`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement minimal read-only adapter primitives**

```python
def repository_root(cwd: Path) -> Path | None: ...
def parse_json_output(result: CompletedProcess[str]) -> object: ...
def prime(cwd: Path) -> Envelope:
    # detect git/.beads; run doctor; run prime --no-memories and discard stdout;
    # run ready --sort priority --json; never mutate.
    ...
```

Treat stdout and stderr JSON separately only for the documented doctor unsupported result; reject malformed, unexpected, or ambiguous JSON.

- [ ] **Step 4: Add tests that pin prime-output discard and ready classifications**

```python
def test_prime_discards_text_containing_bd_remember() -> None:
    fake.reply(["prime", "--no-memories"], stdout="use bd remember secret")
    result = prime(repo)
    assert "remember" not in json.dumps(result.details).lower()

def test_prime_classifies_empty_ready_list() -> None:
    fake.reply(["ready", "--sort", "priority", "--json"], stdout_json([]))
    assert prime(repo).kind == "no_ready"
```

- [ ] **Step 5: Run tests and a headless real-CLI read-only check**

Run:

```bash
python3 -m unittest skills/beads-loop/tests/test_beads_loop.py -v
repo=$(mktemp -d)
(cd "$repo" && git init -q && bd init --quiet && python3 "$OLDPWD/skills/beads-loop/scripts/beads_loop.py" prime)
```

Expected: all tests pass; the temporary repository returns a JSON envelope and no Bead is claimed.

- [ ] **Step 6: Commit Task 1**

```bash
git add skills/beads-loop/scripts/beads_loop.py skills/beads-loop/tests/test_beads_loop.py skills/beads-loop/fixtures
git commit -m "feat: add Beads loop read-only adapter"
```

### Task 2: Add atomic claim and evidence-bound finalization

**Files:**
- Modify: `skills/beads-loop/scripts/beads_loop.py`
- Modify: `skills/beads-loop/tests/test_beads_loop.py`

**Interfaces:**
- Produces `claim(cwd: Path) -> Envelope` with `claimed|no_ready|claim_lost|doctor_failed`.
- Produces `finalize(cwd: Path, bead_id: str, verdict: Literal["pass", "fail"], evidence: Path) -> Envelope`.

- [ ] **Step 1: Write failing claim/finalize tests**

```python
def test_claim_refuses_post_claim_assignee_mismatch() -> None:
    fake.reply(["ready", "--sort", "priority", "--claim", "--json"], stdout_json([{"id": "b-1"}]))
    fake.reply(["show", "b-1", "--json"], stdout_json([{"id": "b-1", "status": "in_progress", "assignee": "other"}]))
    assert claim(repo).kind == "claim_lost"

def test_finalize_rejects_outside_repo_evidence() -> None:
    assert finalize(repo, "b-1", "pass", outside_file).kind == "invalid_evidence"
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `python3 -m unittest skills/beads-loop/tests/test_beads_loop.py -v`

Expected: FAIL because `claim` and `finalize` do not exist.

- [ ] **Step 3: Implement claim and finalize without selection policy**

```python
def claim(cwd: Path) -> Envelope:
    gate = prime(cwd)
    if gate.kind != "ready": return gate
    claimed = run_bd(cwd, ["ready", "--sort", "priority", "--claim", "--json"])
    # show exact returned id; require in_progress and resolved actor.

def finalize(cwd: Path, bead_id: str, verdict: str, evidence: Path) -> Envelope:
    # require regular, non-symlinked path resolving below cwd.
    # pass: close --reason evidence=...; fail: update blocked + append-notes.
    # show and validate final status.
```

- [ ] **Step 4: Add real temporary-repository concurrency and finalization tests**

```python
def test_two_process_claim_race_has_one_winner() -> None:
    # create one ready Bead in a temporary bd repo; start two adapter claim subprocesses.
    assert sorted(envelope["kind"] for envelope in results) == ["claimed", "no_ready"]

def test_real_finalize_maps_pass_and_fail() -> None:
    assert show_after_pass["status"] == "closed"
    assert show_after_fail["status"] == "blocked"
```

- [ ] **Step 5: Run all adapter tests and manual race check**

Run:

```bash
python3 -m unittest discover -s skills/beads-loop/tests -t skills/beads-loop -p 'test_*.py' -v
# Follow the documented two-terminal command sequence from SKILL.md against one disposable bd init repository.
```

Expected: one claimant only; no implicit next claim; evidence appears in close reason or notes.

- [ ] **Step 6: Commit Task 2**

```bash
git add skills/beads-loop/scripts/beads_loop.py skills/beads-loop/tests/test_beads_loop.py
git commit -m "feat: add Beads loop claim and finalization"
```

### Task 3: Publish the Pi/Claude workflow and headless end-to-end contract

**Files:**
- Create: `skills/beads-loop/SKILL.md`
- Modify: `skills/beads-loop/tests/test_beads_loop.py`
- Modify: `README.md`

**Interfaces:**
- `/beads-loop` invokes `python3 scripts/beads_loop.py prime|claim|finalize` relative to its own skill directory.
- The skill accepts no repository or Bead selector and terminates only on the adapter terminal envelope.

- [ ] **Step 1: Write failing documentation/contract tests**

```python
def test_skill_never_documents_bd_memories_or_global_selection() -> None:
    text = SKILL.read_text()
    assert "bd remember" not in text and "bd memories" not in text
    assert "--global" not in text and "--claim-next" not in text

def test_headless_loop_fixture_ends_after_no_ready() -> None:
    result = run_scripted_loop(real_temp_repo)
    assert result["terminal"] == "no_ready"
    assert result["claimed_ids"] == expected_cli_order
```

- [ ] **Step 2: Run tests and verify failure**

Run: `python3 -m unittest discover -s skills/beads-loop/tests -t skills/beads-loop -p 'test_*.py' -v`

Expected: FAIL because the skill and scripted loop fixture are absent.

- [ ] **Step 3: Write the self-contained skill**

Document exactly: current-repo guard; `prime`; one `claim`; read Bead and acceptance; write an in-repo evidence report; run applicable checks; `finalize`; repeat. State that failed validation calls `finalize fail`, and `claim_lost`, `blocked`, or doctor failure stops with the returned evidence. Do not include any selector, memory command, sibling skill dependency, provider call, or deployment mutation.

- [ ] **Step 4: Implement the headless end-to-end fixture**

Use a real disposable Git + `bd init` repository containing ready, blocked, and closed Beads. Exercise adapter commands in the same sequence the skill prescribes, assert only `bd ready --claim` determines each claimed ID, and assert terminal `no_ready` after finalization.

- [ ] **Step 5: Run repository and skill gates**

Run:

```bash
python3 -m unittest discover -s skills/beads-loop/tests -t skills/beads-loop -p 'test_*.py' -v
npm test
npm run typecheck
git diff --check
```

Expected: all pass. Perform the documented disposable-repository manual test once; do not install globally yet.

- [ ] **Step 6: Commit Task 3**

```bash
git add skills/beads-loop README.md
git commit -m "feat: add portable Beads autonomous loop skill"
```

### Task 4: Review, delivery evidence, and authorized global projection

**Files:**
- Modify: `skills/beads-loop/SKILL.md`
- Modify: `README.md` only if review finds discovery/documentation drift.

**Interfaces:**
- The repository directory remains the sole canonical source.
- Global links are an explicit post-delivery operation, not an implementation side effect.

- [ ] **Step 1: Request independent review of the exact implementation SHA**

Provide the reviewer the spec, ADR 0032, this plan, diff, unit output, race output, headless output, and manual evidence. Require review of outside-repo failure, doctor fallback, prime discard, race safety, evidence containment, and absence of memory/Rootline/Herdr paths.

- [ ] **Step 2: Apply only verified review findings and rerun affected tests**

Run: `python3 -m unittest discover -s skills/beads-loop/tests -t skills/beads-loop -p 'test_*.py' -v`

Expected: PASS after each accepted correction.

- [ ] **Step 3: Run final full verification**

Run:

```bash
python3 -m unittest discover -s skills/beads-loop/tests -t skills/beads-loop -p 'test_*.py' -v
npm test
npm run typecheck
git diff --check
```

Expected: all commands exit 0 and the working tree contains only intended reviewed changes.

- [ ] **Step 4: Obtain explicit authorization before global installation**

Present the exact two symlink targets and verify existing destinations read-only. Do not replace, delete, or create global runtime entries without authorization.

- [ ] **Step 5: Commit any review-only documentation correction**

```bash
git add skills/beads-loop README.md
git commit -m "docs: verify Beads loop delivery"
```
