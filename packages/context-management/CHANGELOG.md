# Changelog

## Unreleased

- Move the reusable Context Expert core to the private
  `@a4s/context-management` library in `packages/context-management`.
- Retain public transformation, state/message, request/client, neutral binding
  and trigger APIs through `core/index.ts`, with zero runtime dependencies.
- Remove the Pi/Pion and Claude adapters, generated bundled core, plugin hooks,
  extension declarations, host types, runtime/evaluation scripts and host-only
  tests and dependencies. Migrate root scripts, workspace lock, marketplace and
  CI ownership to the library.
- Keep behavioral core, request and trigger tests; import/typecheck them through
  the public package name. Extend core behavior coverage to all three scoring
  outcomes and all-keep object identity.
- Preserve upstream MIT attribution with current retained source paths in NOTICE.
- Verification on 2026-10-20: the exact targeted test/typecheck command passed
  (15 tests). An external TypeScript consumer executed real `compact`,
  `reductionRatio` and neutral binding with a deterministic `JevAsker`: keep,
  truncate and drop reduced 13,930 characters to 4,842 (65.24%); first/kept
  messages preserved identity and all-keep returned a zero-reduction no-op.
  README records the exact smoke commands and output.
