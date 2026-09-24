# Roadmap

Roadmap is a Markdown-only workflow over the repository's Beads backlog. It has no custom runtime, parser, adapter, schema, or test suite.

## Commands

Invoke the skill in the repository whose backlog you intend to inspect or change:

```text
/skill:roadmap plan <requirements>  propose a complete graph, ask approval, then create it
/skill:roadmap                      inspect and explain the pending tree read-only
/skill:roadmap doctor               diagnose alignment; preview and approval-gate corrections
/skill:roadmap loop                 claim and implement one ready task at a time
```

Plan and Doctor do not mutate before explicit approval. Bare Roadmap never mutates. Loop is sequential and combines each Bead's acceptance contract with the effective repository Definition of Done.

## Direct dependencies

- the installed Beads 1.3.x `bd` CLI for durable backlog state and all graph operations;
- Git for repository and candidate state; and
- the effective `.workspace/config.yaml` for mutating loop work, including review, delivery, and post-check policy.

Rootline may govern ADRs, specs, and plans, but it is not a Roadmap backlog dependency. Temporary graph input may exist under ignored `.superpowers/roadmap/`; Beads remains the only durable backlog.

## Verification

Verify prose behavior with the `writing-skills` pressure method, not a Roadmap test harness:

1. preserve the bounded pre-skill response for each review-focus scenario;
2. load `SKILL.md` and only the routed reference in a fresh agent;
3. rerun Plan approval, false empty frontier, Doctor ambiguity, missing-workspace-DoD, and parallelism-pressure scenarios;
4. record pass/fail and the exact rationalization;
5. if one fails, change only the implicated Markdown and rerun that scenario with another fresh agent.

Also confirm the bundle contains only Markdown, the public router stays concise, forbidden legacy commands are absent, and `git diff --check` is clean. Existing repository checks remain applicable; do not add Roadmap unit, integration, or E2E tests.

## Activation boundary

Repository merge and global activation are separate operations. Only after the change is merged, and only with explicit operator authorization, install a global `roadmap` symlink that targets the stable A4S checkout. Never point a global skill symlink at an implementation worktree. Remove the retired global predecessor only after the new stable target has been verified. The implementation workflow must not alter global runtime symlinks.
