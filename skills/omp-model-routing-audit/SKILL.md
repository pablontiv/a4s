---
name: omp-model-routing-audit
description: Manually review OMP subagent primary and ordered fallback routes using catalog, redacted quotas, routing configuration and optional bounded generation evidence; propose changes, obtain operator approval, and verify actual new spawns.
---

# OMP model routing audit

Use for a recurring **operator-requested** review of primary/fallback assignments, or when models, access or provider capacity change. Each invocation collects evidence and proposes a decision; the operator controls recurrence and assignment. The collector uses Python 3.10+ standard library and the installed OMP CLI (native contract inspected with OMP 18.12.3).

## Collect and compare

Run from the exact directory where the relevant OMP session launches. Configuration reads reflect merged **cwd configuration**, not the resolved identity of an already running agent. Save evidence outside the repository diff, with operator-controlled access:

```sh
out=$(mktemp -d /tmp/omp-model-routing-audit.XXXXXX)
python3 skills/omp-model-routing-audit/scripts/audit.py --out "$out/snapshot.json"
# On a later manual review, supply the earlier complete snapshot:
python3 skills/omp-model-routing-audit/scripts/audit.py \
  --previous /path/to/previous-snapshot.json --out "$out/current.json"
```

Default collection performs exactly these supported commands, with argument lists and no shell, assignment or generation:

```sh
omp models refresh --kind all --json
omp usage --json --redact
omp config get modelRoles --json
omp config get task.agentModelOverrides --json
omp config get retry.fallbackChains --json
```

`models refresh` can refresh OMP's native catalog cache and usage can use cached provider readings; this is read-only with respect to model assignments and provider accounts. The CLI keys above are not the extension `cfg` namespace `models`.

To demonstrate an unchanged baseline from a real saved snapshot **without polling changing quotas or timestamps**, use offline comparison:

```sh
python3 skills/omp-model-routing-audit/scripts/audit.py \
  --snapshot "$out/snapshot.json" --previous "$out/snapshot.json" \
  --out "$out/unchanged.json"
```

Offline mode makes zero CLI calls and produces a sanitized comparison input plus `comparison`; the original snapshot remains the command/timestamp/probe evidence. `comparison.unchanged=true` means no compared changes, not healthy access or suitable assignments.

### Snapshot and failure contract

Local format `schemaVersion: 1` contains:

- `capturedAt`, `complete`, `catalog`: exact selectors, provider/kind, advertised context/output limits, modalities, reasoning/thinking and price metadata when present. Catalog ordering and modality/thinking ordering are normalized.
- `usage`: generated/fetched times and provider reports with safe plan flags and quota IDs, windows, amounts and sharing scope. Arbitrary account metadata, account/project identifiers, reset-credit details, capacity internals and credential inventories are omitted, even if native redaction only partially masks them. A missing report/field means **unknown**, not zero quota or denied access. Account-specific reports may remain separate but their identities are removed.
- `routing`: `modelRoles` strings, per-agent ordered arrays, and exact retry-chain keys/arrays. Aliases (such as `@task`) remain aliases. Array order is meaningful and preserved.
- `commands`: actual argv (synthetic probe prompt replaced by a marker), exit status and section/status; projected results live in their corresponding snapshot sections. Raw stdout/stderr, prompts, free-form provider errors, local paths and credentials are not exported.
- `probes`: selected model, classification, sanitized native result and command evidence. Collection failures prevent probes. Probe failures do not turn `complete` collection into an incomplete baseline.
- Optional `comparison`: catalog `added`/`removed`/`changed` selectors, per-setting/per-agent `before`/`after`, and `usageChanged`. It ignores collection/fetch timestamps and quota report/limit ordering, but includes quota amounts, reset times and plans. It compares neither probe results nor runtime identity. Catalog metadata changes are visible independently of additions/removals.

Exit **0** means complete collection/comparison and all requested probes successful; **1** means CLI/execution/JSON/shape/output/baseline failure or a failed requested probe; **2** means argument misuse. A CLI failure produces `complete=false` and command status (`cli-error`, `execution-error`, `invalid-json`, `invalid-shape`), retaining successful sections and exit codes rather than inventing empty successes. Diagnostics intentionally omit raw provider text; the status localizes the command for an operator to investigate privately. Each CLI call has a 120-second timeout, with no retry.

Only complete version-1 snapshots with the supported catalog/usage/routing shape are accepted as baselines. Malformed, incomplete, missing or differently versioned baselines fail before collection; no comparison is produced. Offline input is subject to the same rules. Output must differ from input paths. Recollect after a future format change rather than assuming compatibility. Preserve the exit status and use the newly emitted result only after a successful invocation; a pre-existing output file is not new evidence of success.

## Optional generation evidence

Only after an explicit operator request, select exact chat selectors from the collected catalog:

```sh
python3 skills/omp-model-routing-audit/scripts/audit.py \
  --probe 'provider/model' --out "$out/probed.json"
```

At most three distinct selectors per invocation, executed sequentially. Each selected probe uses the native `omp bench` chat profile with one run, parallelism one, 128 maximum output tokens, service tier `none`, a fixed synthetic OK prompt and the same 120-second timeout. There are no automatic candidate probes, custom prompts or automatic assignments. A selector outside the chat catalog is reported as `other-error` without invoking bench.

- `success`: CLI success, one matching resolved selector/model, native run `ok=true`, zero failures and positive reported output tokens.
- `access-error`: a recognized rejection from a failed native run's error or failed-CLI diagnostics, including `USAGE_PRICING_REQUIRED`, authentication/permission rejection or explicit insufficient quota/credits. The normalized `accessCode` retains the recognized reason without free-form provider text. HTTP 401/403 requires explicit HTTP context; numeric benchmark metrics remain generation evidence. This distinguishes advertised membership from usable access at that instant. Unknown provider error wording remains `other-error`.
- `other-error`: transport/CLI/shape failure, mismatched resolution, empty or unreported token evidence, or another generation failure. Native bench may report `ok=true` with missing token usage; this collector conservatively leaves zero-token evidence unproven.

Bench JSON records resolved targets and run statistics, not response text or server-attested identity. Even success does not prove literal OK compliance, tools, structured output, long-context reliability, coding quality or quality of a role. A catalog entry may fail actual inference (for example the observed Cursor `USAGE_PRICING_REQUIRED` failures). Catalog pricing is advertised metadata, not a subscription debit, purchasable entitlement or demonstrated plan capacity.

## Review evidence and propose ordered assignments

1. Read current routes and the comparison. For every agent under review, record its workload, required tools/schema, typical and maximum observed context, latency sensitivity, current primary and ordered fallbacks. Keep explicit per-call model selection separate from inherited/configured routes.
2. Build a candidate matrix: `agent | selector/alias | provider | advertised context/output/pricing | plan/quota freshness and shared pool | inference evidence | real tools/schema/task evidence | suitability and uncertainty`. Mark every basis **catalog**, **measured inference**, **measured role capability**, or **[INFERENCE]**. Unknown tool support stays unknown; a reasoning flag does not establish tool/schema capability.
3. Use representative, authorized task transcripts for role capability: actual tool call/result, task outcome, context and native schema-validation metadata. A JSON-looking text response is not schema enforcement. In native OMP, verify the agent's structured setting and effective schema: `outputSchema` alone may be ignored when structured tasks are disabled. A valid native structured result and machine parsing are separate observations to record. Match evidence to the role rather than treating an OK probe as a benchmark. `cost-analyzer` supplies historical cost/outcome context; `gpt-quota-audit` supplies measured subscription burn, not an advertised dollar-price substitute.
4. Assess capacity independently of family: two providers may serve the same model family, while different models can consume the same subscription pool. Retain quota sharing/window/reset/freshness and missing-provider uncertainties. Prefer evidence-backed provider diversity when a fallback is intended to survive provider exhaustion; it is a proposal, not an automatic policy.
5. Reuse [`review-routing`](../../packages/review-routing/) for family eligibility and ordering. It owns the review-agent hook and resolves family through OMP's model facade; a provider-prefix heuristic is not an alternative family selector. Its hook may reorder/filter the proposal, add role fallbacks or block a strict reviewer/QA spawn. Inspect the actually installed extension/policy and verify the effective result.
6. Inspect `retry.fallbackChains` for **exact primary-model keys**. Native exact-model retry entries take precedence over dynamically installed per-agent chains. Show a collision in the proposal and obtain a separate explicit decision if its value must change; preserving it can make the actual chain differ from the requested agent list. Include that distinction in expected results.
7. Produce an ordered diff, not an assignment: `agent | current [primary, fallback1, ...] | proposed [primary, fallback1, ...] | rationale/evidence | expected post-hook chain | exact-model retry interaction | unresolved risk`. Preserve aliases unless an intentional concrete-model change is proposed. Include the complete before/after `task.agentModelOverrides` record so unaffected agents remain intact. Propose role/retry changes separately only when needed and authorized.

`seance` always bypasses ordinary agent overrides/spawn hooks. It reuses historical `sourceSession` model selectors unless an intentional per-call model is supplied; that explicit model still bypasses the hooks. Review it separately; changing agent overrides is not evidence of changing a seance. Native `if-bench` evaluates instruction following and working memory (confirmed with `omp if-bench --help` only), while `/ratchet` is an interactive optimization workflow; neither is a turnkey per-agent routing assignment or role-capability proof.

## Approval and supported application

Present the evidence, exact ordered JSON diff, scope and risks to the operator. The default deliverable stops at report/proposal. Approval must name the exact values and persistence target before any configuration mutation.

The installed native help was checked with **only** `omp config set task.agentModelOverrides --help`: `omp config [ACTION] [KEY] [VALUE...] [FLAGS]`, with record values supplied as JSON. According to the [OMP settings interface](https://omp.sh/docs/settings), `set`/`reset` write the active **global/profile** config, not cwd project configuration; no project-write flag is advertised. An implementation run of this skill does not authorize global writes. If the operator explicitly approves that active profile/global scope, the supported form is:

```sh
# ONLY after approval; replace the placeholder with the complete approved JSON record.
omp config set task.agentModelOverrides '<complete approved JSON object>'
# Read back from the intended launch cwd; project overrides may shadow this write.
omp config get task.agentModelOverrides --json
```

Check current `--help` before applying on a different OMP version. For project-only intent, obtain approval for the exact launch-directory `.omp/config.yml` change through OMP's documented project configuration interface instead of pretending `config set` has project scope; merge the approved record into that file while preserving unrelated keys. Confirm the active profile/config target privately, and retain only redacted target-scope evidence in the audit. A readback shows persisted/merged values, not running-session reassignment. Rollback is a separately approved restoration of the recorded before-values at the same scope.

## Verify actual new agents

After an approved application, launch a **fresh** instance of each changed agent type through its normal native `task` route. Existing agents retain their session identity. Give each a small representative authorized task requiring a real read/tool result and, where the role requires it, the native structured result contract. Include the exact targeted check in the assignment and record the actual commands/results; inference has cost and needs authorization independently of default collection.

Inspect runtime JSONL or native history for each new spawn:

- `session_init.agent`, selected/resolved provider/model and installed `retryFallback.primary` / ordered `retryFallback.chain` (when emitted).
- Actual assistant `provider`/`model` identities after hooks and any observed transition; resolve family using the existing extension/facade where family matters.
- Actual tool call **and result**, native structured-output validation metadata and parsed output, plus representative task outcome. Keep transcript references and sanitized excerpts outside the repository diff; strip private paths/prompts/account data before sharing.
- Proposal versus observed post-hook primary/chain, including exact-model retry precedence. Record configured, installed and **actually exercised** fallback separately. A successful primary run with an installed fallback does not test fallback execution. Use naturally observed transitions or a separately authorized bounded fallback exercise; report unexercised fallback as unverified rather than deliberately exhausting provider quota.

If readback, runtime identity, chain or role behavior differs, report the discrepancy and revise the proposal; further persistence requires approval. Finish with the ordered decision, evidence references, observed/unverified capabilities and explicit remaining uncertainties. The workflow is manual and does not schedule future runs.

## Targeted checks

```sh
python3 skills/omp-model-routing-audit/scripts/audit.py --help
python3 -m unittest discover -s skills/omp-model-routing-audit/scripts -p "test_*.py"
```

Tests use isolated synthetic snapshots and native bench-shaped results, with offline comparisons and malformed/access boundary cases. They perform no model inference or configuration writes. A real default collection plus offline self-comparison demonstrates the installed read-only CLI integration; role-capability and fallback execution require the separate runtime evidence above.
