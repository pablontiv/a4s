# Changelog

## Unreleased

- Move the private durable broker to `apps/message-bus` as `@a4s/message-bus`, with the `message-bus` executable and coherent root workspace, lockfile, forwarding, CLI consumer and CI routing.
- Use `A4S_MESSAGE_BUS_PORT`, `A4S_MESSAGE_BUS_DB` and `A4S_MESSAGE_BUS_LOG_DIR`, canonical state/log paths, and `@a4s/message-bus` / `a4s.message-bus[.broker]` diagnostic identities.
- Preserve loopback Aedes/LevelDB transport, process readiness/shutdown contracts, the payload-transparent `synagent/v2/<to>` wire agreement, generic correlation identifiers and the `a4s.otel.rca.log.v1` schema.
- Document the stopped-broker, full-LevelDB backup/move and local configuration cutover in English.
- Verify 14 targeted tests and syntax checks, actual CLI MQTT round-trip/restart/queued delivery, occupied-port single ownership, canonical environment overrides and private logs. Two real OMP peers exercised native two-way cancellation transport; model-backed task request/completion joint acceptance remains pending the preserved independent-credential prerequisite.
- Remove the terminal-workspace plugin integration so the package contains only the standalone MQTT broker and its operational logger.
