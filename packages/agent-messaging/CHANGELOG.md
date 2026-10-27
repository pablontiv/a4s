# Changelog

## Unreleased

- Use root Node and shared development-tool requirements, workspace-local hot-reload identity and the broker workspace's Aedes dependency for tests; retain the messaging runtime and protocol contracts.
- Move the private canonical package to `@a4s/agent-messaging` at `packages/agent-messaging`, retaining OMP reloadable loading, protocol, MQTT, shared session delivery/recovery/settings/arbitration, observer and canonical diagnostics.
- Publish the clean public surface `agent_messaging_send`, `/agent-messaging`, `/agent-messaging-settings`, `createAgentMessagingOmp`, `createAgentMessagingAdapter`, `AgentMessaging*` types and `AGENT_MESSAGING_*` constants; retain the functional `/mq-send` debug command.
- Read `agent-messaging.json` in the OMP agent directory and use `A4S_AGENT_MESSAGING_BROKER_URL` / `A4S_AGENT_MESSAGING_REQUEST_TTL`. Shorthand sends require an explicitly configured canonical peer. The README describes the one-time operator migration of local settings, extension lists, commands and prompts.
- Identify diagnostic service/scope/events as `@a4s/agent-messaging` / `a4s.agent-messaging.*`.
- Preserve broker v2 wire names, durable MQTT client IDs, native session entry keys and delivery markers for resume and deduplication.
- Remove exclusive Pi/Claude adapters, generated copies, loader declarations, settings readers, parity/sync machinery and host-only tests/scripts. Retain the native OMP SDK dependency and port shared delivery behavior to OMP consumer tests.
- Run retained behavioral tests directly, without a generated Claude diagnostics precondition. Add a maintained isolated real-broker/two-native-OMP smoke launcher.
- Register `agent_messaging_send` with plain JSON Schema, matching native OMP's tool contract independently of its TypeBox import shim.
- Drain queued deadline requests on terminal `agent_end` even while the owning prompt is unwinding; use native `followUp` until idle and preserve continuation ordering.

### Candidate evidence (2026-10-23)

- `npm ci --offline`: installed all 306 locked packages in the candidate worktree. npm reported seven dependency install scripts not covered by its local `allowScripts` policy. The smoke uses the installed native OMP runtime rather than npm's dependency-local Bun shim.
- `npm test --workspace @a4s/agent-messaging`: 71 passing tests, zero failures (including canonical settings and public consumers).
- `npm run typecheck --workspace @a4s/agent-messaging`: PASS.
- `npx tsx --test packages/omp-dagu/test/bundle-template.test.ts`: 11 passing CI/template tests, two existing live-Dagu tests skipped by their explicit environment gate. `node scripts/ci-workspaces.mjs changes`: selected canonical `@a4s/agent-messaging` and `@a4s/message-bus` manifests with both test/typecheck enabled.
- `A4S_AGENT_MESSAGING_SMOKE_MODEL=openai-codex/gpt-6.1-sol npm run verify:omp --workspace @a4s/agent-messaging` with `OMP_BIN=<temporary-auth-wrapper>`: PASS on native OMP 18.12.6. The wrapper copied only `config.yml` into each isolated temporary agent directory and symlinked the existing `agent.db`; no credential files were copied and the production profile was unchanged.
- Live acceptance passed: canonical broker and two origin-derived native session addresses, package-root loading, canonical settings/commands, actual model tool request, one recipient delivery with correlated delivered/completed and `A4S_424_FINAL`, busy terminal queue delivery with `QUEUE_DONE`, persisted pending resume/deduplication with `RESUMED_ONCE`, mechanical offer/claim/assignment with one assigned-request model turn and `OFFER_DONE`, and unsupported-version rejection before delivery.
- Canonical observer replay rendered 17 messages; all 54 inspected diagnostic records used `a4s.log/1`, service `@a4s/agent-messaging` and scope/event prefix `a4s.agent-messaging.omp`. Temporary profiles, sessions, broker state and auth wrapper were removed after inspection; processes exited and the broker port was released. This is the isolated package proof; combined v1-candidate acceptance remains separate.
