# Beads Todo Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the lease-based Beads adapter with a deterministic compact-JSON projector and a Pi `todo`-driven sequential skill.

**Architecture:** `beads_todo_loop.py` owns provider command selection, compact graph projection, single-Bead detail retrieval, evidence containment, and non-leasing finalization. `SKILL.md` materializes the projected graph into Pi todos, executes only the active Bead with the appropriate Superpowers discipline, and does one final new-work snapshot. No normal-loop operation claims work or owns a lease.

**Tech Stack:** Python 3.11+ standard library, `unittest`, Beads 1.3.0, Pi `todo`, JSON, shell subprocesses.

**Spec:** `.workspace/docs/specs/2026-09-23-beads-todo-loop-design.md`

## Global Constraints

- Operate only in the invoking Git repository with `.beads/`.
- `snapshot` uses exactly `list --status open,in_progress,blocked --brief --limit 0 --json` and `list --ready --brief --sort priority --limit 0 --json`.
- `detail` is the only command that returns a Bead description or acceptance criteria.
- `tooling/beads/bd.sh` is the provider command when present; otherwise use `bd`.
- Never issue `--claim`, write `in_progress`, heartbeat, lease, timer, `roadmapctl`, or `brainstorming` in normal loop execution.
- `pass` closes and `fail` blocks only after a regular in-repository evidence file is validated.
- Existing `in_progress` and `blocked` Beads are withheld, never automatically adopted.
- Homeserver E2E uses a disposable local fixture and its exact pinned wrapper; it must not access the shared Dolt service or live backlog.

## Review Focus

- A provider result with description or acceptance text must not leak that text through `snapshot`; Task 1 pins the compact projection.
- `parent-child` relations must not prevent a runnable child; Task 1 pins blocks-only translation.
- A malformed or absent evidence path must never update a Bead; Task 2 pins regular-file, containment, and symlink rejection.
- A legacy `in_progress` Bead must remain withheld and receive no transition; Task 1 pins this status classification.
- A new open Bead inserted after the initial queue must be discovered only by the final snapshot; Task 4 pins one final refresh rather than per-item reconciliation.

---

### Task 1: Replace lease projection with compact snapshot

**Files:**
- Create: `skills/beads-loop/scripts/beads_todo_loop.py`
- Create: `skills/beads-loop/tests/test_beads_todo_loop.py`
- Modify: `skills/beads-loop/SKILL.md` (restore the uncommitted claim-routing experiment before this task's RED step)
- Modify: `skills/beads-loop/tests/test_beads_loop.py` (restore the uncommitted claim-routing experiment before this task's RED step)

**Interfaces:**
- Produces `ProviderCommand(command: tuple[str, ...])` from `resolve_provider(root: Path) -> tuple[str, ...]`.
- Produces `Envelope(kind: str, details: dict[str, object])` serialized as one JSON object.
- Produces `snapshot(cwd: Path) -> Envelope` with `snapshot | no_open | not_beads_repo | provider_failed | malformed_provider_output`.
- `snapshot.details.todos` records contain `key`, `id`, `title`, `priority`, `rank`, `blocked_by`, and `ready`; `withheld` records contain only `id`, `title`, and `status`.

- [ ] **Step 1: Discard the obsolete uncommitted claim-routing experiment**

Run:

```bash
git restore skills/beads-loop/SKILL.md skills/beads-loop/tests/test_beads_loop.py
git status --short
```

Expected: only the committed design documents remain in history; no old `Per-Bead execution discipline` test or text survives into the new RED cycle.

- [ ] **Step 2: Write failing snapshot tests**

Create `skills/beads-loop/tests/test_beads_todo_loop.py` with a `FakeProvider` that records complete command vectors and returns queued `CompletedProcess` results. Add these tests before creating the module:

```python
def test_snapshot_projects_open_graph_without_full_text() -> None:
    result = adapter.snapshot(repo)
    assert result.kind == "snapshot"
    assert result.details["todos"] == [
        {
            "key": "bead:a",
            "id": "a",
            "title": "Implement A",
            "priority": 1,
            "rank": 0,
            "blocked_by": [],
            "ready": True,
        },
        {
            "key": "bead:b",
            "id": "b",
            "title": "Implement B",
            "priority": 1,
            "rank": 1,
            "blocked_by": ["bead:a"],
            "ready": False,
        },
    ]
    assert "secret acceptance text" not in json.dumps(result.details)
    assert all("--claim" not in args for _, args in fake.calls)


def test_snapshot_withholds_legacy_in_progress_and_blocked_work() -> None:
    result = adapter.snapshot(repo)
    assert result.details["withheld"] == [
        {"id": "legacy", "title": "Old run", "status": "in_progress"},
        {"id": "blocked", "title": "Needs input", "status": "blocked"},
    ]
```

Include a third test proving `parent-child` dependencies do not populate `blocked_by`, and two provider-resolution tests: an ordinary fixture returns `("bd",)`, while a fixture containing executable `tooling/beads/bd.sh` returns that absolute wrapper path.

- [ ] **Step 3: Run the focused RED test**

Run:

```bash
python3 skills/beads-loop/tests/test_beads_todo_loop.py -v BeadsTodoLoopTests.test_snapshot_projects_open_graph_without_full_text
```

Expected: FAIL because `beads_todo_loop.py` cannot be imported.

- [ ] **Step 4: Implement the smallest snapshot contract**

Create `skills/beads-loop/scripts/beads_todo_loop.py` with these concrete primitives:

```python
@dataclass(frozen=True)
class Envelope:
    kind: str
    details: dict[str, object]


def resolve_provider(root: Path) -> tuple[str, ...]:
    wrapper = root / "tooling" / "beads" / "bd.sh"
    return (str(wrapper),) if wrapper.is_file() and not wrapper.is_symlink() else ("bd",)


def snapshot(cwd: Path) -> Envelope:
    root = repository_root(cwd)
    if root is None:
        return Envelope("not_beads_repo", {})
    issues = provider_json(root, [
        "list", "--status", "open,in_progress,blocked", "--brief", "--limit", "0", "--json",
    ])
    ready = provider_json(root, [
        "list", "--ready", "--brief", "--sort", "priority", "--limit", "0", "--json",
    ])
    return project_snapshot(issues, ready)
```

`project_snapshot` must validate all provider rows before projecting them, use ready-list position as the ready rank, place remaining open Beads after ready records by `(priority, id)`, map only dependencies where `type == "blocks"`, and emit `no_open` when no open record remains. It must reject malformed JSON or rows as `malformed_provider_output`, never return raw provider rows, and never invoke a mutating command.

- [ ] **Step 5: Run the complete snapshot contract**

Run:

```bash
python3 skills/beads-loop/tests/test_beads_todo_loop.py -v
python3 -m py_compile skills/beads-loop/scripts/beads_todo_loop.py
```

Expected: every snapshot, provider-resolution, malformed-output, ordering, blocks-only, withholding, and no-open test passes.

- [ ] **Step 6: Commit the snapshot unit**

```bash
git add skills/beads-loop/scripts/beads_todo_loop.py skills/beads-loop/tests/test_beads_todo_loop.py skills/beads-loop/SKILL.md skills/beads-loop/tests/test_beads_loop.py
git commit -m "feat(beads-loop): project backlog into compact todos"
```

### Task 2: Add selected detail and non-leasing finalization

**Files:**
- Modify: `skills/beads-loop/scripts/beads_todo_loop.py`
- Modify: `skills/beads-loop/tests/test_beads_todo_loop.py`

**Interfaces:**
- Produces `detail(cwd: Path, bead_id: str) -> Envelope` with `detail | invalid_bead | not_beads_repo | provider_failed | malformed_provider_output`.
- Produces `finalize(cwd: Path, bead_id: str, verdict: Literal["pass", "fail"], evidence: Path) -> Envelope` with `finalized | invalid_evidence | invalid_bead | provider_failed | malformed_provider_output`.

- [ ] **Step 1: Write failing detail and finalization tests**

Add tests before implementation:

```python
def test_detail_returns_full_text_only_for_selected_bead() -> None:
    result = adapter.detail(repo, "a")
    assert result.kind == "detail"
    assert result.details == {
        "id": "a",
        "title": "Implement A",
        "description": "full selected description",
        "acceptance_criteria": "full selected acceptance",
        "status": "open",
    }
    assert fake.calls == [(repo, ("bd", "show", "a", "--json"))]


def test_finalize_pass_uses_nonleasing_update_and_rereads_status() -> None:
    evidence = repo / "reports" / "a.md"
    evidence.parent.mkdir()
    evidence.write_text("evidence", encoding="utf-8")
    result = adapter.finalize(repo, "a", "pass", evidence)
    assert result.kind == "finalized"
    assert fake.calls[0][1] == (
        "bd", "update", "a", "--status", "closed",
        "--append-notes", "PASS evidence=reports/a.md", "--json",
    )
    assert "--claim" not in fake.calls[0][1]
    assert fake.calls[1][1] == ("bd", "show", "a", "--json")
```

Add separate failure assertions for absent evidence, a symlink anywhere below the evidence path, an evidence file outside `root`, malformed ID/verdict, provider non-zero, and a re-read status that does not match the verdict.

- [ ] **Step 2: Run the focused RED tests**

Run:

```bash
python3 skills/beads-loop/tests/test_beads_todo_loop.py -v \
  BeadsTodoLoopTests.test_detail_returns_full_text_only_for_selected_bead \
  BeadsTodoLoopTests.test_finalize_pass_uses_nonleasing_update_and_rereads_status
```

Expected: FAIL because `detail` and `finalize` are absent.

- [ ] **Step 3: Implement detail, evidence validation, and finalize**

Add these operations:

```python
def detail(cwd: Path, bead_id: str) -> Envelope:
    if not valid_bead_id(bead_id):
        return Envelope("invalid_bead", {})
    row = exactly_one_issue(provider_json(root, ["show", bead_id, "--json"]), bead_id)
    return Envelope("detail", selected_detail(row))


def finalize(cwd: Path, bead_id: str, verdict: Literal["pass", "fail"], evidence: Path) -> Envelope:
    evidence_ref = evidence_reference(root, cwd, evidence)
    if evidence_ref is None:
        return Envelope("invalid_evidence", {})
    status = "closed" if verdict == "pass" else "blocked"
    label = "PASS" if verdict == "pass" else "FAIL"
    provider(root, ["update", bead_id, "--status", status, "--append-notes", f"{label} evidence={evidence_ref}", "--json"])
    observed = exactly_one_issue(provider_json(root, ["show", bead_id, "--json"]), bead_id)
    return finalized_or_failure(observed, status, evidence_ref)
```

Use the old adapter's lexical containment and symlink-walk logic as the implementation reference, but do not carry forward actor, assignee, status precondition, or lease behavior.

- [ ] **Step 4: Run all focused unit tests and static syntax check**

Run:

```bash
python3 skills/beads-loop/tests/test_beads_todo_loop.py -v
python3 -m py_compile skills/beads-loop/scripts/beads_todo_loop.py
```

Expected: all detail, evidence, pass/fail, provider-failure, and final-state tests pass.

- [ ] **Step 5: Commit selected detail and finalization**

```bash
git add skills/beads-loop/scripts/beads_todo_loop.py skills/beads-loop/tests/test_beads_todo_loop.py
git commit -m "feat(beads-loop): finalize without claims or leases"
```

### Task 3: Replace the skill with the Todo scheduler contract

**Files:**
- Modify: `skills/beads-loop/SKILL.md`
- Modify: `skills/beads-loop/README.md`
- Modify: `skills/beads-loop/tests/test_beads_loop.py`
- Modify: `skills/beads-loop/tests/smoke_pi_dispatch.py`

**Interfaces:**
- `/beads-loop` resolves `beads_todo_loop.py` relative to the loaded skill.
- It accepts no repository path, Bead selector, or concurrency option.
- It materializes all compact `snapshot.todos` into Pi todos, then calls `detail` only for the active todo.

- [ ] **Step 1: Write failing skill-contract and smoke-probe tests**

Replace claim-specific assertions in `test_beads_loop.py` with a text-order test requiring:

```python
required_in_order = (
    'beads_todo_loop.py snapshot',
    'one `todo` for every',
    'second deterministic pass',
    'detail --bead',
    '`backscroll`',
    '`systematic-debugging`',
    '`test-driven-development`',
    '`executing-plans`',
    '`verification-before-completion`',
    'finalize --bead',
    'final `snapshot`',
)
```

Assert the skill does not contain `--claim`, `lease`, `heartbeat`, `timer`, `roadmapctl`, or `brainstorming`. Update the print smoke prompt to execute `snapshot` and require `not_beads_repo` or `no_open`, not a claim adapter terminal kind.

- [ ] **Step 2: Run the RED contract tests**

Run:

```bash
python3 skills/beads-loop/tests/test_beads_loop.py -v \
  BeadsLoopTests.test_skill_materializes_snapshot_into_todos_without_claims \
  BeadsLoopTests.test_print_probe_returns_snapshot_terminal
```

Expected: FAIL because the published skill names and workflow still describe the old claim adapter.

- [ ] **Step 3: Write the minimal scheduler skill and operator README**

Replace the old adapter section with the three exact commands:

```sh
python3 "$BEADS_TODO_LOOP" snapshot
python3 "$BEADS_TODO_LOOP" detail --bead "$BEAD_ID"
python3 "$BEADS_TODO_LOOP" finalize --bead "$BEAD_ID" --verdict pass|fail --evidence "$EVIDENCE_PATH"
```

Document two-pass `todo` materialization, script-provided rank selection, `outcome=pass|fail` completion metadata, the final new-work snapshot, `withheld` reporting, and proportional Superpowers routing. Update `README.md` to describe the compact JSON projector and disposable-only E2E; retain `/skill:beads-loop` as the operator entry point.

- [ ] **Step 4: Run skill-contract and read-only Pi smoke tests**

Run:

```bash
python3 skills/beads-loop/tests/test_beads_loop.py -v
python3 skills/beads-loop/tests/smoke_pi_dispatch.py --print
python3 skills/beads-loop/tests/smoke_pi_dispatch.py --headed
```

Expected: contract tests pass; print ends with a valid `not_beads_repo` envelope; headed mode observes the skill title without a provider write.

- [ ] **Step 5: Commit the skill contract**

```bash
git add skills/beads-loop/SKILL.md skills/beads-loop/README.md skills/beads-loop/tests/test_beads_loop.py skills/beads-loop/tests/smoke_pi_dispatch.py
git commit -m "feat(beads-loop): schedule execution through todos"
```

### Task 4: Add A4S disposable graph end-to-end coverage

**Files:**
- Create: `skills/beads-loop/tests/e2e_todo_loop.py`
- Modify: `skills/beads-loop/tests/test_beads_todo_loop.py`

**Interfaces:**
- `make_fixture_repo(prefix: str) -> Path` initializes a temporary Git + Beads repository with `A → B` and independent `C`.
- `run_script(repo: Path, *args: str) -> dict[str, object]` invokes the new script and decodes its sole JSON envelope.

- [ ] **Step 1: Write the failing real-provider E2E test**

Add this test to the new test module before creating the E2E helper:

```python
def test_disposable_a4s_graph_projects_and_finalizes_without_lease() -> None:
    repo, ids = make_fixture_repo("a4s")
    first = run_script(repo, "snapshot")
    assert [item["id"] for item in first["details"]["todos"]] == [ids["a"], ids["c"], ids["b"]]
    assert first["details"]["todos"][2]["blocked_by"] == [f"bead:{ids['a']}"]
    assert "lease_expires_at" not in json.dumps(first)
    finalize_with_evidence(repo, ids["a"], "pass")
    finalize_with_evidence(repo, ids["c"], "fail")
    final = run_script(repo, "snapshot")
    assert [item["id"] for item in final["details"]["todos"]] == [ids["b"]]
```

- [ ] **Step 2: Run the E2E RED test**

Run:

```bash
python3 skills/beads-loop/tests/e2e_todo_loop.py -v A4STodoLoopE2ETests.test_disposable_a4s_graph_projects_and_finalizes_without_lease
```

Expected: FAIL because the fixture and script E2E helper do not exist.

- [ ] **Step 3: Implement the disposable A4S fixture**

Create `e2e_todo_loop.py` with `tempfile.TemporaryDirectory`, `git init`, `bd init --non-interactive --skip-agents --skip-hooks --prefix a4s`, and three real `bd create` calls. Add the blocks edge with `bd dep <A> --blocks <B>`. Use regular evidence files under `reports/beads-loop/`, invoke `beads_todo_loop.py` through `sys.executable`, and capture all command output. The test must assert the script command log never contains `--claim`, `heartbeat`, or `lease`.

- [ ] **Step 4: Run all A4S E2E and unit tests**

Run:

```bash
python3 skills/beads-loop/tests/e2e_todo_loop.py -v
python3 skills/beads-loop/tests/test_beads_todo_loop.py -v
```

Expected: the real local Beads graph follows `A, C, B`; only the selected finalization changes status; no lease exists in any script envelope or provider command.

- [ ] **Step 5: Commit A4S E2E**

```bash
git add skills/beads-loop/tests/e2e_todo_loop.py skills/beads-loop/tests/test_beads_todo_loop.py
git commit -m "test(beads-loop): cover disposable todo loop"
```

### Task 5: Prove the Homeserver provider wrapper in an isolated E2E

**Files:**
- Create: `skills/beads-loop/tests/e2e_homeserver_todo_loop.py`
- Modify: `skills/beads-loop/README.md`

**Interfaces:**
- `make_homeserver_fixture(homeserver_root: Path, temporary: Path) -> Path` copies only `tooling/beads/bd.sh` and `tooling/validation/pinned_beads.sh` into a temporary Git root.
- `HOMESERVER_ROOT` selects the checked-out Homeserver repository and is required for this test.

- [ ] **Step 1: Write the failing pinned-wrapper E2E test**

Create a test that requires `HOMESERVER_ROOT`, skips with an explicit message only when it is unset, and otherwise asserts:

```python
def test_homeserver_wrapper_uses_disposable_local_beads_state() -> None:
    repo = make_homeserver_fixture(Path(os.environ["HOMESERVER_ROOT"]), temporary)
    run_wrapper(repo, "init", "--non-interactive", "--skip-agents", "--skip-hooks", "--prefix", "hst")
    snapshot = run_script(repo, "snapshot")
    assert snapshot["kind"] == "snapshot"
    assert "--claim" not in wrapper_command_log
    assert (repo / ".beads").is_dir()
```

Add `A → B` and `C`, finalization, and final-empty-snapshot assertions matching Task 4.

- [ ] **Step 2: Run the Homeserver E2E RED test**

Run:

```bash
HOMESERVER_ROOT=[REDACTED:shared-root]/infra/homeserver \
  python3 skills/beads-loop/tests/e2e_homeserver_todo_loop.py -v
```

Expected: FAIL because the isolated wrapper fixture and test helper do not exist.

- [ ] **Step 3: Implement the isolated wrapper fixture**

Copy the wrapper scripts into `temporary/tooling/` preserving executable mode, initialize a new Git repository at `temporary`, and run the copied `tooling/beads/bd.sh` in that temporary root. Do not copy `.beads`, `.git`, credentials, remotes, source code, or configuration from Homeserver. Assert every provider subprocess has `cwd == temporary` and no command includes `--global`, `--server`, `--shared-server`, `--claim`, or a path outside `temporary` other than the read-only pinned binary cache selected by Homeserver's wrapper.

- [ ] **Step 4: Run Homeserver E2E and inspect its safety evidence**

Run:

```bash
HOMESERVER_ROOT=[REDACTED:shared-root]/infra/homeserver \
  python3 skills/beads-loop/tests/e2e_homeserver_todo_loop.py -v
```

Expected: all synthetic graph assertions pass using the pinned wrapper, and the captured command log proves no shared server or live Homeserver backlog access.

- [ ] **Step 5: Commit Homeserver wrapper coverage**

```bash
git add skills/beads-loop/tests/e2e_homeserver_todo_loop.py skills/beads-loop/README.md
git commit -m "test(beads-loop): exercise Homeserver pinned wrapper"
```

### Task 6: Remove the obsolete lease adapter and run final verification

**Files:**
- Delete: `skills/beads-loop/scripts/beads_loop.py`
- Modify: `skills/beads-loop/tests/test_beads_loop.py`
- Modify: `skills/beads-loop/tests/smoke_pi_dispatch.py`
- Modify: `skills/beads-loop/README.md`

**Interfaces:**
- No shipped file or documentation path refers to `beads_loop.py`, `claim_lost`, actor ownership, `--if-assignee`, `--if-status`, heartbeat, or a lease.
- `beads_todo_loop.py` is the only shipped Beads-loop runtime command.

- [ ] **Step 1: Write failing absence and migration tests**

Add a `shipped_skill_files()` helper and tests that require the old script to be absent and inspect all shipped skill files for forbidden old-contract tokens:

```python
def shipped_skill_files() -> tuple[Path, ...]:
    return (
        SKILL_ROOT / "SKILL.md",
        SKILL_ROOT / "README.md",
        SKILL_ROOT / "scripts" / "beads_todo_loop.py",
        SKILL_ROOT / "tests" / "smoke_pi_dispatch.py",
    )


def test_no_shipped_beads_loop_contract_contains_claim_or_lease() -> None:
    shipped = "\n".join(path.read_text(encoding="utf-8") for path in shipped_skill_files())
    for forbidden in ("beads_loop.py", "--claim", "claim_lost", "lease_expires_at", "heartbeat_at", "--if-assignee"):
        assert forbidden not in shipped
```

Add a snapshot fixture test proving an existing `in_progress` Bead is present only in `withheld` and does not produce an update command.

- [ ] **Step 2: Run the RED cleanup test**

Run:

```bash
python3 skills/beads-loop/tests/test_beads_todo_loop.py -v BeadsTodoLoopTests.test_no_shipped_beads_loop_contract_contains_claim_or_lease
```

Expected: FAIL while the old script remains shipped.

- [ ] **Step 3: Delete the old adapter and update references**

Remove `skills/beads-loop/scripts/beads_loop.py`, delete obsolete ownership/race tests, and update imports, smoke constants, README text, and test discovery to name only `beads_todo_loop.py`. Preserve evidence containment tests by moving them to the new test module.

- [ ] **Step 4: Run final verification**

Run:

```bash
python3 skills/beads-loop/tests/test_beads_todo_loop.py -v
python3 skills/beads-loop/tests/test_beads_loop.py -v
python3 skills/beads-loop/tests/e2e_todo_loop.py -v
HOMESERVER_ROOT=[REDACTED:shared-root]/infra/homeserver python3 skills/beads-loop/tests/e2e_homeserver_todo_loop.py -v
python3 skills/beads-loop/tests/smoke_pi_dispatch.py --print
python3 skills/beads-loop/tests/smoke_pi_dispatch.py --headed
rootline validate .workspace/docs/specs/2026-09-23-beads-todo-loop-design.md -o json
git diff --check
```

Expected: all unit, disposable A4S, disposable Homeserver-wrapper, and Pi smoke tests pass; Rootline validates the approved spec; whitespace check is empty.

- [ ] **Step 5: Commit the removal and verification update**

```bash
git add -A skills/beads-loop
git commit -m "refactor(beads-loop): remove lease adapter"
```

## Plan self-review

- Spec coverage: Tasks 1–2 implement compact projection, selected detail, evidence containment, non-leasing finalization, and withheld legacy status; Task 3 implements Pi todo scheduling and Superpowers routing; Tasks 4–5 provide the requested two repository profiles; Task 6 removes the old contract and reruns every stated check.
- Placeholder scan: no implementation step defers behavior or relies on unspecified test cases.
- Type consistency: `Envelope`, `snapshot`, `detail`, `finalize`, `key`, `rank`, and `blocked_by` are defined before use and retain the same names in every task.
- Review focus: the five failure classes in the header are each pinned by Task 1, 2, or 4 tests.

## Execution Handoff

Plan complete and saved to `.workspace/docs/plans/2026-09-23-beads-todo-loop-implementation.md`. The implementation must use `superpowers:executing-plans` task-by-task, preserve the approved spec, and obtain an independent final review before any integration.
