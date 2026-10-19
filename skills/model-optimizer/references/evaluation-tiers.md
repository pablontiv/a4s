# Model Optimizer evaluation tiers

Normative depth ladder for the role-evaluation step. Each tier costs more
quota than the previous one, so a candidate only advances when it passes the
tier below. Tiers measure different things; a PASS at one tier never
substitutes for the next.

## Gate rule

Do not spend tier N+1 quota on a route that failed tier N. A route that
fails L0 is not "probably fine at L1" — it is excluded. Record the failing
tier in the decision so a later retry starts at the right depth, not from
scratch.

## Tier ladder

| Tier | Name | What it proves | Cost |
|---|---|---|---|
| L0 | Health | The exact runtime-local route answers one no-tools probe at the proposed effort | Minimal |
| L1 | Single role fixture | One synthetic, role-matched fixture graded semantically; no repo, no tools | Low |
| L2 | Comparative suite | Identical multi-domain battery for every shortlisted candidate, plus output discipline | Medium |
| L3 | Executable verification | Model-produced module compiles under strict settings and passes runtime assertions in a temp sandbox | High |

### L0 — Health

One isolated headless probe per route: `pi --model <exact-id> --thinking <effort> --no-skills --no-context-files --no-session --no-tools -p 'Return exactly PONG.'`
PASS requires exit 0 and the exact expected output. Auth-check alone is not
L0; a catalog row is not L0.

### L1 — Single role fixture

One bounded, synthetic, role-matched fixture (use bundled `evals/` fixtures
when they match the role). No repository files, no ambient tools, no
credentials. Grading is semantic against an explicit rubric. Prefer the
cheapest sufficient route: a PASS here establishes fitness, not superiority.

### L2 — Comparative suite

Run the same multi-domain battery, byte-identical, against every shortlisted
candidate, then grade all answers against one fixed rubric. The suite must
include an output-discipline criterion: when the task demands a pure module
or JSON-only answer, Markdown fences or prose wrappers are a graded failure,
not a formatting nit. Real session evidence: two otherwise-capable models
failed this criterion.

### L3 — Executable verification

The model must return one module with no Markdown. Save stdout to a temp
workspace, compile with the strict project-equivalent settings
(e.g. `tsc --ignoreConfig --strict --noEmit`), then run local assertions for
the fixture's required cases. Report the three stages separately:
`startup`, `compile`, `runtime`.

## Failure taxonomy — harness failure is not model failure

Classify every failure before acting on it:

- **Harness failure:** wrong flags (e.g. `--no-extensions` on an
  extension-backed provider route), missing CLI auth, sandbox absent, worker
  role restrictions, model-id resolution errors from the harness itself.
  The model was never evaluated. Retry only after the harness fix is
  reproduced and the user renews authorization.
- **Output-discipline failure:** correct semantics wrapped in Markdown or
  prose when the contract demanded a pure artifact. Counts as a model
  failure for generation roles.
- **Semantic failure:** wrong root cause, missed blocking defect, contract
  deviation (e.g. renamed canonical field), uncontrolled clock.
- **Execution failure:** strict-compile errors or failing runtime assertions.

Never conflate these in the rendered proposal; a harness failure is reported
as `NEEDS_MORE_EVIDENCE` with the harness defect named, never as a model
weakness.

## Worker parallelization rules

When subagents parallelize evaluations:

1. The model under test belongs to the headless `pi --model <id>` process
   the worker launches via bash. The worker's own profile is irrelevant.
2. Never rotate, edit, or restore `subagents.json` (or any runtime config)
   to change which model a subagent runs as. Config mutation for evaluation
   is prohibited; only the post-approval apply sequence may mutate config.
3. One worker executes exactly one candidate route per dispatch batch;
   respect the configured max concurrency.
4. Provider-extension routes (e.g. Devin CLI-backed providers) must keep
   extensions enabled in the headless command. `--no-extensions` is only
   for native providers.
5. A worker that refuses or blocks the command is a harness failure for that
   candidate; re-dispatch with a compatible worker, identical payload.

## Fallback chains and effort sensitivity

A route decision is incomplete without its failure story.

**Failure mode determines the fallback.** A model-level failure (quota,
deprecation, model-specific outage) is solved inside the same provider
(e.g. Terra → Sol). A provider-level failure (auth, network, full outage)
requires crossing providers (→ an external route). A fallback chain that
does not distinguish these modes is fragile: verify the failure behavior
directly (a bogus-model probe is a valid L0 variant — a hard failure with
no fallback is a finding, not an error).

**Every healthy challenger is a manual-fallback candidate.** When the
decision is `NO_CHANGE`, the strongest challenger is not discarded: record
it as the documented manual fallback for that route, with the effort at
which it was validated.

**Virtual/router routes are not models.** A routing-layer route (e.g.
auto-router virtuals) buys cross-provider resilience at the cost of exact
model pinning. Mark it as a routing layer in the proposal; never present
its internal fallback as equivalent to an evaluated exact route.

**Effort is an evaluated variable.** Before recommending a thinking-level
change, measure sensitivity: run the same battery at both efforts and
compare verdicts. If no verdict changes, the lower effort wins on cost.
One battery pair is a hypothesis; claim savings only after repeated or
real-world confirmation.

## Fixture quality bar per tier

- L1 fixtures: one clear success criterion, deterministic expected answer,
  no ambiguity about the contract.
- L2 batteries: every domain scored against the same rubric for all
  candidates; rubric fixed before any candidate runs.
- L3 modules: strict compile settings, injected clock/time dependencies,
  assertions cover the required cases plus the regression the fixture
  names. Temp workspace only; never write into the repository.
- Fallback chains: document the manual fallback per route with its
  validated effort, distinguishing model-level from provider-level
  failure modes.
