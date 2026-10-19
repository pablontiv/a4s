# Beads-loop repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore A4S's embedded Beads health gate with evidence-backed metadata repair, a guarded orphan reconciliation, and complete deterministic coverage for the adapter contract.

**Architecture:** Keep `beads_loop.py` fail-closed and retain its existing `embedded_unsupported → conventions` fallback. Expand the existing single-file Python contract suite rather than adding a second adapter layer. Treat Bead descriptions and the stale orphan as operational data: re-read every target, mutate only source-backed fields through `bd update`, and preserve a durable in-repository evidence record.

**Tech Stack:** Python 3 standard library (`unittest`, `subprocess`, `unittest.mock`), Beads CLI (`bd`), Git, Rootline, Pi CLI.

**Spec:** `.workspace/docs/specs/2026-09-23-beads-loop-repair.md`

## Global Constraints

- Scope is A4S only; do not modify Homeserver, introduce a Dolt server, or relax the embedded conventions gate.
- Do not change a target Bead's title, priority, dependencies, status, or assignee while repairing descriptions.
- Every added description section must cite existing issue, parent, accepted-document, or committed-artifact evidence in the repair report; a missing source is an exception, not permission to invent content.
- `a4s-ya4.11` may close only when it remains `in_progress` and assigned to `Pablo`; use `bd update --if-assignee Pablo --if-status in_progress` and re-read it after mutation.
- Real A4S, Homeserver, and Pi smoke checks are read-only: never claim, finalize, update, or close a live Bead during a smoke check.
- Provider output must never appear in an adapter envelope except the bounded, versioned `kind` and `details` contract.

## Review Focus

- A doctor payload split across stdout and stderr must stop as `doctor_failed` without executing the conventions fallback. **Task 1.**
- A repository that disappears between `prime` and `claim` must return `claim_lost(repository_changed)` without issuing `bd ready --claim`. **Task 1.**
- A syntactically valid but non-list claim response must return `claim_lost(unexpected_claim_output)` and must not call `bd show`. **Task 1.**
- `finalize` with an invalid verdict must return `blocked(invalid_verdict)` before resolving evidence or issuing a provider command. **Task 1.**
- A real generic doctor response with warnings remains acceptable only when `overall_ok is True`; the committed Homeserver fixture must reject `false`, missing, or string values. **Task 2.**

---

## File structure

| Path | Responsibility |
| --- | --- |
| `skills/beads-loop/tests/test_beads_loop.py` | Deterministic `run_bd`-boundary contract suite, including every envelope, command sequence, ownership guard, and malformed provider input. |
| `skills/beads-loop/tests/fixtures/doctor/a4s-embedded.json` | Captured, redacted A4S embedded doctor envelope used to prove that only `embedded_unsupported` selects the conventions fallback. |
| `skills/beads-loop/tests/fixtures/doctor/homeserver-generic.json` | Captured, redacted generic doctor projection used to prove the exact `overall_ok is True` compatibility rule. |
| `skills/beads-loop/tests/smoke_pi_dispatch.py` | Explicit manual, read-only Pi smoke probe for headed `/skill:beads-loop` loading and non-interactive terminal-envelope dispatch. |
| `reports/beads-loop/a4s-repair-evidence.md` | Durable inventory, per-field source citation, command result, orphan evidence, smoke result, and exception record. |
| `skills/beads-loop/scripts/beads_loop.py` | Existing adapter implementation; modify only when a newly added contract test exposes a verified behavior gap. |

## Task 1: Complete deterministic adapter-path coverage

**Files:**
- Create: `reports/beads-loop/a4s-repair-evidence.md`
- Modify: `skills/beads-loop/tests/test_beads_loop.py`
- Modify only if a new regression demonstrates a defect: `skills/beads-loop/scripts/beads_loop.py`
- Test: `skills/beads-loop/tests/test_beads_loop.py`

**Interfaces:**
- Consumes: `Envelope(kind: str, details: dict[str, object])`, `prime(cwd: Path) -> Envelope`, `claim(cwd: Path) -> Envelope`, `finalize(cwd: Path, bead_id: str, verdict: Literal["pass", "fail"], evidence: Path) -> Envelope`.
- Produces: a test suite that asserts both returned envelopes and the exact `FakeBd.calls` command sequence for all spec matrix branches.

- [ ] **Step 1: Initialize the durable evidence record, then add the missing doctor, prime, claim, finalize, and CLI contract tests.**

  Create `reports/beads-loop/a4s-repair-evidence.md` containing the empty top-level headings `## Inventory`, `## Description evidence`, `## Orphan evidence`, `## Adapter matrix`, `## Smoke checks`, `## Validation`, and `## Exceptions`. Add these test methods to `BeadsLoopTests`; use the existing `FakeBd`, `completed`, `stdout_json`, `stderr_json`, `make_repo`, and `load_adapter` helpers rather than introducing a second fake provider:

  ```python
  def test_prime_rejects_malformed_doctor_json_without_fallback(self) -> None:
      adapter = load_adapter()
      fake = FakeBd()
      fake.reply(["doctor", "--agent", "--json"], stdout="{not-json secret")
      with tempfile.TemporaryDirectory() as td:
          repo = self.make_repo(Path(td))
          with patch.object(adapter, "run_bd", side_effect=fake):
              result = adapter.prime(repo)
      self.assertEqual(result.kind, "doctor_failed")
      self.assertEqual([args for _, args in fake.calls], [("doctor", "--agent", "--json")])
      self.assertNotIn("secret", json.dumps(result.details))
  ```

  Add analogous tests with these exact assertions:

  | Test name | Fixture input | Expected envelope and no-extra-command assertion |
  | --- | --- | --- |
  | `test_prime_blocks_when_prime_command_fails` | doctor `{status: "ok"}` then `prime --no-memories` exit 7 | `blocked`, `{"reason": "prime_failed", "exit_code": 7}`; never call `ready` |
  | `test_prime_blocks_when_ready_command_is_unavailable` | doctor and prime succeed; `run_bd` raises `FileNotFoundError` for ready | `blocked`, `{"reason": "ready_failed"}` |
  | `test_claim_reports_repository_changed_after_ready_gate` | patch `prime` to `ready`; patch `repository_root` with `[repo, None]` | `claim_lost`, `{"reason": "repository_changed"}`; `FakeBd.calls == []` |
  | `test_claim_rejects_non_list_claim_output` | atomic `ready --claim` returns `{"id": "b-1"}` | `claim_lost`, `{"reason": "unexpected_claim_output"}`; no `show` call |
  | `test_claim_refuses_unresolved_actor_without_show` | atomic claim returns `[{"id": "b-1"}]`; patch `_resolved_actor` to `None` | `claim_lost`, `{"reason": "actor_unresolved"}`; only atomic claim call |
  | `test_finalize_rejects_invalid_verdict_before_provider_call` | `finalize(repo, "b-1", "retry", evidence)` | `blocked`, `{"reason": "invalid_verdict"}`; `FakeBd.calls == []` |
  | `test_main_serializes_one_envelope_for_claim_lost` | patch `claim` to `Envelope("claim_lost", {"reason": "claim_failed"})` | exit 0, one stdout line equal to the versioned JSON envelope, empty stderr |

- [ ] **Step 2: Run only the new contract tests first.**

  Run:

  ```sh
  python3 skills/beads-loop/tests/test_beads_loop.py -v \
    BeadsLoopTests.test_prime_rejects_malformed_doctor_json_without_fallback \
    BeadsLoopTests.test_prime_blocks_when_prime_command_fails \
    BeadsLoopTests.test_claim_reports_repository_changed_after_ready_gate \
    BeadsLoopTests.test_claim_rejects_non_list_claim_output \
    BeadsLoopTests.test_finalize_rejects_invalid_verdict_before_provider_call
  ```

  Expected: every test passes against the existing adapter. If one fails, capture the failing envelope and command sequence in `reports/beads-loop/a4s-repair-evidence.md` before changing `beads_loop.py`.

- [ ] **Step 3: Apply the smallest verified adapter correction only when Step 2 exposes one.**

  Preserve the existing interface and map unexpected provider behavior to an existing terminal envelope. Do not add diagnostic provider text to `details`, do not add a retry, and do not add any global or repository selector. Re-run the single failing test until it passes, then run the complete adapter suite.

- [ ] **Step 4: Run the complete deterministic suite.**

  Run:

  ```sh
  python3 -m unittest skills/beads-loop/tests/test_beads_loop.py -v
  ```

  Expected: zero failures; the fixture loop, real disposable-repository race, pass/fail finalization, and all new boundary tests pass.

- [ ] **Step 5: Commit the contract coverage.**

  ```sh
  git add skills/beads-loop/tests/test_beads_loop.py skills/beads-loop/scripts/beads_loop.py
  git commit -m "test(beads-loop): cover adapter boundary matrix"
  ```

  Stage `beads_loop.py` only when Step 3 changed it.

## Task 2: Add portable doctor snapshots and Pi dispatch smoke probe

**Files:**
- Create: `skills/beads-loop/tests/fixtures/doctor/a4s-embedded.json`
- Create: `skills/beads-loop/tests/fixtures/doctor/homeserver-generic.json`
- Create: `skills/beads-loop/tests/smoke_pi_dispatch.py`
- Modify: `skills/beads-loop/tests/test_beads_loop.py`
- Modify: `skills/beads-loop/README.md`
- Modify: `reports/beads-loop/a4s-repair-evidence.md`
- Test: `skills/beads-loop/tests/test_beads_loop.py`

**Interfaces:**
- Consumes: `subprocess.CompletedProcess[str]` fixture fields `returncode`, `stdout`, and `stderr` plus `adapter._doctor_requires_conventions(result)` and `adapter._is_doctor_success(payload)`.
- Produces: committed, secret-free doctor-shape snapshots and a manually invoked Pi smoke command that exits nonzero on missing skill load or missing terminal JSON envelope.

- [ ] **Step 1: Capture and normalize the two doctor envelopes without mutating either repository.**

  Run exactly these read-only commands and retain only structural fields required by the compatibility contract:

  ```sh
  cd [REDACTED:shared-root]/harness/a4s
  bd doctor --agent --json > /tmp/a4s-embedded-doctor.stdout 2> /tmp/a4s-embedded-doctor.stderr

  cd [REDACTED:shared-root]/infra/homeserver
  bd doctor --agent --json > /tmp/homeserver-generic-doctor.stdout 2> /tmp/homeserver-generic-doctor.stderr
  ```

  Create `a4s-embedded.json` with the observed `embedded_unsupported` source stream and exit code, retaining `code`, `mode`, `unsupported`, and `schema_version`. Create `homeserver-generic.json` with `returncode: 0` and a projection retaining `schema_version`, `overall_ok`, a one-element `diagnostics` shape, and `summary`; omit absolute paths, hints, credentials, and unbounded check arrays.

- [ ] **Step 2: Add snapshot tests that use the committed fixture files.**

  Store each fixture as `{"returncode": int, "stdout": object | null, "stderr": object | null}` and add this local loader:

  ```python
  def doctor_fixture(name: str) -> dict[str, object]:
      path = SKILL_ROOT / "tests" / "fixtures" / "doctor" / f"{name}.json"
      payload = json.loads(path.read_text(encoding="utf-8"))
      if not isinstance(payload, dict):
          raise AssertionError(f"fixture is not an object: {path}")
      return payload

  def fixture_result(payload: dict[str, object]) -> subprocess.CompletedProcess[str]:
      stdout = payload.get("stdout")
      stderr = payload.get("stderr")
      return completed(
          (),
          returncode=payload["returncode"],
          stdout="" if stdout is None else json.dumps(stdout),
          stderr="" if stderr is None else json.dumps(stderr),
      )
  ```

  Assert that `fixture_result(doctor_fixture("a4s-embedded"))` produces `True` from `_doctor_requires_conventions`. Assert that the Homeserver result produces `False` from `_doctor_requires_conventions` and `True` from `_is_doctor_success(doctor_fixture("homeserver-generic")["stdout"])`. For the Homeserver projection, replace `overall_ok` with `False`, `"true"`, and an absent value and assert `_is_doctor_success(...) is False`.

- [ ] **Step 3: Create the explicit read-only Pi smoke probe.**

  Implement `smoke_pi_dispatch.py` with `ROOT = Path(__file__).resolve().parents[3]`, `SKILL = ROOT / "skills" / "beads-loop" / "SKILL.md"`, and two modes:

  ```sh
  python3 skills/beads-loop/tests/smoke_pi_dispatch.py --print
  python3 skills/beads-loop/tests/smoke_pi_dispatch.py --headed
  ```

  `--print` runs this exact argument vector with `cwd=ROOT` and `environment={**os.environ, "PI_OFFLINE": "1"}`:

  ```python
  [
      "pi", "-p", "--no-session", "--approve", "--no-context-files", "--no-extensions",
      "--skill", str(SKILL),
      "Use the beads-loop skill now. Execute its adapter prime command in the current repository, preserve the exact envelope, and stop on a terminal envelope. Do not make changes.",
  ]
  ```

  It parses the last non-empty stdout line as JSON and requires integer `schema_version`, string `kind`, and object `details`. `--headed` opens `pi` in a PTY with `cwd=ROOT`, writes `/skill:beads-loop\\n`, polls readable PTY bytes until the UTF-8 replacement-decoded transcript contains `Beads Autonomous Loop`, then writes `\\x03\\x03` and waits for exit. Both modes must write only ephemeral logs below `tempfile.TemporaryDirectory()` and must never invoke `claim` or `finalize`.

- [ ] **Step 4: Document and execute the smoke probe.**

  Add the two commands and their read-only contract to `skills/beads-loop/README.md`. Run both modes from the A4S worktree and append their exit code, final envelope, and bounded transcript observation to the existing `## Smoke checks` section of `reports/beads-loop/a4s-repair-evidence.md`.

- [ ] **Step 5: Run unit verification and commit.**

  Run:

  ```sh
  python3 -m unittest skills/beads-loop/tests/test_beads_loop.py -v
  git add skills/beads-loop/tests skills/beads-loop/README.md
  git commit -m "test(beads-loop): snapshot doctor compatibility"
  ```

## Task 3: Repair Bead descriptions using a source-cited operational record

**Files:**
- Modify: `reports/beads-loop/a4s-repair-evidence.md`
- Modify: A4S embedded Beads records only through `bd update <id> --description ...`; `.beads/` remains untracked operational state.

**Interfaces:**
- Consumes: `bd lint` output, `bd show <id> --json`, parent records returned by `bd show`, accepted ADRs, and committed artifacts.
- Produces: source-cited descriptions for every provable missing section and a report that distinguishes repaired fields from unresolved evidence gaps.

- [ ] **Step 1: Populate the existing evidence record with a fixed inventory.**

  Under `## Inventory` in `reports/beads-loop/a4s-repair-evidence.md`, record the 23 IDs and the 31 warnings from the current `bd lint` output:

  ```text
  a4s-cxk.3, a4s-uy7.2, a4s-uy7.1, a4s-uy7, a4s-fm9.1, a4s-qvh,
  a4s-fm9, a4s-j11, a4s-6ak.10, a4s-ya4.3, a4s-uy7.3, a4s-3nf,
  a4s-5ib, a4s-9s2, a4s-3ix, a4s-9uw, a4s-tvz, a4s-28t, a4s-r25,
  a4s-w2c, a4s-1to, a4s-pgm, a4s-q2y
  ```

- [ ] **Step 2: Re-read each target and record a field-level source before mutation.**

  For every ID, run `bd show "$ID" --json`, record the current `revision`, the missing heading, and the exact source field or document path in the report. Use only these source priority classes: the target's description; the target's design and notes; a parent record returned by `bd show`; an accepted ADR; or a reachable commit. Preserve existing prose and add the exact heading that `bd lint` requests around source-backed prose.

  Examples of permitted source-preserving transformations:

  ```markdown
  ## Objetivo
  Implementar el provisionador...
  ```

  becomes:

  ```markdown
  ## Objective
  Implementar el provisionador...

  ## Acceptance Criteria
  - La creación configura sparse checkout antes de poblar el worktree.
  ```

  For a bug with an existing problem statement, preserve that text under `## Steps to Reproduce` only when the statement actually contains a reproducible trigger; otherwise enter the missing field under `## Exceptions` and leave the record unchanged.

- [ ] **Step 3: Apply only independently verified description replacements.**

  For each record whose evidence row is complete, write the new full description to a temporary regular file and run:

  ```sh
  bd update "$ID" --body-file "$DESCRIPTION_FILE" --json
  bd show "$ID" --json
  ```

  Confirm on read-back that only the description changed and that every inserted heading and sentence matches the cited source. Do not pass `--status`, `--assignee`, `--priority`, `--parent`, `--type`, `--title`, or dependency flags.

- [ ] **Step 4: Re-run lint and make the success condition explicit.**

  Run:

  ```sh
  bd lint
  ```

  If no warning remains, record the clean output. If an evidence gap remains, record the exact ID and heading under `## Exceptions`; do not add synthetic prose and do not claim the embedded gate is repaired. Escalate that one bounded content decision to the user before attempting any further mutation.

- [ ] **Step 5: Commit the durable evidence report.**

  ```sh
  git add reports/beads-loop/a4s-repair-evidence.md
  git commit -m "docs(beads): record A4S repair evidence"
  ```

## Task 4: Verify and conditionally reconcile `a4s-ya4.11`

**Files:**
- Modify: `reports/beads-loop/a4s-repair-evidence.md`
- Modify: A4S embedded Beads record `a4s-ya4.11` only through guarded `bd update`.
- Test: `skills/beads-loop/tests/test_beads_loop.py`

**Interfaces:**
- Consumes: commit `e344c3e`, its reachable source and focused tests, then a fresh `bd show a4s-ya4.11 --json` record.
- Produces: either a conditionally closed Bead with a repository-relative evidence path or an unchanged Bead plus a bounded failed-precondition record.

- [ ] **Step 1: Verify the historical implementation before any state operation.**

  Run:

  ```sh
  git merge-base --is-ancestor e344c3e HEAD
  git show --stat --oneline e344c3e
  python3 -m unittest skills/beads-loop/tests/test_beads_loop.py -v
  ```

  Record the exit codes and the test summary under `## Orphan evidence`. The first command must exit 0; otherwise do not attempt closure.

- [ ] **Step 2: Create the closure evidence section and inspect live preconditions.**

  Add a subsection headed `### a4s-ya4.11` with the commit ID, changed-artifact list, test command, exit results, and the relative report path `reports/beads-loop/a4s-repair-evidence.md`. Then run:

  ```sh
  bd show a4s-ya4.11 --json
  ```

  Continue only if the returned issue is exactly `status: "in_progress"` and `assignee: "Pablo"`.

- [ ] **Step 3: Close through conditional update and re-read.**

  Run exactly:

  ```sh
  bd update a4s-ya4.11 \
    --status closed \
    --if-assignee Pablo \
    --if-status in_progress \
    --append-notes "PASS evidence=reports/beads-loop/a4s-repair-evidence.md commit=e344c3e" \
    --json
  bd show a4s-ya4.11 --json
  ```

  Exit 13 means a concurrent owner or state change won; record that outcome and make no retry. A successful update is valid only if the re-read shows `closed`, `assignee: "Pablo"`, and the exact evidence note.

- [ ] **Step 4: Commit the updated evidence report.**

  ```sh
  git add reports/beads-loop/a4s-repair-evidence.md
  git commit -m "docs(beads): reconcile harvest-close orphan"
  ```

## Task 5: Run acceptance checks and report only verified state

**Files:**
- Modify: `reports/beads-loop/a4s-repair-evidence.md`

**Interfaces:**
- Consumes: repaired Beads metadata, adapter tests, snapshots, smoke probe, and orphan read-back.
- Produces: an evidence-backed final verdict; no new product behavior.

- [ ] **Step 1: Execute the complete acceptance sequence.**

  Run:

  ```sh
  bd lint
  bd orphans --json
  bd doctor --check conventions --agent --json
  python3 -m unittest skills/beads-loop/tests/test_beads_loop.py -v
  python3 skills/beads-loop/tests/smoke_pi_dispatch.py --print
  python3 skills/beads-loop/tests/smoke_pi_dispatch.py --headed
  rootline validate .workspace/docs/specs/2026-09-23-beads-loop-repair.md -o json
  git diff --check
  ```

- [x] **Step 2: Record exact results and apply the final verdict rule.**

  Record each command, exit code, bounded output, and the `a4s-ya4.11` read-back in `## Validation`. Report success only when lint is clean, `bd orphans --json` exits 0 and parses as either `null` or `[]` (this provider emits literal `null` when no orphan records exist), conventions `overall_ok` is boolean `true`, all tests and both Pi smoke modes exit 0, Rootline is valid, and `git diff --check` is silent. Cite the observed no-orphan provider shape in the final evidence report. Otherwise report the first failed check as the blocker without changing scope.

- [ ] **Step 3: Commit the final evidence update.**

  ```sh
  git add reports/beads-loop/a4s-repair-evidence.md
  git commit -m "docs(beads): verify embedded loop repair"
  ```
