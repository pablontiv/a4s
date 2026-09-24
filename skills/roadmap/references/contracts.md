# Roadmap contracts

These contracts govern every Roadmap mode:

```text
epic → optional non-executable aggregate
task → one-session executable unit, direct or one epic child
parent-child → hierarchy only
blocks → execution order
```

Beads stores every edge as "`issue_id` depends on `depends_on_id`". For `blocks`, `depends_on_id` is the prerequisite and `issue_id` is the dependent it unblocks. For `parent-child`, `depends_on_id` is the parent. Other edge types, such as `related` or `relates-to`, never order work.

Roadmap creates only core Beads types `epic` and `task`. A task may be at repository root or the direct child of one epic. New nested epics are invalid. An independently deliverable set of outcomes is an epic with separate tasks, not a checklist hidden in one task.

## Epic contract

A complete epic declares all of the following:

- an observable objective;
- binary success criteria;
- shared invariants;
- explicit in-scope and out-of-scope boundaries; and
- its child tasks.

The title identifies the aggregate. Put objective, context, and scope in the Beads description; implementation-wide constraints and source-of-truth guidance in design; and success criteria in acceptance criteria. Represent children with `parent-child` links, never prose alone. An epic is never a selection, claim, or implementation candidate. Close it only after all children are closed and fresh evidence proves its own success criteria.

## Task contract

A complete task contains:

- an actionable title;
- context and an expected result;
- explicit in-scope and out-of-scope boundaries;
- an observable expected initial state;
- binary acceptance criteria;
- invariants to preserve;
- source-of-truth repository paths or interfaces;
- `blocks` dependencies when applicable; and
- evidence required for closure.

The task must fit one implementation session. Put requirements in the Beads description, design, and acceptance-criteria fields rather than a parallel Markdown backlog. Use description for context, result, scope, and initial state; design for invariants, sources of truth, interfaces, and implementation constraints; and acceptance criteria for binary checks and required evidence. Dependencies remain Beads edges.

## Completeness and evidence

A contract-incomplete record remains visible in tree and Doctor output but is non-executable. Do not infer or invent missing content. Plan or an approval-gated Doctor correction must supply it.

Execution evidence is a repository-contained Markdown report. Append its repository-relative path to the Bead notes; do not paste a transcript or store evidence only outside the repository. The report must identify the Bead and candidate SHA and cover acceptance, preserved invariants, reviews, effective workspace checks, configured delivery, and post-checks.
