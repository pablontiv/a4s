# Agent operating model

**Version:** 1.0

**Status:** conceptual reference and manual baseline

## Purpose and artifact boundary

This reference defines a portable operating model in which a user-facing Orchestrator delegates all domain work to leaf Workers. Its objective is to keep the user-facing agent responsive, make responsibility explicit, bound delegated context, and provide enough evidence for the Orchestrator to accept or reject returned work.

This document records the complete conceptual intent. It is not itself a runtime prompt and is not installed into a model context. Distributable runtime files are derived artifacts that express the model in forms understood by a particular runtime. In the version 1.0 baseline, `agents/common/AGENTS.md` is the manually derived Orchestrator instruction file, `agents/pi/*.md` are manually derived Pi Worker definitions, and `agents/claude/*.md` are manually derived Claude Code custom-subagent definitions. They are candidates for an experiment, not proof that either runtime enforces the model.

## Terminology

- **Agent:** a model instance with its own context, instructions, and capabilities.
- **Subagent:** an Agent invoked by another Agent. The term describes a parent-child relationship, not authority or specialization.
- **Orchestrator:** the user-facing Agent that owns the conversation and performs orchestration.
- **Worker:** a delegated Agent that executes one bounded work unit.
- **Structural role:** an Agent's position and authority. The structural roles are Orchestrator and Worker.
- **Worker specialization:** the kind of work assigned to a Worker. A specialization does not add authority.
- **Work unit:** a bounded assignment one Worker can execute and return.
- **Dispatch:** the act and contract by which the Orchestrator assigns a work unit.
- **Artifact:** a concrete output such as findings, source changes, a document, test evidence, or a review.

Every Worker in this model is a direct Subagent of the Orchestrator, and every Subagent dispatched by the Orchestrator acts as a Worker. Workers are peers and leaves. They do not create children, delegate, or invoke subagent tools. The model has no additional authority level.

## Structural roles

### Orchestrator

The Orchestrator:

- communicates with the user and requests clarification when required;
- decomposes requests into bounded work units;
- selects a Worker specialization and model for each unit;
- supplies the relevant context, constraints, acceptance criteria, and expected evidence;
- dispatches, steers, and cancels Workers;
- tracks dependencies and coordinates concurrent or sequential work;
- accepts, compares, rejects, and adjudicates returned work;
- requests corrections or additional work through another dispatch; and
- reports progress and accepted results to the user.

The Orchestrator performs orchestration only. Investigation, design, review, implementation, debugging, verification, testing, inspection, and production of domain artifacts are domain actions and must be delegated. There is no exception for work that appears short, simple, cohesive, or likely to require only one tool call. Dispatch is per work unit, not per domain tool call.

### Worker

A Worker executes one bounded work unit. It performs the domain reasoning, uses only the tools available to it, remains within the dispatch boundaries, validates when required, and reports the result and its limitations. It does not communicate with sibling Workers or assume responsibility for integration beyond its assigned unit.

## Worker specializations

Use the specialization that clearly matches the unit. Specialization affects routing and procedures, not structural authority.

- **Explorer:** investigates without modifying artifacts. It returns findings, evidence, sources, uncertainty, and gaps.
- **Implementer:** creates or modifies artifacts within assigned scope and returns changes plus validation. Mechanical and integration work are profiles of this specialization.
- **Reviewer:** evaluates supplied artifacts against supplied criteria without modifying them. It returns prioritized substantive findings, evidence, and a verdict. Task, architecture, and final review are profiles of this specialization.
- **Debugger:** reproduces a problem and establishes root cause. It modifies artifacts only when the dispatch explicitly authorizes a fix, then validates against the original symptom.
- **Generalist:** executes a bounded residual unit for which no other specialization is a clear fit. It remains a Worker and is not a smaller Orchestrator.

Residual domain work always goes to the Generalist. The Orchestrator does not absorb unmatched work.

## Dispatch contract

Each dispatch states:

1. the objective;
2. scope and explicit boundaries;
3. only the context relevant to the unit;
4. the expected result or artifact;
5. acceptance criteria;
6. constraints, including mutation and delivery limits; and
7. required evidence or validation.

The dispatch carries the work-unit requirements rather than an unfiltered conversation transcript. Dependencies on other units must be explicit.

## Worker return contract

Every Worker returns this common envelope:

```text
status: completed | partial | blocked | input_required
summary
result_or_artifacts
evidence_or_validation
risks_or_uncertainty
```

`partial` means useful in-scope work is complete but the unit is not complete. The Worker identifies completed work, remaining work, and the reason or next required action.

`input_required` means user-supplied information, clarification, a decision, or approval would allow the unit to continue. The Worker also returns:

```text
question
relevant_context
```

`blocked` is reserved for an obstacle that user input would not directly resolve. A runtime adapter may map field presentation, but it must preserve these meanings.

## Acceptance and adjudication boundary

The Orchestrator evaluates a return against the dispatch contract using the Worker's reported result, evidence, validation, risks, and uncertainty. It may accept or reject the result, compare alternatives, resolve declared cross-unit dependencies, or issue a corrective dispatch.

Adjudication is not independent domain analysis or verification. If acceptance requires substantive investigation, review, modification, reproduction, or testing, the Orchestrator dispatches another work unit. It must not fill an evidence gap by doing the domain work itself.

For `input_required`, the Orchestrator presents the Worker's question and relevant context to the user. After receiving the answer, it continues orchestration or redispatches the affected unit. It does not invent the missing decision.

## Multi-worker execution

The Orchestrator may run multiple Workers concurrently when units are independent, when separate perspectives can evaluate the same immutable input, or when results can be adjudicated without conflicting mutations. It sequences work when one unit depends on another.

Concurrent Workers must not modify the same artifact. Intentionally separate alternative implementations must use isolated artifacts or workspaces, followed by a distinct integration and validation unit. Workers do not coordinate directly; all dependency management and adjudication passes through the Orchestrator.

An `input_required` result pauses only its affected unit. Independent units may continue. Concurrency among tool calls inside one Worker is outside this model.

## Execution mode

Dispatch Workers in background by default so the user-facing conversation remains available. After starting background work, the Orchestrator reports that it is running and returns control rather than polling solely to await completion. Foreground execution is used when the user requests it. Explicit user instructions about foreground, background, sequence, or concurrency take precedence.

## Model selection

Structural role, specialization, and model choice are independent. Select the least expensive model that can reliably satisfy the dispatch. Use a more capable model for broad context, integration across boundaries, high uncertainty, or substantial technical judgment. Model choice does not change Worker authority or relax the contracts.

## Exact-output work

Exact-output requirements must be explicit in the dispatch, including the byte range or artifact to compare, encoding, newline policy, and allowed wrappers. Normally the common return envelope transports a path or delimited result while exact bytes live in the specified artifact. If a consumer requires the entire Worker final response to be byte-exact, that requirement conflicts with an additional return envelope unless the runtime provides a separate metadata channel. The dispatch or runtime adapter must resolve that conflict explicitly; a Worker must not silently omit contract fields or add prose to exact output.

In Pi, delivery is the Worker's final response returned directly by `subagent_run`. The definition must not rely on a delivery primitive from another runtime.

## Portability and runtime adapters

The concepts and semantic contracts are framework-portable. Tool names, frontmatter, discovery paths, delivery mechanisms, background controls, and model identifiers are runtime concerns.

A runtime adapter may:

- map conceptual capabilities to runtime tool names;
- encode routing metadata and model selection in supported syntax;
- place the Orchestrator and Worker prompts on runtime discovery surfaces; and
- map the runtime's return mechanism to the common return semantics.

An adapter must not merge structural roles, let Workers delegate, add a short-task exception, or weaken status and acceptance semantics. Runtime support must be verified rather than inferred from a file's presence. The baseline includes manual Pi and Claude Code Worker adapters.

## Distribution and installation

Versioned repository files are the source for distribution. Installation is symlink-based so a runtime consumes those files without creating divergent copies. Installation must be explicit, reversible, and fail closed if a destination already exists or a target cannot be verified.

For the Pi baseline, the intended global projections are:

```text
$PI_CODING_AGENT_DIR/AGENTS.md
  -> <checkout>/agents/common/AGENTS.md

$PI_CODING_AGENT_DIR/agents/{explorer,implementer,reviewer,debugger,generalist}.md
  -> <checkout>/agents/pi/{explorer,implementer,reviewer,debugger,generalist}.md
```

When `PI_CODING_AGENT_DIR` is unset, Pi's default root is `~/.pi/agent`.

For the Claude Code baseline, the intended global Worker projections are:

```text
~/.claude/agents/{explorer,implementer,reviewer,debugger,generalist}.md
  -> <checkout>/agents/claude/{explorer,implementer,reviewer,debugger,generalist}.md
```

Installation or activation is not performed by this experiment. Existing runtime files must not be overwritten.

## Source management and deferred enforcement

Version 1.0 is intentionally prose-first and manually derived. This versioned reference is intended to remain the single semantic source from which distributable runtime files are eventually generated and checked. The current manually derived files can drift because this baseline creates no generator, templates, schema, or generation pipeline.

Deterministic and runtime enforcement are deferred. This includes automated semantic equivalence checks, generated adapters, dispatch-schema validation, tool-policy enforcement, leaf-topology enforcement, status parsing, exact-output enforcement, installation automation, and live conformance tests. Prompt statements are behavioral instructions, not proof of runtime enforcement.

A4S `.workspace/config.yaml` is unrelated project-local policy. It remains the authority for A4S's own way of working and is not changed, replaced, extended, or governed by this global Agent operating model.

## Non-goals

Version 1.0 does not:

- implement a new agent runtime or modify `pi-subagents-j0k3r`;
- install or activate global runtime files;
- create adapters for runtimes other than Pi and Claude Code;
- create a generator, template system, or canonical machine-readable schema;
- enforce tool permissions or topology deterministically;
- define project-specific development, security, delivery, or approval policy;
- allow Workers to coordinate directly or recursively delegate;
- make the Orchestrator a domain executor; or
- claim operational success from static files alone.

## Baseline cross-harness experiment

The manual baseline consists of one Orchestrator file, five Pi Worker definitions, and five Claude Code custom-subagent definitions, all manually derived from this reference. Pi Worker definitions target lean nested system prompts for `pi-subagents-j0k3r`; Claude Code definitions use native custom-agent frontmatter. Both sets use specialization-specific minimal tool lists and leave model selection outside the role definition.

The artifact baseline succeeds when:

1. the reference and eleven distributable files exist at their specified repository paths and no runtime-global file is changed;
2. the Orchestrator file routes every domain action, with no short-task exception, and contains no Worker-internal procedure;
3. each Worker definition has valid discovery frontmatter, identifies itself as a direct leaf Worker, preserves the common status semantics and its runtime's delivery mechanism, and includes only its own specialization after the common core;
4. Pi Explorer and Reviewer have only `read`, `grep`, `find`, and `bash`, while Pi Implementer, Debugger, and Generalist additionally have `edit` and `write`; Claude Code roles have only the corresponding native tools `Read`, `Grep`, `Glob`, `Bash`, `Edit`, and `Write` according to the same boundaries, with no delegation tool;
5. the reference is Rootline-valid and the candidate diff is whitespace-clean; and
6. manual inspection finds the reference and all distributable files internally consistent.

Operational success requires later, explicitly authorized activation and representative manual runs in each runtime. Those runs should show that the Orchestrator dispatches instead of doing domain work, all five specializations can return the common contract through the runtime adapter, concurrent independent units remain isolated, `input_required` reaches the user, and acceptance gaps cause redispatch rather than Orchestrator execution. These live checks are outside this artifact-only experiment.
