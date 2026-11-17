# Glossary

Terms are scoped to their subsystem; the same word does not imply the same object across packages. Linked contracts remain authoritative. The operator is the person directing the work.

| Term | Meaning and scope |
|---|---|
| **Candidate** | In [agent review](../agents/common/AGENTS.md), the implementation result being reviewed. In [refine](../skills/refine/SKILL.md#relate-or-separate), a need or group of related needs selected for investigation. |
| **Candidate (Context Expert)** | In [core compaction](../packages/context-expert/core/types.ts), an unpinned tool call eligible for keep/drop classification. In [Pi retrieval](../packages/context-expert/adapters/pi/README.md#runtime-contract), a shortlisted corpus chunk. In rule extraction/review, a possible rule observation or a synthesized rule proposal—not an accepted, active rule. |
| **Candidate (CI)** | `candidate` in the [template parameter examples](../packages/omp-dagu/skills/dagu-feature/SKILL.md#template-parameters) is another repository's required-check name, not an a4s lifecycle object; a4s uses `validate`. |
| **Bootstrap** | [Dagu adoption](../packages/omp-dagu/skills/dagu-feature/SKILL.md#1-bootstrap) configures/stamps the lifecycle DAGs. [Refine bootstrap](../skills/refine/SKILL.md#first-use-bootstrap) only configures the ticket destination. |
| **Coordinator** | The [top-level OMP session](../packages/omp-dagu/README.md#roles) that enqueues issues and completes Dagu human tasks, delegating leaf work. Not Dagu's `coordinator:` service or Pi's Orchestrator. |
| **Supervisor / researcher** | [Top-level OMP roles](../packages/omp-dagu/README.md#roles), not spawnable worker agents. The supervisor operates PRIMARY and the station and launches approved work; the researcher investigates read-only and hands findings to the supervisor after the operator's instruction. |
| **Station** | The [Dagu service installation](../packages/omp-dagu/README.md#estación-aislada-de-14-pasos), with its service/CLI home and HTTP endpoint; not an OMP session or an issue worktree. |
| **PRIMARY** | The repository clone's main working tree, clean and on `BASE_BRANCH`, from which the [lifecycle is enqueued](../packages/omp-dagu/skills/dagu-feature/SKILL.md#enqueue-an-issue). It is not the issue's linked worktree. |
| **Worktree** | The separate Git checkout used for implementation or a PoC. The [feature lifecycle](../packages/omp-dagu/skills/dagu-feature/SKILL.md#template-parameters) creates it under `$PRIMARY/.workspace/worktrees/issue-<n>`. |
| **Run** | A durable [Dagu execution](../packages/omp-dagu/skills/dagu-feature/SKILL.md#enqueue-an-issue), identified within a DAG by its run ID. Not an OMP session: one session can coordinate multiple runs; PoC promotion creates a fresh feature run. |
| **Gate** | The local validation command (`GATE`), executed by Dagu's [`gate` step](../packages/omp-dagu/skills/dagu-feature/SKILL.md#implement). Policy [initial/final gates](../agents/common/agents2.md) are readiness/delivery conditions, not that command; `start_gate` and `close_gate` are separate lifecycle checks. |
| **Triage / implement** | Dagu human-task checkpoints, not agent types. [Triage](../packages/omp-dagu/skills/dagu-feature/SKILL.md#triage) decides feasibility/PoC needs; [implement](../packages/omp-dagu/skills/dagu-feature/SKILL.md#implement) waits for the issue worktree's implementation result. |
| **PoC** | Proof of concept: a [real-target feasibility experiment](../packages/omp-dagu/skills/dagu-feature/SKILL.md#feasibility-poc) for unexercised behavior that could change implementation. Bug reproduction is defect investigation, not automatically a PoC. |
| **Evidence** | Capitalized, the [Pi Context Expert pipeline](../packages/context-expert/adapters/pi/README.md#runtime-contract) that selects corpus material and extracts rule signals after compaction. Lowercase evidence elsewhere means supporting observations, not this pipeline. |
| **Receipt** | In [Pi Context Expert](../packages/context-expert/adapters/pi/README.md#runtime-contract), a persisted marker for publication, processing, acceptance or operational failure; its schema identifies which. In [delivery policy](../agents/common/agents2.md#gate-final-para-trabajo-mutating), a durable record of completed work. Neither alone activates a rule. |
| **Rootline** | A referenced destination for durable rules; [Pi's current rule-review path](../packages/context-expert/adapters/pi/README.md#runtime-contract) stores proposals and acceptance receipts but does not write Rootline documents or activate rules. |

## Decision codes

| Code | Name and current meaning |
|---|---|
| **R28** | [Headless reviewer-binding authorization](../packages/omp-dagu/README.md#headless-triage-pre-pilot-920). The operator must decide whether run/generation binding, a first-prompt marker and a fresh private reviewer transcript suffice for the isolated pilot. They do not authenticate native task/agent parentage or the final reviewer yield. Pilot authorization is a separate requirement. |
| **ADR 0020** | [Durable application of accepted rules](../packages/context-expert/adapters/pi/README.md#runtime-contract): the surviving reference says application is deferred; current acceptance remains store-only. |
| **ADR 0049** | [Superpowers Claude Code adapter activation](../agents/README.md#installation-and-activation): the surviving installation contract describes reversible, fail-closed agent symlinks. |
| **ADR 0066** | [Synagent messaging architecture](../packages/synagent/core/README.md): cited for the Channel Adapter + Message Bus pattern. |
| **ADR 0068** | [Synagent v2 addressing](../packages/synagent/core/README.md#direccionamiento-v2-adr-0068-identidad-por-adr-0069): versioned direct/project/global addresses. |
| **ADR 0069** | [Synagent identity](../packages/synagent/core/README.md#identidad-desde-origin): the current contract derives the project token from Git origin. |

The cited ADR records are absent from this checkout. Their full contents are **UNVERIFIED**; the index describes only their surviving references and links to current documentation, not reconstructed decisions.
