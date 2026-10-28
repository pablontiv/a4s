# Harness² vs issue-lifecycle loops (#692)

**Decision: descartar.**

The hypothesis was that Harness² improves the existing issue-lifecycle loops.
The published system optimizes a frozen model's surrounding files on professional
benchmarks. These loops already correct a candidate from a ground-truth gate
and from required CI, and they turn a process incident into reviewed work after
an operator selects it.

## Evidence

The source post (https://x.com/akshay_pachaar/status/2111753928031531232) points
at [google-research/harness2](https://github.com/google-research/harness2). It
describes Propose–Probe–Compose: edit the harness, run a few candidate
versions, and compose one from how those runs behaved, with no grader for the
task. The repository README and
[arXiv:2610.14224](https://arxiv.org/abs/2610.14224) state the same two levels.
Task-level recursion proposes edits, probes them on the same task, and composes
a harness from behavioral contrasts, without ground-truth feedback.
Harnessing-level recursion then stores the adopted harness and
evidence-supported lessons for the next task. The eight editable components are
the system prompt, guardrails, memory, tool guidance, subagents, skills,
scripts, and plugins. Executors are OpenCode and Codex (`--substrate cx`).
Reported gains are on JobBench, LAB, and WorkBuddy-Bench. Install is Linux,
Python 3.12, and uv; `harness2-demo` is the local no-credential demo.
Model-backed benchmarks use a configured provider. The README states that
executor network access is unrestricted and that Codex runs with its sandbox
disabled.

| Harness² claim | Loop already in this repository |
| --- | --- |
| Contrastive harness edit for the current task, without a verifier | `feature.yaml` `gate` runs the adopted `GATE` command. A code failure pushes back to `implement`. `await_ci` classifies `CODE_FAIL` and pushes back to `implement` with `ci-return.json`; the corrected head needs fresh gate evidence (`skills/issue-execution/SKILL.md`). |
| Persistent library of adopted harnesses and lessons | `sprint-retrospective` records incidents; the operator chooses which ones enter `refine`. `planning.yaml` runs `import_units`, `review`, `approve`, then `materialize`. |
| Eight runtime component files, including skills and guardrails | Skills and DAG templates are versioned under `packages/issue-lifecycle/skills/`. Admission materializes a run from the installed template and `.workspace/dagu/config.json`, and writes an immutable receipt. |
| Parallel or sequential candidate harnesses (`--k`, `--mode`) | One candidate SHA per iteration. `dagu-role-jobs stage triage` and `stage implement` bind a receipt to that SHA. Queue capacity runs unrelated lifecycle steps beside one another. |
| A `quality_admit` checkpoint comparable to Compose | Changelog 0.3.115 documents `quality_admit`. Changelog 0.3.118 removes the mandatory QA/reviewer checkpoint. Current `feature.yaml`, `poc.yaml`, `planning.yaml`, and `reconcile.yaml` contain no `quality_admit` step. The replacement is the local gate plus optional operator `validation`. |

The radar note names pinata, poness, and orca-dispatch-kit. This repository
does not contain those trees, and those names are not the Harness² package.
They stay documentary.

## Why there is no skill

A skill that ran Propose–Probe–Compose would install the Harness² package
(Python 3.12, uv, OpenCode or Codex) or would rewrite prompts, skills, and
guardrails from an ungraded behavioral contrast. The package is the product
this spike was asked to compare. The rewrite would store configuration from a
probe the paper uses where a correctness check is absent. Admission, the gate,
and the retrospective already perform the correction and the lesson, with a
verifier or an operator selection on each path.

## Dogfood

Station admission is blocked by the Dagu pin hold. This CloudAgent change is
the decision record only. It leaves the Dagu pin, `answers.json`, station
install, and #685 unchanged. Harness² was not installed, and no feature, PoC,
planning, or reconcile run was admitted for it.
