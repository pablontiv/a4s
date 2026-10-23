# @a4s/agent-messaging

Private A4S messaging for native OMP sessions. The package owns the canonical protocol, MQTT transport, reloadable OMP extension, shared session delivery/recovery/arbitration, settings, observer and diagnostics. The independently runnable [`@a4s/message-bus`](../../apps/message-bus/README.md) owns the broker process. Loading the adapter connects to the broker; it never starts one.

## Load and operate

From a checkout with dependencies installed, start the broker separately and load this package root:

```sh
npm start --workspace @a4s/message-bus
omp -e /absolute/path/to/a4s/packages/agent-messaging
```

The extension derives its project from the session cwd's `remote.origin.url`, and uses the native persisted OMP session ID without rewriting it. A missing or invalid origin leaves messaging inactive and reports the remediation. Two sessions therefore have distinct canonical addresses even when they share a checkout.

The model-facing tool is `agent_messaging_send`, registered with a plain JSON Schema object for native OMP validation. Supply an explicit `to` address and `body`; `kind` defaults to `task.request`. Supported model-sendable kinds are exported as `AGENT_MESSAGING_SEND_KINDS`. Delivery/completion events and offer/claim coordination are adapter-owned operations, not extra model turns.

Commands:

- `/agent-messaging status`: identity, connection and effective settings.
- `/agent-messaging enable` / `disable`: persist the enabled setting.
- `/agent-messaging set <key> <value>`: update a user-scoped setting.
- `/agent-messaging resume`: override a blocked delivery ordering barrier.
- `/agent-messaging pending`, `cancel <id>`: inspect and cancel tracked requests.
- `/agent-messaging offer <text>`: broadcast an offer; eligible idle sessions claim mechanically, and the offerer assigns only the first claim.
- `/agent-messaging dlq`, `dlq retry <id>`: inspect dead letters and explicitly reinject a failed delivery.
- `/agent-messaging-settings`: interactive settings editor, including per-setting reset.
- `/mq-send <project>/<session>: <text>`: functional debug request send.
- `/mq-send <text>`: shorthand send, available after explicitly setting a canonical default peer.

```text
/agent-messaging set default-peer my-repo/native-session-id
/mq-send Check the current build result.
```

Explicit tool destinations keep their existing protocol semantics; the configured peer only supplies the missing destination for command shorthand.

## Configuration

The canonical file is `agent-messaging.json` in `PI_CODING_AGENT_DIR`, or `~/.omp/agent` by default. Updates are atomic and private (`0600`). The native file uses these short keys:

```json
{
  "enabled": true,
  "broker-url": "mqtt://127.0.0.1:1884",
  "global": true,
  "default-peer": "my-repo/native-session-id",
  "request-ttl": 120,
  "accept-offers": false
}
```

`default-peer` and `request-ttl` are optional. The default peer must be an explicit canonical address. TTL is a positive finite number of seconds. The broker must be unauthenticated loopback MQTT. Environment overrides are `A4S_AGENT_MESSAGING_BROKER_URL` and `A4S_AGENT_MESSAGING_REQUEST_TTL`. When embedding these options in a prefixed settings surface, use `a4s.agent-messaging.<key>`; the native JSON file itself uses the short keys above.

OMP imports `@earendil-works/pi-coding-agent` for its supported extension/session API and retains that dependency. `PI_CODING_AGENT_DIR` and the native session directory variables are host API names rather than product aliases.

## Delivery and wire contract

The existing broker agreement is unchanged: canonical v2 `id/from/to/kind/body/ts`, optional `reply_to/correlation_id/causation_id/deadline`, existing kinds, QoS 1, publication on `synagent/v2/<to>`, version-observing subscriptions on `synagent/+/<to>`. Unsupported versions are rejected before parsing or model delivery. The origin-derived project and native session identity remain the addressing source.

Session recovery preserves the persisted entry identities `synagent-delivered`, `synagent-pending`, `synagent-request`, `synagent-offer`, `synagent-dlq`, `synagent-dlq-retry`, `synagent-state` and the `[synagent-delivery ...]` marker. Durable MQTT client IDs are preserved as transport state. These strings are technical persistence/wire contracts and allow pending delivery resume and duplicate suppression across the cutover.

Busy requests with deadlines remain in the adapter queue until terminal `agent_end`; intermediate events with `willContinue: true` or `isTerminal: false` preserve the ordering barrier. A terminal notification releases the next request even when OMP's owning prompt has not yet unwound and `ctx.isIdle()` is still false; delivery then uses native `followUp`. Delivery confirmation, completion capture, DLQ and arbitration all use the shared session engine. A repeated persisted message ID opens one recipient turn.

Diagnostics identify the service as `@a4s/agent-messaging`, with `a4s.agent-messaging.*` scope/event names. Private bounded JSONL files are under `$A4S_STATE_ROOT/log/agent-messaging/omp`, or `$XDG_STATE_HOME/a4s/log/agent-messaging/omp` (default `~/.local/state/a4s/...`). Diagnostic records exclude message bodies, broker URLs and raw session identifiers.

## Observer

```sh
npm run observer --workspace @a4s/agent-messaging -- --help
npm run observer --workspace @a4s/agent-messaging -- --output /tmp/agent-messaging-wire.jsonl
npm run observer --workspace @a4s/agent-messaging -- --replay /tmp/agent-messaging-wire.jsonl
```

The observer uses the same OMP agent-dir configuration and subscribes to `synagent/#`. Its captures contain exact wire payloads and may contain private message content: choose a private destination and retain it according to your own data policy. Causal/reply/correlation grouping preserves receipt order and duplicates; replay reads the same capture format.

## One-time operator migration

Stop or reload affected local extensions deliberately; keep the original session storage intact.

1. Update local OMP extension lists and launch scripts from `packages/synagent/core` / `@a4s/synagent` to this package root / `@a4s/agent-messaging`. The package root exports the reloadable OMP adapter. Review explicit `-e` arguments, automation commands and local extension registration lists together.
2. Move the operator's previous `synagent.json` configuration into `agent-messaging.json` in the selected OMP agent directory. Retain the short native setting keys. Convert retained prefixed settings from `a4s.synagent.<key>` to `a4s.agent-messaging.<key>`. Pi-only settings stores belong to the preserved legacy source; manually select the values intended for OMP instead of copying an unrelated host profile.
3. Set `default-peer` to the intended canonical `project/native-session-id`; select the actual peer rather than inheriting the removed-host default `claude`. You can omit it when all sends have explicit destinations.
4. Rename the broker/TTL environment variables to `A4S_AGENT_MESSAGING_BROKER_URL` and `A4S_AGENT_MESSAGING_REQUEST_TTL`.
5. Update prompts/tool allowlists from `synagent_send` to `agent_messaging_send`, and commands from `/synagent` and `/synagent-settings` to `/agent-messaging` and `/agent-messaging-settings`. Keep `/mq-send` for debug sends. Update observer launches to the single OMP settings scope and canonical workspace.
6. For TypeScript consumers, import `createAgentMessagingOmp`, `createAgentMessagingAdapter`, the `AgentMessaging*` public types and `AGENT_MESSAGING_*` constants from their canonical package modules. The root loader remains the OMP reloadable extension.
7. Reload, check `/agent-messaging status`, and send an explicit debug request to the intended session. Keep persisted session entries and technical wire names unchanged.

This is an operator-controlled local migration, not an automatic profile rewrite. Historical source is preserved in legacy. Repository workspace scripts, package links, observer reader, smoke launcher and CI-workspace fixtures move atomically in this change; private operator extension lists and credentials remain under operator control.

## Verification

```sh
npm test --workspace @a4s/agent-messaging
npm run typecheck --workspace @a4s/agent-messaging
A4S_AGENT_MESSAGING_SMOKE_MODEL=provider/model npm run verify:omp --workspace @a4s/agent-messaging
```

Tests directly run retained `tsx --test test/*.test.ts`; typecheck is `tsc --noEmit`. Behavioral coverage includes protocol/conformance, native OMP lifecycle, shared queue/recovery/deduplication, private canonical settings, offer arbitration, observer and canonical diagnostics. Public consumer checks import and execute the renamed APIs.

The slice smoke starts the real canonical broker with isolated state and launches two fresh native OMP RPC processes from the candidate cwd, using explicit package-root loading, temporary agent/config directories and persisted temporary sessions. The native OMP executable must already be installed (`OMP_BIN` optionally selects it). Temporary settings disable `claude-plugins`, and repository skills remain discoverable via `skills.customDirectories`. It inherits only the environment supplied by the operator; it does not copy an existing credential store or modify a production profile. Supply an independently authorized model API key in that environment and select its model with `A4S_AGENT_MESSAGING_SMOKE_MODEL` (default `openai/gpt-4.1-mini`).

Evidence is retained at the printed `EVIDENCE` directory: exact native arguments, RPC input/output, session JSONL, diagnostics, broker output and observer capture. The script verifies canonical settings/commands and unsupported-version rejection before requiring a model response. It then verifies the actual tool, one recipient turn and final reply with correlated delivered/completed events, busy terminal queue release, pending resume/deduplication and mechanical offer arbitration. A missing model credential is a live-acceptance blocker, not a passing proof; the retained unit tests do not replace it. The final combined v1-candidate proof verifies both migrated package identities together.
