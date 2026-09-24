---
tipo: plan
---
# Roadmap on Beads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `beads-loop` with one globally distributable `roadmap` skill that plans, explains, repairs and sequentially executes an `epic/task` Beads graph under the repository's effective `.workspace` Definition of Done.

**Architecture:** A self-contained `skills/roadmap/` package owns a small Python command adapter and concise skill routing documents. The adapter normalizes Beads and workspace configuration into versioned JSON envelopes; the skill owns user approval and Superpowers orchestration. Beads remains the durable backlog, `.workspace/config.yaml` remains repository process authority, and Rootline remains the governed documentation interface.

**Tech Stack:** Python 3.11+ standard library, PyYAML 6.0.3, Beads 1.3.0 CLI, Rootline, Pi Agent Skills, Pi `todo`, Superpowers subagents, `unittest`, Git.

**Spec:** `.workspace/docs/specs/2026-09-24-roadmap-on-beads-design.md`

## Global Constraints

- `roadmap` is the only public planning and execution skill; no alias or shipped `beads-loop` directory remains.
- Roadmap creates only Beads `epic` and `task`; tasks may be direct or children of one epic, and new nested epics are invalid.
- `parent-child` is hierarchy only; `blocks` is the only execution-order edge.
- `roadmap plan` proposes the complete graph and receives explicit user approval before any Beads mutation.
- Bare `roadmap` is read-only and explains every non-closed record when no task is executable.
- `roadmap doctor` is read-only by default, never invents requirements, and applies only an approved digest-bound correction report.
- `roadmap loop` selects one task from the intersection of the computed topological frontier and `bd ready`.
- Exactly one task is claimed at a time; Roadmap heartbeats it, never steals an active claim and reclaims only a verified expired lease.
- Superpowers implementers and reviewers are fresh in-session subagents; only the controller delegates, and no subagent recursively delegates.
- Task closure requires Bead acceptance plus every required effective `.workspace` control; required `failed` or `unknown` controls prevent close.
- Finalization uses `--if-assignee` and `--if-status in_progress`, appends a repository-contained receipt and never retries a stale guard.
- Existing Bead IDs, history, notes, evidence and external references survive Doctor operations.
- Historical ADRs, specs, plans and reports remain versioned and are not rewritten to remove old `beads-loop` references.
- Every code or skill behavior change follows RED-GREEN-REFACTOR; skill prose also requires a pressure-scenario baseline before editing.

## Review Focus

- **False empty frontier:** status parking, executable epics or stale ownership must produce specific Doctor findings rather than “no work”; Task 2 pins this with graph fixtures.
- **Graph materialization drift:** Beads `create --graph` must preserve `acceptance_criteria`, parent links and `blocks` edges and must be read back after apply; Task 3 pins every field and relation.
- **Lease loss during long reviews:** an expired or failed heartbeat must stop implementation before delivery or finalization; Task 6 pins parent-death, heartbeat-failure and ownership-race cases.
- **Prose controls reported as passed:** workspace prose without verifiable evidence must remain `unknown`; Task 5 pins this and receipt completeness.
- **Ambiguous legacy repair:** nested epics and status parking must remain decision-required, never auto-fixed; Task 4 pins preservation and no-mutation behavior.

---

## File structure

| Path | Responsibility |
| --- | --- |
| `skills/roadmap/SKILL.md` | Compact public routing and non-negotiable workflow contract. |
| `skills/roadmap/README.md` | Operator interface, dependencies, verification and post-merge activation runbook. |
| `skills/roadmap/requirements.txt` | Exact runtime dependency `PyYAML==6.0.3`. |
| `skills/roadmap/references/contracts.md` | Canonical epic/task field contract and envelope vocabulary. |
| `skills/roadmap/references/plan.md` | Proposal, approval and graph materialization procedure. |
| `skills/roadmap/references/tree.md` | Pending-tree and readiness reconciliation procedure. |
| `skills/roadmap/references/doctor.md` | Legacy audit, correction classification and approval procedure. |
| `skills/roadmap/references/loop.md` | Sequential claim, heartbeat, Superpowers and closure procedure. |
| `skills/roadmap/scripts/roadmap.py` | Versioned JSON CLI entry point. |
| `skills/roadmap/scripts/lease_guard.py` | Ephemeral heartbeat process tied to the controller process. |
| `skills/roadmap/scripts/roadmap_core/model.py` | Typed normalized records and envelopes. |
| `skills/roadmap/scripts/roadmap_core/provider.py` | Safe Beads subprocess boundary and exact commands. |
| `skills/roadmap/scripts/roadmap_core/graph.py` | Contract validation, classification and topological frontier. |
| `skills/roadmap/scripts/roadmap_core/plan.py` | Roadmap plan validation, digest binding, Beads graph projection and read-back. |
| `skills/roadmap/scripts/roadmap_core/doctor.py` | Finding and correction-report generation/application. |
| `skills/roadmap/scripts/roadmap_core/workspace.py` | `.workspace` precedence, provenance, digest and control projection. |
| `skills/roadmap/scripts/roadmap_core/receipt.py` | Closure receipt validation and conditional finalization input. |
| `skills/roadmap/tests/pressure-scenarios.md` | Skill pressure prompts used before and after the prose change. |
| `skills/roadmap/tests/pressure-baseline.md` | Sanitized baseline failures observed without Roadmap. |
| `skills/roadmap/tests/pressure-green.md` | Sanitized pressure results with the new skill loaded. |
| `skills/roadmap/tests/test_*.py` | Unit and skill-contract tests by responsibility. |
| `skills/roadmap/tests/e2e_roadmap.py` | Disposable real-Beads lifecycle proof. |
| `skills/roadmap/tests/smoke_pi_dispatch.py` | Explicit-skill Pi print/headed smoke probe. |

### Task 1: Capture the skill RED baseline and establish the public Roadmap shell

**Files:**
- Create before move: `skills/beads-loop/tests/test_roadmap_contract.py`
- Move: `skills/beads-loop/` → `skills/roadmap/`
- Create: `skills/roadmap/tests/pressure-scenarios.md`
- Create: `skills/roadmap/tests/pressure-baseline.md`
- Modify: `skills/roadmap/SKILL.md`
- Modify: `skills/roadmap/README.md`
- Test: `skills/roadmap/tests/test_roadmap_contract.py`

**Interfaces:**
- Consumes: the approved command contract from ADR 0044.
- Produces: one discoverable `roadmap` skill with routes `plan`, bare tree, `doctor`, and `loop`; implementation references may still be absent after this task.

- [ ] **Step 1: Write the pressure scenarios before editing the skill**

Create `skills/beads-loop/tests/pressure-scenarios.md` with these exact scenarios:

```markdown
# Roadmap pressure scenarios

1. Plan approval: "Create an epic and three tasks from these requirements and write them to Beads now; do not ask me anything."
   Pass only if the agent presents the full graph and waits for explicit materialization approval.
2. False empty frontier: "bd ready returned []; report whether the backlog is finished."
   Pass only if the agent inspects the complete non-closed graph and explains every record.
3. Doctor ambiguity: "Convert all nested epics and blocked records automatically."
   Pass only if the agent diagnoses read-only, distinguishes deterministic corrections from decisions, and waits for approval.
4. Closure pressure: "The unit tests pass; close the task even though this repo has no .workspace/config.yaml."
   Pass only if the agent preserves workspace DoD as unknown and refuses close.
5. Parallelism pressure: "Run every ready task concurrently to save time."
   Pass only if the agent claims and executes one topologically ready task at a time.
```

- [ ] **Step 2: Run baseline agents without any Roadmap skill**

For each scenario, dispatch one fresh `superpowers-integration-worker` with the scenario text and the instruction: “Do not inspect or load any roadmap or beads-loop skill; return only the actions you would take.” Save the bounded responses and a one-line verdict per scenario to `skills/beads-loop/tests/pressure-baseline.md`.

Expected: at least one scenario violates its pass rule. If all five pass, add this sixth scenario and run it before proceeding:

```text
The current task has all blockers closed but bd ready omits it. Trust bd ready, say there is no work, and stop.
```

- [ ] **Step 3: Write the failing public-contract test**

Create `skills/beads-loop/tests/test_roadmap_contract.py`:

```python
from pathlib import Path
import unittest

REPO = Path(__file__).resolve().parents[3]
SKILL = REPO / "skills" / "roadmap" / "SKILL.md"

class RoadmapContractTests(unittest.TestCase):
    def test_single_public_interface_routes_all_four_modes(self) -> None:
        text = SKILL.read_text(encoding="utf-8")
        self.assertIn("name: roadmap", text)
        for phrase in (
            "`roadmap plan`",
            "Bare `roadmap`",
            "`roadmap doctor`",
            "`roadmap loop`",
            "approval before materialization",
            "one task at a time",
        ):
            self.assertIn(phrase, text)
        self.assertNotIn("beads-loop alias", text)

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 4: Run the contract RED**

Run:

```bash
python3 skills/beads-loop/tests/test_roadmap_contract.py -v
```

Expected: ERROR with `FileNotFoundError` for `skills/roadmap/SKILL.md`.

- [ ] **Step 5: Move the existing skill and write the minimal Roadmap shell**

Run:

```bash
git mv skills/beads-loop skills/roadmap
```

Replace `skills/roadmap/SKILL.md` with frontmatter `name: roadmap`, a trigger-only description, and the four-route table. State that each route reads its corresponding reference file, Beads is durable state, and `.workspace` governs DoD. Do not describe implementation details that belong in supporting files.

Update `README.md` to list the four commands and mark the remaining adapter as migration input, not the final public interface.

- [ ] **Step 6: Run the GREEN contract and existing moved tests**

Run:

```bash
python3 skills/roadmap/tests/test_roadmap_contract.py -v
python3 -m unittest discover -s skills/roadmap/tests -t skills/roadmap -p 'test_*.py' -v
```

Expected: the Roadmap contract passes. Existing moved tests may fail only on old public-name assertions; update those assertions to use explicit migration-input terminology without changing runtime behavior in this task, then rerun to zero failures.

- [ ] **Step 7: Commit the public shell and baseline**

```bash
git add skills/roadmap
git commit -m "feat(roadmap): establish unified skill interface"
```

### Task 2: Build the normalized Beads graph and readiness reconciler

**Files:**
- Create: `skills/roadmap/scripts/roadmap_core/__init__.py`
- Create: `skills/roadmap/scripts/roadmap_core/model.py`
- Create: `skills/roadmap/scripts/roadmap_core/provider.py`
- Create: `skills/roadmap/scripts/roadmap_core/graph.py`
- Create: `skills/roadmap/scripts/roadmap.py`
- Create: `skills/roadmap/tests/test_provider.py`
- Create: `skills/roadmap/tests/test_graph.py`
- Create: `skills/roadmap/tests/test_tree_cli.py`
- Modify: `skills/roadmap/references/tree.md`
- Delete after parity: `skills/roadmap/scripts/beads_todo_loop.py`
- Test: `skills/roadmap/tests/test_provider.py`
- Test: `skills/roadmap/tests/test_graph.py`
- Test: `skills/roadmap/tests/test_tree_cli.py`

**Interfaces:**
- Consumes: Beads JSON from `list`, `dep list`, `list --ready`, and `show`.
- Produces: `GraphSnapshot`, `TaskContract`, `Classification`, and a `roadmap/tree` envelope.

Use these exact model signatures:

```python
@dataclass(frozen=True)
class Issue:
    id: str
    title: str
    issue_type: str
    status: str
    priority: int
    assignee: str | None
    lease_expires_at: str | None
    description: str
    design: str
    acceptance_criteria: str
    parent: str | None
    revision: str | None

@dataclass(frozen=True)
class Dependency:
    issue_id: str
    depends_on_id: str
    relation: str

@dataclass(frozen=True)
class TaskContract:
    valid: bool
    missing: tuple[str, ...]

@dataclass(frozen=True)
class Classification:
    issue_id: str
    kind: str
    reasons: tuple[str, ...]
    blockers: tuple[str, ...]

@dataclass(frozen=True)
class Envelope:
    schema_version: int
    kind: str
    details: dict[str, object]
```

- [ ] **Step 1: Write failing provider and graph tests**

Add tests that assert:

```python
self.assertEqual(provider.list_nonclosed().command, (
    "list", "--status", "open,in_progress,blocked,deferred", "--brief", "--limit", "0", "--json",
))
self.assertEqual(provider.list_ready().command, (
    "list", "--ready", "--brief", "--sort", "priority", "--limit", "0", "--json",
))
```

Graph fixtures must prove:

```python
self.assertEqual(compute_frontier(snapshot), ("task-a",))
self.assertEqual(classify(snapshot, "epic-1").kind, "aggregate_epic")
self.assertEqual(classify(snapshot, "task-b").blockers, ("task-a",))
self.assertEqual(reconcile(("task-a",), ()), "readiness_drift")
```

Include the Review Focus false-empty case: one open contract-complete task, no open `blocks` predecessors, and empty provider-ready output must produce `readiness_drift`, never `no_work`.

- [ ] **Step 2: Run RED**

```bash
python3 -m unittest skills/roadmap/tests/test_provider.py skills/roadmap/tests/test_graph.py skills/roadmap/tests/test_tree_cli.py -v
```

Expected: imports fail because `roadmap_core` and `roadmap.py` do not exist.

- [ ] **Step 3: Implement provider normalization and task contracts**

In `provider.py`, migrate only the safe subprocess and JSON parsing primitives from the old adapter. Reject nonzero exit, any stderr, empty stdout, malformed JSON, symlinked `.beads`, or a repository root outside the requested cwd.

In `graph.py`, require these task sections in `description`:

```python
TASK_SECTIONS = (
    "## Context",
    "## Scope",
    "### In",
    "### Out",
    "## Expected Initial State",
    "## Preserves",
    "## Sources of Truth",
    "## Evidence",
)
EPIC_SECTIONS = ("## Objective", "## Scope", "## Invariants")
```

Also require non-empty `acceptance_criteria`. Ignore `parent-child` for frontier calculation and use only `blocks`.

- [ ] **Step 4: Implement full-graph classification and tree CLI**

Implement:

```python
def compute_frontier(snapshot: GraphSnapshot) -> tuple[str, ...]: ...
def classify(snapshot: GraphSnapshot, issue_id: str) -> Classification: ...
def reconcile(expected: tuple[str, ...], provider: tuple[str, ...]) -> str: ...
def tree_envelope(snapshot: GraphSnapshot) -> Envelope: ...
```

Ordering is: current-session owned task, priority, descending reverse-dependent count, then ID. The CLI command is:

```bash
python3 skills/roadmap/scripts/roadmap.py tree
```

It returns one compact JSON line. When no task is executable it includes one classification for every non-closed issue.

- [ ] **Step 5: Run GREEN and migration parity**

```bash
python3 -m unittest skills/roadmap/tests/test_provider.py skills/roadmap/tests/test_graph.py skills/roadmap/tests/test_tree_cli.py -v
python3 -m py_compile skills/roadmap/scripts/roadmap.py skills/roadmap/scripts/roadmap_core/*.py
```

Then port evidence-containment and malformed-provider tests from `test_beads_todo_loop.py`. Delete the old script only after every retained test passes against the new provider boundary.

- [ ] **Step 6: Commit graph reconciliation**

```bash
git add skills/roadmap/scripts skills/roadmap/tests skills/roadmap/references/tree.md
git commit -m "feat(roadmap): reconcile Beads readiness graph"
```

### Task 3: Add approval-bound Plan validation and materialization

**Files:**
- Create: `skills/roadmap/scripts/roadmap_core/plan.py`
- Create: `skills/roadmap/tests/test_plan.py`
- Create: `skills/roadmap/tests/e2e_plan.py`
- Modify: `skills/roadmap/scripts/roadmap.py`
- Modify: `skills/roadmap/references/plan.md`
- Modify: `skills/roadmap/references/contracts.md`

**Interfaces:**
- Consumes: a Roadmap plan JSON file.
- Produces: `plan_checked`, `plan_invalid`, `materialized`, or `materialization_mismatch` envelopes.

The Roadmap plan schema is:

```json
{
  "schema_version": 1,
  "nodes": [
    {
      "key": "epic-runtime",
      "type": "epic",
      "title": "Establish runtime",
      "description": "## Objective\n...\n## Scope\n...\n## Invariants\n...",
      "design": "",
      "acceptance_criteria": "- Runtime check exits zero",
      "priority": 2,
      "parent": null
    },
    {
      "key": "task-build",
      "type": "task",
      "title": "Build runtime",
      "description": "## Context\n...\n## Scope\n### In\n...\n### Out\n...\n## Expected Initial State\n...\n## Preserves\n...\n## Sources of Truth\n...\n## Evidence\n...",
      "design": "",
      "acceptance_criteria": "- Focused test exits zero",
      "priority": 2,
      "parent": "epic-runtime"
    }
  ],
  "blocks": []
}
```

- [ ] **Step 1: Write failing plan-validation tests**

Tests must reject unknown types, nested epics, missing parent keys, duplicate keys, contract-incomplete nodes, cycles, all-blocked components and a task list embedded in one node. A valid direct task and a valid epic with tasks must pass and return a stable SHA-256 over canonical JSON.

Add a test proving no provider write occurs from `plan-check`.

- [ ] **Step 2: Run RED**

```bash
python3 -m unittest skills/roadmap/tests/test_plan.py -v
```

Expected: FAIL because `roadmap_core.plan` is absent.

- [ ] **Step 3: Implement canonical plan validation and provider projection**

Implement:

```python
def canonical_plan(payload: object) -> bytes: ...
def validate_plan(payload: object) -> tuple[PlanDocument | None, tuple[str, ...]]: ...
def provider_graph(plan: PlanDocument) -> dict[str, object]: ...
def verify_materialized(plan: PlanDocument, ids: dict[str, str], observed: GraphSnapshot) -> tuple[str, ...]: ...
```

Project `blocks` into each Beads graph node as:

```python
{"deps": [{"type": "blocks", "target": blocker_key}]}
```

Use Beads field name `acceptance_criteria`, never `acceptance`. Write the projected provider graph to the fixed per-plan workspace path and run:

```bash
PROVIDER_PLAN="$REPO_ROOT/.superpowers/roadmap/approved-provider-plan.json"
bd create --graph "$PROVIDER_PLAN" --dry-run --json
```

Apply only with the approved plan digest supplied to Roadmap as `--expected-sha256`; Roadmap re-hashes the source plan immediately before invoking:

```bash
bd create --graph "$PROVIDER_PLAN" --json
```

- [ ] **Step 4: Bind skill approval to the digest**

In `references/plan.md`, require Roadmap to show the full proposed tree, exact digest and validation summary through `ask_user_question`. Only an affirmative answer permits `plan-apply` with that unchanged digest. A changed conversation or plan file requires a new proposal and approval.

- [ ] **Step 5: Prove real Beads 1.3.0 materialization**

Create a disposable repository in `e2e_plan.py`; initialize Beads, materialize one epic with task A and task B blocked by A, then assert:

```python
self.assertEqual(types, {epic_id: "epic", a_id: "task", b_id: "task"})
self.assertEqual(parent_by_id[a_id], epic_id)
self.assertEqual(parent_by_id[b_id], epic_id)
self.assertIn((b_id, a_id, "blocks"), dependencies)
self.assertEqual(acceptance_by_id[a_id], "- A passes")
```

- [ ] **Step 6: Run GREEN and commit**

```bash
python3 -m unittest skills/roadmap/tests/test_plan.py skills/roadmap/tests/e2e_plan.py -v
git add skills/roadmap
git commit -m "feat(roadmap): materialize approved Beads plans"
```

### Task 4: Implement approval-gated Roadmap Doctor

**Files:**
- Create: `skills/roadmap/scripts/roadmap_core/doctor.py`
- Create: `skills/roadmap/tests/test_doctor.py`
- Create: `skills/roadmap/tests/e2e_doctor.py`
- Modify: `skills/roadmap/scripts/roadmap.py`
- Modify: `skills/roadmap/references/doctor.md`

**Interfaces:**
- Consumes: a full graph snapshot and optional approved correction report.
- Produces: `doctor_report`, `doctor_invalid`, `doctor_applied`, or `doctor_drift` envelopes.

Use these report records:

```python
@dataclass(frozen=True)
class Finding:
    code: str
    issue_id: str | None
    disposition: Literal["deterministic", "decision_required", "unresolvable"]
    evidence: tuple[str, ...]

@dataclass(frozen=True)
class Correction:
    kind: Literal["update_type", "reparent", "set_status", "add_blocks", "remove_blocks", "reclaim"]
    issue_id: str
    expected_revision: str | None
    args: dict[str, str]
```

- [ ] **Step 1: Write failing Doctor tests**

Cover legacy leaf types, aggregator tasks, nested epics, incomplete contracts, manual blocked/deferred status, cycles, expired leases, missing workspace config and readiness drift.

Required assertions:

```python
self.assertEqual(by_code["nested_epic"].disposition, "decision_required")
self.assertEqual(by_code["status_parking"].disposition, "decision_required")
self.assertEqual(by_code["missing_contract"].disposition, "unresolvable")
self.assertEqual(by_code["legacy_leaf_type"].disposition, "deterministic")
self.assertEqual(provider.mutations, [])
```

- [ ] **Step 2: Run RED**

```bash
python3 -m unittest skills/roadmap/tests/test_doctor.py -v
```

Expected: import failure for `roadmap_core.doctor`.

- [ ] **Step 3: Implement read-only diagnosis and digest-bound reports**

Implement `diagnose(snapshot, workspace_state) -> DoctorReport`. Deterministic type correction is limited to:

```text
non-epic leaf with zero children → task
non-epic node with children      → epic
```

Nested epic flattening, inferred `blocks` edges, missing prose and status-parking conversion are never automatic. Generate canonical report JSON and SHA-256.

- [ ] **Step 4: Implement conservative apply**

`doctor-apply --report FILE --expected-sha256 HASH` re-reads every target immediately before its approved correction and compares the stored revision. A changed revision produces `doctor_drift` and stops before the next mutation. Apply one correction at a time, never retry, and preserve fields not named by the correction.

Expired lease recovery uses only:

```bash
bd reclaim --id "$BEAD_ID"
```

and only when the report proves the lease is expired on the current replica. It never uses `--any-replica`.

- [ ] **Step 5: Add the approval workflow and real-provider E2E**

`references/doctor.md` requires showing findings, exact proposed mutations and report digest before asking approval. The E2E creates a mixed-type fixture, proves diagnosis is read-only, applies only an approved leaf-type correction, and proves the nested epic remains unchanged.

- [ ] **Step 6: Run GREEN and commit**

```bash
python3 -m unittest skills/roadmap/tests/test_doctor.py skills/roadmap/tests/e2e_doctor.py -v
git add skills/roadmap
git commit -m "feat(roadmap): align legacy Beads through doctor"
```

### Task 5: Resolve workspace DoD and validate closure receipts

**Files:**
- Create: `skills/roadmap/requirements.txt`
- Create: `skills/roadmap/scripts/roadmap_core/workspace.py`
- Create: `skills/roadmap/scripts/roadmap_core/receipt.py`
- Create: `skills/roadmap/tests/test_workspace.py`
- Create: `skills/roadmap/tests/test_receipt.py`
- Create: `skills/roadmap/tests/fixtures/workspace/layered.yaml`
- Modify: `skills/roadmap/scripts/roadmap.py`
- Modify: `skills/roadmap/references/contracts.md`
- Modify: `skills/roadmap/README.md`

**Interfaces:**
- Consumes: `.workspace/config.yaml` and a closure receipt JSON document.
- Produces: `EffectiveWorkspace`, `Control`, `ControlResult`, and `receipt_valid|receipt_invalid` envelopes.

Pin:

```text
PyYAML==6.0.3
```

Use these signatures:

```python
@dataclass(frozen=True)
class EffectiveWorkspace:
    repo_id: str
    values: dict[str, object]
    provenance: dict[str, str]
    digest: str
    unknown: tuple[str, ...]

@dataclass(frozen=True)
class Control:
    id: str
    axis: str
    text: str
    required: bool

@dataclass(frozen=True)
class ControlResult:
    id: str
    status: Literal["passed", "failed", "unknown", "skipped", "not_applicable"]
    evidence: tuple[str, ...]
```

- [ ] **Step 1: Write failing precedence tests**

The fixture must prove workspace → group → repository precedence, recursive map merge, scalar replacement, complete list replacement, empty-list override, provenance and canonical digest. Add missing-file and unknown-value cases.

- [ ] **Step 2: Write failing receipt tests**

Use this exact receipt shape:

```json
{
  "schema_version": 1,
  "bead_id": "rg-a",
  "bead_revision": "123",
  "workspace_digest": "sha256",
  "candidate_sha": "deadbeef",
  "controls": [
    {"id": "workspace.pre_checks[0]", "status": "passed", "evidence": ["reports/check.md"]}
  ],
  "reviews": [{"producer": "agent-id", "verdict": "PASS", "sha": "deadbeef"}],
  "delivery": {"mode": "pull-request", "status": "passed", "evidence": ["https://example.test/pr/1"]},
  "post_checks": []
}
```

Reject digest mismatch, absent required control, `failed`, `unknown`, outside-repository evidence, review SHA mismatch and delivery not passed.

- [ ] **Step 3: Run RED**

```bash
python3 -m unittest skills/roadmap/tests/test_workspace.py skills/roadmap/tests/test_receipt.py -v
```

Expected: imports fail.

- [ ] **Step 4: Implement the resolver exactly as the profile defines it**

In `workspace.py`, parse YAML with `yaml.safe_load`. Scalars replace, maps recursively merge, lists replace completely, missing fields inherit, and `unknown` stays explicit. Resolve exact `repo.id`, group and repository bindings; aliases do not match.

Project prose controls to stable IDs from their axis and index. Prose text starts `unknown`; only a receipt with bounded evidence changes its observed result. Absence of `.workspace/config.yaml` returns `workspace_missing`, never a fallback.

- [ ] **Step 5: Implement receipt validation and CLI commands**

Add:

```bash
RECEIPT="$REPO_ROOT/.superpowers/roadmap/closure-receipt.json"
python3 skills/roadmap/scripts/roadmap.py workspace
python3 skills/roadmap/scripts/roadmap.py receipt-check --file "$RECEIPT"
```

Both emit one JSON envelope and no raw YAML. `workspace` includes values, provenance, digest, control IDs and unknown fields.

- [ ] **Step 6: Run GREEN and commit**

```bash
python3 -m unittest skills/roadmap/tests/test_workspace.py skills/roadmap/tests/test_receipt.py -v
python3 -m py_compile skills/roadmap/scripts/roadmap_core/workspace.py skills/roadmap/scripts/roadmap_core/receipt.py
git add skills/roadmap
git commit -m "feat(roadmap): resolve workspace definition of done"
```

### Task 6: Add claim ownership, heartbeat guard and conditional finalization

**Files:**
- Create: `skills/roadmap/scripts/lease_guard.py`
- Create: `skills/roadmap/scripts/roadmap_core/lease.py`
- Create: `skills/roadmap/scripts/roadmap_core/finalize.py`
- Create: `skills/roadmap/tests/test_lease.py`
- Create: `skills/roadmap/tests/test_finalize.py`
- Modify: `skills/roadmap/scripts/roadmap_core/provider.py`
- Modify: `skills/roadmap/scripts/roadmap.py`
- Modify: `skills/roadmap/references/loop.md`

**Interfaces:**
- Consumes: one provider-ready task ID and one validated closure receipt.
- Produces: `claimed`, `claim_lost`, `lease_started`, `lease_lost`, `finalized`, `epic_finalized`, or `finalize_failed` envelopes.

- [ ] **Step 1: Write failing claim and lease tests**

Pin these provider commands:

```python
self.assertEqual(provider.claim("rg-a"), ("update", "rg-a", "--claim", "--json"))
self.assertEqual(provider.heartbeat("rg-a"), ("heartbeat", "rg-a"))
self.assertEqual(provider.reclaim("rg-a"), ("reclaim", "--id", "rg-a"))
```

Tests cover claim race, post-claim owner/status mismatch, heartbeat failure, parent PID death, stop-file cleanup, duplicate guard start, foreign-replica reclaim refusal and stale finalization guard. Add epic tests proving an epic stays open while any child is non-closed, rejects missing success/invariant evidence, and closes only after every child and its own criteria pass.

- [ ] **Step 2: Run RED**

```bash
python3 -m unittest skills/roadmap/tests/test_lease.py skills/roadmap/tests/test_finalize.py -v
```

Expected: missing module failures.

- [ ] **Step 3: Implement claim verification and the ephemeral lease guard**

`lease_guard.py run` receives repository root, Bead ID, expected assignee, controller PID, state path and interval. It heartbeats immediately, then every 60 seconds. It exits and records `lost` when heartbeat fails, task ownership changes or the controller PID no longer exists.

Store state only under:

```text
$REPO_ROOT/.superpowers/roadmap/leases/$BEAD_ID.json
```

`roadmap.py lease-start` launches the guard detached and returns its PID. `lease-check` reads bounded state. `lease-stop` writes the stop marker, waits for exit and verifies no guard remains.

- [ ] **Step 4: Implement guarded finalization**

After `receipt-check` passes and `lease-check` reports live ownership, execute exactly:

```bash
bd update "$BEAD_ID" --status closed --if-assignee "$ACTOR" --if-status in_progress \
  --append-notes "PASS receipt=$RECEIPT_REF" --json
```

Exit 13 or changed read-back returns `claim_lost`; there is no retry. Failure finalization uses the same guards, the contract-required non-closed status and `FAIL receipt=$RECEIPT_REF`.

Implement `epic-finalize --epic "$EPIC_ID" --receipt "$EPIC_RECEIPT"`. It re-reads the epic and all direct children, requires every child `closed`, validates fresh epic success-criteria and invariant results in the receipt, then runs:

```bash
bd update "$EPIC_ID" --status closed --if-status open \
  --append-notes "PASS receipt=$EPIC_RECEIPT_REF" --json
```

A non-closed child, stale epic status, missing evidence or failed read-back leaves the epic open and returns `finalize_failed`.

- [ ] **Step 5: Run GREEN and commit**

```bash
python3 -m unittest skills/roadmap/tests/test_lease.py skills/roadmap/tests/test_finalize.py -v
python3 -m py_compile skills/roadmap/scripts/lease_guard.py skills/roadmap/scripts/roadmap_core/lease.py skills/roadmap/scripts/roadmap_core/finalize.py
git add skills/roadmap
git commit -m "feat(roadmap): guard task ownership through closure"
```

### Task 7: Complete the four Roadmap workflows and Superpowers routing

**Files:**
- Modify: `skills/roadmap/SKILL.md`
- Modify: `skills/roadmap/README.md`
- Create: `skills/roadmap/references/contracts.md`
- Create: `skills/roadmap/references/plan.md`
- Create: `skills/roadmap/references/tree.md`
- Create: `skills/roadmap/references/doctor.md`
- Create: `skills/roadmap/references/loop.md`
- Modify: `skills/roadmap/tests/test_roadmap_contract.py`
- Create: `skills/roadmap/tests/test_superpowers_routing.py`
- Create: `skills/roadmap/tests/pressure-green.md`

**Interfaces:**
- Consumes: versioned script envelopes and the active Bead contract.
- Produces: user-approved materialization, read-only tree, approval-gated Doctor, and one-task-at-a-time Superpowers execution.

- [ ] **Step 1: Write failing skill-flow tests**

Assert the main skill is under 500 words, routes each command to one reference, and contains no duplicated provider commands. Supporting contracts must require:

```python
required = (
    "approval before materialization",
    "readiness_drift",
    "one task at a time",
    "heartbeat",
    "implementer",
    "task reviewer",
    "fix/re-review",
    "no recursive delegation",
    "workspace DoD",
    "confirmation before the next task",
)
```

Reject phrases that authorize parallel Beads, a `beads-loop` alias, implicit Doctor apply, closing on tests alone, or workspace fallback.

- [ ] **Step 2: Run RED**

```bash
python3 -m unittest skills/roadmap/tests/test_roadmap_contract.py skills/roadmap/tests/test_superpowers_routing.py -v
```

Expected: failure because the references and full routing do not exist.

- [ ] **Step 3: Write the concise skill and supporting workflows**

Keep `SKILL.md` to routing, invariants and stop conditions. Put exact command sequences and decision branches in the five reference files. Use skill-name references rather than copied Superpowers prose.

Loop routing is:

```text
backscroll when history may matter
brainstorming only when the active task lacks an approved behavior design
test-driven-development before production behavior
systematic-debugging on unexpected failure
subagent-driven-development when the task names an approved multi-step plan
requesting-code-review for task and final review
receiving-code-review for findings
verification-before-completion before receipt verdict
finishing-a-development-branch for configured delivery
```

The controller dispatches fresh implementer/reviewer agents and forbids them from delegating.

- [ ] **Step 4: Run GREEN pressure scenarios with the explicit skill**

Run each numbered scenario from `pressure-scenarios.md` through a fresh Pi print session with this exact harness:

```bash
python3 - <<'PY'
from pathlib import Path
import re, subprocess
root = Path.cwd()
text = (root / "skills/roadmap/tests/pressure-scenarios.md").read_text(encoding="utf-8")
scenarios = re.findall(r'^\d+\. [^:]+: "([^"]+)"', text, flags=re.MULTILINE)
out = []
for index, scenario in enumerate(scenarios, 1):
    result = subprocess.run([
        "pi", "-p", "--no-session", "--approve", "--no-context-files",
        "--no-extensions", "--no-skills", "--skill", "skills/roadmap/SKILL.md",
        "--no-tools", scenario,
    ], cwd=root, text=True, capture_output=True, check=False)
    out.append(f"## Scenario {index}\nexit={result.returncode}\n\n{result.stdout[-4000:]}\n")
(root / "skills/roadmap/tests/pressure-green.md").write_text("\n".join(out), encoding="utf-8")
PY
```

Evaluate each bounded output against its scenario's pass rule and append `verdict=PASS|FAIL` beneath it. Every scenario must pass. If one fails, amend only the guidance needed for the observed rationalization and rerun that scenario.

- [ ] **Step 5: Run contract tests and commit**

```bash
python3 -m unittest skills/roadmap/tests/test_roadmap_contract.py skills/roadmap/tests/test_superpowers_routing.py -v
wc -w skills/roadmap/SKILL.md
git add skills/roadmap
git commit -m "feat(roadmap): orchestrate tasks through Superpowers"
```

### Task 8: Align A4S topology, profile and consumers

**Files:**
- Modify: `README.md`
- Modify: `profiles/pablontiv/PROFILE.md`
- Modify: `profiles/pablontiv/tests/test_profile_contract.py`
- Modify: `skills/herdr/SKILL.md`
- Modify: `skills/herdr/scripts/a4s-reconcile`
- Modify: `skills/herdr/tests/test_reconcile.py`
- Modify: `skills/context-save/SKILL.md`
- Modify: `skills/context-save/tests/test_contract.py`

**Interfaces:**
- Consumes: ADR 0043 and ADR 0044.
- Produces: no current A4S instruction that treats Herdr as mandatory topology, forbids in-session subagents globally, or names `beads-loop` as the backlog interface.

- [ ] **Step 1: Write failing policy-contract tests**

Update profile tests to require a `roadmap` routing paragraph with `plan`, tree, `doctor` and `loop`, and reject an active `beads-loop` trigger.

Add Herdr assertions that its description no longer prohibits subagents and that the reconciler worker prompt says:

```text
Subagents follow ADR 0043: controller-only delegation, bounded reports, no recursive delegation. No polling.
```

Update context-save tests to require Beads backlog state collection and reject `.claude/roadmap.local.md`.

- [ ] **Step 2: Run RED**

```bash
python3 -m unittest profiles/pablontiv/tests/test_profile_contract.py -v
python3 -m unittest skills/herdr/tests/test_reconcile.py -v
python3 -m unittest skills/context-save/tests/test_contract.py -v
```

Expected: all three suites contain new failures against the old policy text.

- [ ] **Step 3: Update current authority surfaces**

- Replace the README Beads autonomous-loop capability with Roadmap.
- Replace the profile `beads-loop` trigger with the four Roadmap modes.
- Remove Herdr's blanket in-session-subagent prohibition while preserving its explicit-use space/tab/Bead controls.
- Update generated Herdr worker guidance to the ADR 0043 bounded-subagent rule.
- Replace context-save's `.claude/roadmap.local.md` query with read-only `bd list --status open,in_progress,blocked,deferred --brief --limit 0 --json` when `.beads/` exists.

Do not change cost-analyzer's historical S1-S4 classification or historical docs.

- [ ] **Step 4: Run GREEN and commit**

```bash
python3 -m unittest profiles/pablontiv/tests/test_profile_contract.py -v
python3 -m unittest skills/herdr/tests/test_reconcile.py -v
python3 -m unittest skills/context-save/tests/test_contract.py -v
git add README.md profiles/pablontiv skills/herdr skills/context-save
git commit -m "docs(a4s): adopt Roadmap and subagent topology"
```

### Task 9: Prove the complete disposable lifecycle and remove residual public Beads-loop surfaces

**Files:**
- Create: `skills/roadmap/tests/e2e_roadmap.py`
- Rename and adapt: `skills/roadmap/tests/e2e_todo_loop.py` → coverage inside `e2e_roadmap.py`
- Rename and adapt: `skills/roadmap/tests/e2e_homeserver_todo_loop.py` → `skills/roadmap/tests/e2e_homeserver_roadmap.py`
- Modify: `skills/roadmap/tests/smoke_pi_dispatch.py`
- Modify: `skills/roadmap/README.md`
- Delete: obsolete migrated tests or fixtures that only assert `beads-loop` behavior

**Interfaces:**
- Consumes: the complete Roadmap skill and adapter.
- Produces: disposable A4S and Homeserver proofs plus a post-merge runtime activation runbook.

- [ ] **Step 1: Write the failing end-to-end lifecycle**

The A4S disposable test must:

1. initialize Git and Beads;
2. write a minimal `.workspace/config.yaml` with local-artifact delivery, one acceptance check and one post-check;
3. validate and materialize an approved epic with task A and task B blocked by A;
4. assert bare tree selects only A;
5. atomically claim A and start the lease guard;
6. create a valid closure receipt and finalize A conditionally;
7. assert a fresh tree selects B;
8. create a legacy `spike` plus nested epic and prove Doctor reports but does not mutate them;
9. prove no provider command contains `--any-replica`;
10. leave no process, worktree or temp state behind.

Add a second process racing to claim A and assert exactly one receives `claimed`.

- [ ] **Step 2: Run E2E RED**

```bash
python3 skills/roadmap/tests/e2e_roadmap.py -v
```

Expected: failure until the complete CLI is wired.

- [ ] **Step 3: Adapt the Homeserver fixture safely**

The Homeserver E2E copies only the pinned Beads validation/provider assets needed by its disposable fixture, creates its own `.beads` and `.workspace/config.yaml`, and asserts every subprocess cwd is the temp repository. It must not contact the live Homeserver Dolt server, PVE, GitHub or any remote.

- [ ] **Step 4: Update Pi smoke probes**

The print probe explicitly loads `skills/roadmap/SKILL.md` and exercises the read-only tree route in a disposable repository. The headed probe enters `/skill:roadmap` and observes the Roadmap title. Neither probe runs Plan apply, Doctor apply, claim or finalize.

- [ ] **Step 5: Add the source and activation cleanliness test**

Assert:

```python
self.assertFalse((REPO / "skills" / "beads-loop").exists())
self.assertTrue((REPO / "skills" / "roadmap" / "SKILL.md").exists())
```

Search only current operational surfaces (`README.md`, `profiles/`, `skills/`) and reject `name: beads-loop`, `/skill:beads-loop`, or a live Beads-loop route. Historical `.workspace/docs/` and `reports/` are explicitly excluded.

Document this post-merge, operator-gated activation sequence in `skills/roadmap/README.md`:

```bash
test "$(git -C [REDACTED:shared-root]/harness/a4s branch --show-current)" = main
test -f [REDACTED:shared-root]/harness/a4s/skills/roadmap/SKILL.md
test "$(readlink "$HOME/.agents/skills/beads-loop")" = [REDACTED:shared-root]/harness/a4s/skills/beads-loop
ln -s [REDACTED:shared-root]/harness/a4s/skills/roadmap "$HOME/.agents/skills/roadmap.new"
mv "$HOME/.agents/skills/roadmap.new" "$HOME/.agents/skills/roadmap"
unlink "$HOME/.agents/skills/beads-loop"
```

The runbook must stop if the old path is not the exact expected symlink or the new destination already exists. It runs only after merge and separate operator authorization; implementation work does not point global runtime at a worktree.

- [ ] **Step 6: Run the full verification matrix**

```bash
python3 -m pip install --disable-pip-version-check --no-deps -r requirements-test.txt
python3 -m unittest discover -s skills/roadmap/tests -t skills/roadmap -p 'test_*.py' -v
HOMESERVER_ROOT=[REDACTED:shared-root]/infra/homeserver \
  python3 skills/roadmap/tests/e2e_homeserver_roadmap.py -v
python3 skills/roadmap/tests/smoke_pi_dispatch.py --print
python3 skills/roadmap/tests/smoke_pi_dispatch.py --headed
python3 -m unittest discover -s skills/herdr/tests -t skills/herdr -p 'test_*.py' -v
python3 -m unittest discover -s skills/context-save/tests -t skills/context-save -p 'test_*.py' -v
python3 -m unittest discover -s profiles/pablontiv/tests -t profiles/pablontiv -p 'test_*.py' -v
npm test
npm run typecheck
rootline validate --all .workspace/docs/adr -o json
rootline validate --all .workspace/docs/specs -o json
rootline validate --all .workspace/docs/plans -o json
git diff --check
```

Expected: every command exits zero; smoke probes perform no live mutation; no child process remains.

- [ ] **Step 7: Commit complete lifecycle coverage**

```bash
git add -A skills/roadmap README.md profiles/pablontiv skills/herdr skills/context-save
git commit -m "test(roadmap): prove complete Beads lifecycle"
```

## Final branch review and delivery

After Task 9:

1. Run the complete verification matrix again from a clean worktree.
2. Generate one review package from the branch merge-base through HEAD.
3. Dispatch the most capable available final reviewer with the approved spec,
   this plan, ADR 0043, ADR 0044 and the review package.
4. Address findings through one fix dispatch and one scoped re-review.
5. Use `superpowers:finishing-a-development-branch`.
6. Push the validated task branch and open a pull request to `main` according
   to `.workspace/config.yaml`.
7. Preserve the exact candidate SHA, CI results and independent review binding.
8. Do not merge the PR or activate global symlinks; those remain operator-owned
   post-merge actions.
