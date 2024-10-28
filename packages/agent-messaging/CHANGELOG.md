# Changelog

## Unreleased

- Move the private canonical package to `@a4s/agent-messaging` at `packages/agent-messaging`, retaining OMP reloadable loading, protocol, MQTT, shared session delivery/recovery/settings/arbitration, observer and canonical diagnostics.
- Publish the clean public surface `agent_messaging_send`, `/agent-messaging`, `/agent-messaging-settings`, `createAgentMessagingOmp`, `createAgentMessagingAdapter`, `AgentMessaging*` types and `AGENT_MESSAGING_*` constants; retain the functional `/mq-send` debug command.
- Read `agent-messaging.json` in the OMP agent directory and use `A4S_AGENT_MESSAGING_BROKER_URL` / `A4S_AGENT_MESSAGING_REQUEST_TTL`. Shorthand sends require an explicitly configured canonical peer. The README describes the one-time operator migration of local settings, extension lists, commands and prompts.
- Identify diagnostic service/scope/events as `@a4s/agent-messaging` / `a4s.agent-messaging.*`.
- Preserve broker v2 wire names, durable MQTT client IDs, native session entry keys and delivery markers for resume and deduplication.
- Remove exclusive Pi/Claude adapters, generated copies, loader declarations, settings readers, parity/sync machinery and host-only tests/scripts. Retain the native OMP SDK dependency and port shared delivery behavior to OMP consumer tests.
- Run retained behavioral tests directly, without a generated Claude diagnostics precondition. Add a maintained isolated real-broker/two-native-OMP smoke launcher.

### Candidate evidence (2026-10-23)

- `npm ci --offline`: installed all 306 locked packages in the candidate worktree. npm reported seven dependency install scripts not covered by its local `allowScripts` policy. The smoke uses the installed native OMP runtime rather than npm's dependency-local Bun shim.
- `npm test --workspace @a4s/agent-messaging`: 71 passing tests, zero failures (including canonical settings and public consumers).
- `npm run typecheck --workspace @a4s/agent-messaging`: PASS.
- `npx tsx --test packages/omp-dagu/test/bundle-template.test.ts`: 11 passing CI/template tests, two existing live-Dagu tests skipped by their explicit environment gate. `node scripts/ci-workspaces.mjs changes`: selected canonical `@a4s/agent-messaging` and `@a4s/message-bus` manifests with both test/typecheck enabled.
- `npm run verify:omp --workspace @a4s/agent-messaging`: actual standalone `@a4s/message-bus` plus two native OMP 18.12.6 processes loaded the candidate package root; both origin-derived native session addresses connected. Canonical status/default-peer commands persisted settings, `synagent/#` observation captured addresses, and a v99 request produced `VERSION_UNSUPPORTED` before delivery. Evidence: `/var/folders/h9/t8rlct3n72q_2_bfj8zcjsb00000gn/T/a4s-agent-messaging-smoke-CRc8jA`.
- Model-backed acceptance is BLOCKED, not passed: native OMP rejected the first actual tool-request prompt with `No API key found for openai`. No provider API-key/OAuth variables were present in the worker environment, and no production credential store was copied. Native RPC output retains the exact provider error. The launcher now surfaces native asynchronous prompt failures directly instead of waiting for a wire-message timeout.
- Still required with an independently operator-authorized provider credential: actual model tool request/final reply with delivered/completed correlation, busy terminal queue release, pending native session resume/deduplication and offer arbitration without offer/claim model turns. The retained behavioral suite covers these state transitions in isolation; it does not constitute this live proof. Run `A4S_AGENT_MESSAGING_SMOKE_MODEL=provider/model npm run verify:omp --workspace @a4s/agent-messaging` with that authorized environment to complete acceptance. The combined v1-candidate live proof remains a separate lifecycle gate.
