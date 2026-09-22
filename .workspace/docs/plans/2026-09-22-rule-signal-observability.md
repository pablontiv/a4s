# Rule-signal observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/rules-review` explain why the latest successful compaction has no stored rule proposals, using only existing session-local `RuleSignalBatch` data.

**Architecture:** Add a small pure observation helper in `extension.ts` that groups all batches from the latest `compactionAttemptId`, then derives the candidate count from the existing `provenance.sanitizedExcerpts` trust-boundary criterion and totals selected signals. Invoke it only from the no-proposal branch of `/rules-review`; normal proposal rendering and every write/lifecycle path remain unchanged.

**Tech Stack:** TypeScript, Pi Extension API, Node.js built-in test runner, `tsx`.

**Spec:** `.workspace/docs/specs/2026-09-22-rule-signal-observability-design.md`

## Global Constraints

- Reuse only existing `a4s.pi-rule-compiler.rule-signals.v2` entries on the active Pi conversation branch; add no schema field, custom entry, migration, or persistence write.
- Aggregate every window with the most recent `provenance.compactionAttemptId`; never inspect only the final window of a split compaction.
- Count a candidate exactly when its existing sanitized excerpt is non-empty and its role is `user` or `custom`; import and reuse `canProvideRuleAuthority` rather than duplicating that trust-boundary predicate.
- Do not render excerpts, raw message content, scores, token counts, digests, model data, credentials, or `sanitizedExcerpts` themselves.
- Do not change Jev/current-model calls, default thresholds, compaction decisions, retro processing, retries, `/retro-rules`, or proposal acceptance.
- Keep current proposal-list output byte-for-byte unchanged whenever a stored proposal exists.

## Review Focus

- **Split latest compaction:** two newest batches with one `compactionAttemptId` must be summed; the test belongs in Task 1, Step 1.
- **Earlier successful compaction:** a batch from an older attempt must not contribute to the latest diagnostic; the test belongs in Task 1, Step 1.
- **No authority source:** non-empty `toolResult` and `bashExecution` excerpts must report zero eligible candidates; the test belongs in Task 1, Step 1.
- **Conservative filter:** an eligible `user` message with zero selected signals must report evaluation without claiming it was a durable rule; the test belongs in Task 1, Step 1.
- **Privacy regression:** a diagnostic must not contain an existing sanitized excerpt or its digest; the test belongs in Task 1, Step 1.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/pi-rule-compiler/src/extension.ts` | Derive the latest-attempt rule observation and render the no-proposal `/rules-review` state. |
| `packages/pi-rule-compiler/test/extension.test.ts` | Exercise the registered `/rules-review` command with persisted signal-batch fixtures. |
| `packages/pi-rule-compiler/README.md` | Document that `/rules-review` diagnoses the latest session-local observation when proposals are absent. |

### Task 1: Derive and render the no-proposal diagnostic

**Files:**
- Modify: `packages/pi-rule-compiler/src/extension.ts:1-70,342-363`
- Modify: `packages/pi-rule-compiler/test/extension.test.ts:1-120` and append focused `/rules-review` tests after the command-adjacent tests
- Modify: `packages/pi-rule-compiler/README.md:Runtime contract`

**Interfaces:**
- Consumes: `collectRuleSignalBatches(entries)` from `src/storage.ts`, `RuleSignalBatch` from `src/types.ts`, and `canProvideRuleAuthority(role)` from `src/questions.ts`.
- Produces: internal `latestRuleObservation(batches: readonly RuleSignalBatch[]): { candidateCount: number; signalCount: number } | undefined` and `renderNoProposalState(entries: readonly unknown[]): string`.
- Preserves: `renderProposalList(entries)` returns its existing proposal list without calling diagnostic rendering when `collectRuleProposalBatches(entries).length > 0`.

- [ ] **Step 1: Add command-level failing tests for all diagnostic states**

  In `test/extension.test.ts`, import `stableDigest` and `type RuleSignalBatch`. Add these local helpers beside `appendSuccessfulCompaction`:

  ```ts
  class NoRuleSignalJev extends ValidFakeJev {
    override async evaluate(request: JevRequest): Promise<unknown> {
      this.calls += 1;
      this.requests.push(request);
      return validJevResponse(request, (id, question) =>
        id.startsWith("rule_candidate_") && question.type === "noul"
          ? { type: "noul", noul: 0 }
          : undefined,
      );
    }
  }

  async function batchFor(
    messages: unknown[],
    jev: JevClient,
    attempt: string,
  ): Promise<RuleSignalBatch> {
    return observeCompactionRules(
      { messagesToSummarize: messages, turnPrefixMessages: [] },
      {
        reason: "manual",
        willRetry: false,
        observedAt: "2026-09-22T12:00:00.000Z",
        attemptId: stableDigest({ attempt }),
      },
      jev,
      new AbortController().signal,
    );
  }

  function asSignalEntry(batch: RuleSignalBatch): StoredEntry {
    return { type: "custom", customType: RULE_SIGNAL_ENTRY_TYPE, data: batch };
  }

  async function runRulesReview(entries: StoredEntry[]): Promise<string> {
    const fake = createFakePi(entries);
    registerPiRuleCompiler(fake.pi, { jevClient: new ValidFakeJev() });
    const { context, notifications } = createContext(fake.entries);
    await fake.commands.get("rules-review")?.("", context);
    return notifications.at(-1)?.message ?? "";
  }

  function storedProposalEntry(): StoredEntry {
    const digest = stableDigest({ proposal: "existing" });
    return {
      type: "custom",
      customType: RULE_PROPOSAL_ENTRY_TYPE,
      data: {
        schema: "a4s.rule-proposal-batch/v1",
        idempotencyKey: digest,
        createdAt: "2026-09-22T12:00:00.000Z",
        sourceCompactionAttemptIds: [digest],
        sourceBatchDigests: [digest],
        sourceSignalIds: [],
        synthesisModel: { provider: "fake", id: "model" },
        jevModel: "jev-1.13.0",
        candidates: [],
      },
    };
  }
  ```

  Add these tests with exact assertions:

  ```ts
  test("/rules-review explains that no rule observation exists", async () => {
    const message = await runRulesReview([]);
    assert.equal(message, "No stored rule proposals or rule observations. Run a successful compaction.");
  });

  test("/rules-review distinguishes filtered candidates from absent authority sources", async () => {
    const toolOnly = await batchFor(
      [{ role: "toolResult", content: "SECRET_TOOL_SENTINEL" }, { role: "bashExecution", content: "SECRET_BASH_SENTINEL" }],
      new ValidFakeJev(),
      "latest",
    );
    assert.match(await runRulesReview([asSignalEntry(toolOnly)]), /no non-empty user or custom messages/i);

    const filtered = await batchFor(
      [{ role: "user", content: "Transient question only" }],
      new NoRuleSignalJev(),
      "latest",
    );
    const filteredMessage = await runRulesReview([asSignalEntry(filtered)]);
    assert.match(filteredMessage, /evaluated 1 rule candidate/i);
    assert.match(filteredMessage, /none passed the conservative filter/i);
    assert.doesNotMatch(filteredMessage, /Transient question|SECRET_TOOL_SENTINEL|SECRET_BASH_SENTINEL/);
    assert.doesNotMatch(filteredMessage, new RegExp(filtered.sourceDigest));
  });

  test("/rules-review aggregates only every window of the latest attempt", async () => {
    const older = await batchFor([{ role: "user", content: "Older candidate" }], new ValidFakeJev(), "older");
    const latestFirst = await batchFor([{ role: "user", content: "Latest one" }], new NoRuleSignalJev(), "latest");
    const latestSecond = await batchFor([{ role: "custom", content: "Latest two" }], new NoRuleSignalJev(), "latest");
    const message = await runRulesReview([asSignalEntry(older), asSignalEntry(latestFirst), asSignalEntry(latestSecond)]);
    assert.match(message, /evaluated 2 rule candidate/i);
    assert.match(message, /none passed the conservative filter/i);
  });

  test("/rules-review guides retry when signals exist but proposals do not", async () => {
    const batch = await batchFor([{ role: "user", content: "Always run tests." }], new ValidFakeJev(), "latest");
    const message = await runRulesReview([asSignalEntry(batch)]);
    assert.match(message, /recorded 1 RuleSignal/i);
    assert.match(message, /\/retro-rules/);
  });

  test("/rules-review preserves the existing proposal-list output", async () => {
    const message = await runRulesReview([storedProposalEntry()]);
    assert.equal(message, "0 candidate(s), 0 proposable. Use /rules-show <id> then /rules-accept <id>.");
  });
  ```

- [ ] **Step 2: Run the focused test file to verify it fails**

  Run:

  ```bash
  cd [REDACTED:shared-root]/harness/a4s
  npm test --workspace @a4s/pi-rule-compiler
  ```

  Expected: FAIL because `/rules-review` still returns `No stored rule proposals. Run compaction or /retro-rules first.` for every no-proposal fixture.

- [ ] **Step 3: Add the pure latest-attempt helper without any write behavior**

  In `src/extension.ts`, import `collectRuleSignalBatches`, `RuleSignalBatch`, and `canProvideRuleAuthority` if they are not already available. Add these internal helpers adjacent to `renderProposalList`:

  ```ts
  interface LatestRuleObservation {
    candidateCount: number;
    signalCount: number;
  }

  function latestRuleObservation(
    batches: readonly RuleSignalBatch[],
  ): LatestRuleObservation | undefined {
    const latest = batches.at(-1);
    if (!latest) return undefined;

    const latestAttemptId = latest.provenance.compactionAttemptId;
    const attemptBatches = batches.filter(
      (batch) => batch.provenance.compactionAttemptId === latestAttemptId,
    );
    const candidateCount = attemptBatches.reduce(
      (total, batch) => total + batch.provenance.sanitizedExcerpts.filter(
        (message) => message.excerpt.trim().length > 0 && canProvideRuleAuthority(message.role),
      ).length,
      0,
    );
    const signalCount = attemptBatches.reduce((total, batch) => total + batch.signals.length, 0);
    return { candidateCount, signalCount };
  }
  ```

  Keep this helper read-only. Do not alter `persistSignalBatches`, `reconcileCompactionArtifacts`, `drainPendingRetro`, storage parsing, or the `RuleSignalBatch` schema.

- [ ] **Step 4: Render the four specified empty states**

  Change only the empty-proposal branch in `renderProposalList` to call a new `renderNoProposalState(entries)` helper. It must use `collectRuleSignalBatches(entries)` and `latestRuleObservation(...)`, then render:

  ```ts
  if (!observation) {
    return "No stored rule proposals or rule observations. Run a successful compaction.";
  }
  if (observation.candidateCount === 0) {
    return "Latest compaction: no non-empty user or custom messages were eligible as rule sources.";
  }
  if (observation.signalCount === 0) {
    return `Latest compaction: evaluated ${observation.candidateCount} rule candidate(s); none passed the conservative filter.`;
  }
  return `Latest compaction: recorded ${observation.signalCount} RuleSignal(s), but no rule proposal is stored. Run /retro-rules to retry retro processing.`;
  ```

  Do not interpolate any excerpt, digest, score, batch ID, or raw entry property. Do not change the loop that renders existing proposals.

- [ ] **Step 5: Update the runtime contract documentation**

  In `packages/pi-rule-compiler/README.md`, extend the review bullet with this sentence:

  ```md
  When no proposal is stored, `/rules-review` reports whether the latest session-local compaction had no eligible `user`/`custom` sources, filtered all eligible candidates, or retained signals awaiting retro; it never displays message content.
  ```

  Keep the existing statement that review is store-only and does not write Rootline or `AGENTS.md`.

- [ ] **Step 6: Run focused verification and inspect diagnostics**

  Run:

  ```bash
  cd [REDACTED:shared-root]/harness/a4s
  npm test --workspace @a4s/pi-rule-compiler
  npm run typecheck --workspace @a4s/pi-rule-compiler
  git diff --check
  ```

  Expected: all package tests and typecheck pass; `git diff --check` has no output. Run active LSP diagnostics on `packages/pi-rule-compiler/src/extension.ts` and `packages/pi-rule-compiler/test/extension.test.ts`; resolve any new error-level findings before committing.

- [ ] **Step 7: Commit the implementation**

  ```bash
  cd [REDACTED:shared-root]/harness/a4s
  git add packages/pi-rule-compiler/src/extension.ts \
          packages/pi-rule-compiler/test/extension.test.ts \
          packages/pi-rule-compiler/README.md
  git commit -m "feat(rule-compiler): explain empty rule proposals"
  ```

  Verify with `git show --stat --oneline HEAD` that the commit contains only the three planned files. Do not stage existing unrelated worktree changes.

## Plan Self-Review

- **Spec coverage:** Task 1 implements all four no-proposal states, latest-attempt window aggregation, existing session-only storage, trusted-role counting, read-only behavior, privacy constraints, error fallback, and documentation. It does not introduce any out-of-scope data, commands, model calls, or state writes.
- **Placeholder scan:** No TBD/TODO markers, unspecified tests, or deferred code details are present.
- **Type consistency:** `latestRuleObservation` consumes `RuleSignalBatch[]`; its `candidateCount` uses the pre-existing exported `canProvideRuleAuthority` criterion; `renderNoProposalState` consumes raw branch entries through the pre-existing validated collector.
- **Review focus coverage:** Each of the five listed input classes is explicitly tested in Task 1, Step 1.

## Execution Handoff

Plan complete and saved to `.workspace/docs/plans/2026-09-22-rule-signal-observability.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** — A fresh subagent implements the task and a fresh reviewer checks it before completion. Most thorough; costs a fresh context and review.
- **Native** — I implement the task in this session, then obtain one whole-branch review. Fastest and least context overhead.

For this plan I recommend **Native**, because it is one small, tightly coupled read-only renderer change with focused tests, and the repository worktree already contains unrelated uncommitted changes that should not be handed to a broad implementer. Does the plan capture what you want, and which approach should we use?
