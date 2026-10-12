# Synagent Workspace Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Pi/Pion and Claude activate Synagent from an explicit workspace identity in the exact current directory when Git identity is unavailable.

**Architecture:** Keep v1 addresses unchanged and treat workspace as another source for the existing project token. The canonical protocol module owns strict parsing, exact-cwd file loading, precedence, and source reporting; both adapters consume it, while Claude's generated protocol copy remains byte-identical.

**Tech Stack:** TypeScript 7, Node.js 22 built-ins, Node test runner, Pi/Pion extension APIs, Claude hook APIs.

**Spec:** https://github.com/pablontiv/a4s/issues/96

## Global Constraints

- Shared configuration is exactly `<cwd>/.workspace/config/synagent.json` with JSON shape `{ "workspace": "<v1-token>" }`.
- Precedence is explicit host `project` setting, then exact-cwd workspace, then Git `remote.origin.url`.
- A present but malformed or invalid workspace file fails identity resolution; it never falls through to Git.
- Do not search parent directories, derive from basename/environment, inspect child repositories, or change protocol v1 addresses/topics.
- Use the existing `isToken` grammar without trimming or sanitizing the workspace value.
- Keep `adapters/claude/hooks/adapter.ts` generated from `protocol.ts` through the existing sync script.
- Add no dependency.

## Review Focus

- A workspace file with invalid JSON, wrong shape, extra fields, or an invalid token must fail closed; Task 1 tests each class.
- An explicit project setting must win even when the local workspace file is invalid; Tasks 2 and 3 test adapter-visible behavior.
- A valid workspace must win over a conflicting Git origin; Tasks 1–3 test canonical and host behavior.
- A child repository without its own workspace file must not inherit its parent's token; Task 1 tests exact-cwd lookup.
- Status output must identify `setting`, `workspace`, or `origin` without exposing file contents; Tasks 2 and 3 assert source labels.

---

### Task 1: Canonical Workspace Resolution

**Files:**
- Modify: `packages/synagent/core/protocol.ts`
- Modify: `packages/synagent/core/test/protocol.test.ts`

**Interfaces:**
- Produces: `readWorkspaceProject(cwd: string): string | undefined`.
- Produces: `resolveProjectWithSource(options: { setting?: string; workspace?: string; origin?: string }): { project: string; source: 'setting' | 'workspace' | 'origin' }`.
- Preserves: `resolveProject(...) => string`, extended with optional `workspace`, for existing callers.

- [ ] **Step 1: Write failing canonical tests**

Add tests named:
- `readWorkspaceProject reads only the exact cwd contract`
- `readWorkspaceProject rejects malformed, ambiguous, and invalid workspace config`
- `resolveProject uses setting > workspace > origin and reports the source`

Use temporary directories and literal expectations: `Root.Space`, `Child.Repo`, and source strings `setting`, `workspace`, `origin`. Assert the child lookup is `undefined`, invalid workspace inputs throw, and existing v1 token case/dot behavior is preserved.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test --workspace @a4s/synagent -- --test-name-pattern='workspace|resolveProject'`

Expected: FAIL because the workspace reader and source-aware resolver do not exist.

- [ ] **Step 3: Implement the canonical reader and resolver**

Use only `node:fs` and `node:path`. Treat `ENOENT` as no workspace; surface every other read/parse/schema/token error. Have `resolveProject` delegate to `resolveProjectWithSource` so existing string callers retain their contract.

- [ ] **Step 4: Run focused protocol tests and verify GREEN**

Run: `npm test --workspace @a4s/synagent -- --test-name-pattern='workspace|resolveProject'`

Expected: PASS.

### Task 2: Pi/Pion Workspace Activation and Status

**Files:**
- Modify: `packages/synagent/core/adapters/pi/index.ts`
- Modify: `packages/synagent/core/test/pi-adapter.test.ts`

**Interfaces:**
- Consumes: `readWorkspaceProject` and `resolveProjectWithSource` from Task 1.
- Produces: Pi/Pion activation from exact-cwd workspace plus effective source in startup, `/synagent status`, and settings labels.

- [ ] **Step 1: Write failing Pi integration tests**

Add real temporary cwd tests named:
- `Pi adapter activates from exact-cwd workspace without Git`
- `Pi adapter explicit project wins over an invalid workspace`
- `Pi adapter rejects invalid workspace instead of falling back to Git`

Assert real subscribed topics contain `synagent/v1/Workspace.Name/<session>`, project and global broadcasts remain unchanged, conflicting Git is ignored, invalid configuration yields no v1 subscriptions, and status text contains `source=workspace` or `source=setting`.

- [ ] **Step 2: Run the Pi tests and verify RED**

Run: `npm test --workspace @a4s/synagent -- --test-name-pattern='Pi adapter.*workspace|Pi adapter explicit project'`

Expected: FAIL because Pi does not read or report workspace identity.

- [ ] **Step 3: Wire canonical resolution into Pi/Pion**

Read workspace only when no explicit project is configured, then read Git origin only when neither higher-precedence source exists. Store the effective source beside the active identity, clear both together on rebind, and include the source in startup/status/settings output. Extend unresolved remediation with `.workspace/config/synagent.json`.

- [ ] **Step 4: Run the Pi tests and verify GREEN**

Run: `npm test --workspace @a4s/synagent -- --test-name-pattern='Pi adapter.*workspace|Pi adapter explicit project'`

Expected: PASS.

### Task 3: Claude Workspace Activation and Generated Parity

**Files:**
- Modify: `packages/synagent/core/adapters/claude/hooks/register.ts`
- Generate: `packages/synagent/core/adapters/claude/hooks/adapter.ts`
- Modify: `packages/synagent/core/test/register.test.ts`
- Verify: `packages/synagent/core/test/claude-parity.test.ts`

**Interfaces:**
- Consumes: canonical workspace reader and source-aware resolver from Task 1 through Claude's generated adapter copy.
- Produces: Claude activation from `$.session.cwd()` with effective source in status.

- [ ] **Step 1: Write failing Claude hook tests**

Add tests named:
- `register activates Claude from exact-cwd workspace without Git`
- `register project setting wins over an invalid workspace`
- `register rejects invalid workspace instead of falling back to origin`

Use a real temporary cwd and the existing hook harness. Assert spawned subscription topics use the workspace token, source status is `workspace` or `setting`, and invalid workspace leaves the adapter inactive.

- [ ] **Step 2: Run the Claude tests and verify RED**

Run: `npm test --workspace @a4s/synagent -- --test-name-pattern='register.*workspace|register project setting'`

Expected: FAIL because Claude ignores `$.session.cwd()` for identity.

- [ ] **Step 3: Wire canonical resolution into Claude**

Resolve setting first, call `$.session.cwd()` and read workspace second, and call `$.session.repo()` only for the Git fallback. Return the source with the identity and include `source=<source>` in the successful status line.

- [ ] **Step 4: Regenerate the Claude protocol copy**

Run from `packages/synagent/core`: `node adapters/claude/scripts/sync-protocol.mjs`

Expected: `adapter.ts` includes the canonical workspace contract and no hand edits.

- [ ] **Step 5: Run Claude and parity tests and verify GREEN**

Run: `npm test --workspace @a4s/synagent -- --test-name-pattern='register.*workspace|register project setting|claude-parity'`

Expected: PASS.

### Task 4: Documentation and Full Verification

**Files:**
- Modify: `packages/synagent/core/README.md`

**Interfaces:**
- Documents: file path/schema, precedence, exact-cwd behavior, invalid-file failure, status source, and unchanged v1 addressing.

- [ ] **Step 1: Update the Synagent README**

Document a minimal JSON example, all three precedence levels, no ancestor search, invalid-file fail-closed behavior, and unchanged `<workspace>/<instance>`, `<workspace>/all`, and `synagent/v1/...` forms.

- [ ] **Step 2: Run fresh diagnostics**

Run LSP diagnostics on every changed TypeScript file and resolve all errors.

- [ ] **Step 3: Run Synagent tests and typecheck**

Run: `npm test --workspace @a4s/synagent && npm run typecheck --workspace @a4s/synagent`

Expected: all tests pass and TypeScript exits 0.

- [ ] **Step 4: Run repository-wide tests and typecheck**

Run: `npm test && npm run typecheck`

Expected: all workspace suites pass with no failures.

- [ ] **Step 5: Review the final diff**

Confirm only issue #96 scope changed, generated parity is exact, package metadata has no new dependency, and worktree status contains no install-only noise.
