# @a4s/message-bus

A private, independently started loopback MQTT application with Aedes and durable
LevelDB state. This application owns the broker process and database. Messaging
adapters connect to it; they do not start it. Distribution is local to this
repository and its private installations.

## Run locally

Requires Node.js 22.19 or later and the repository's installed dependencies. From
the repository root:

```sh
npm run bus --workspace @a4s/message-bus -- 0 --db /tmp/a4s-message-bus-dev-db
# The root forwarding command accepts the same arguments:
npm run bus -- 1885 --db /path/to/state

npm test --workspace @a4s/message-bus
npm run typecheck --workspace @a4s/message-bus
```

The local package executable is `message-bus`:

```sh
message-bus [port] [dbdir] [--db <directory>]
A4S_MESSAGE_BUS_DB=/path/to/state A4S_MESSAGE_BUS_PORT=1885 message-bus
```

The listener binds exclusively to `127.0.0.1`. Port `0` requests an available
port. `BROKER READY :<actual-port> db=<directory>` is printed only after binding
the listener, opening LevelDB and initializing Aedes. An occupied port produces
`BROKER ALREADY RUNNING :<port>` and exit code 0 before the second process touches
the database. That line reports a reserved listener, not an authenticated peer or
an inspection of the process occupying it. `SIGINT` and `SIGTERM` close the
listener, broker and database cleanly.

Database precedence is `--db`, the second positional argument,
`A4S_MESSAGE_BUS_DB`, then the platform default:

- macOS: `~/Library/Application Support/a4s/message-bus/mqtt-db`;
- Linux: `${XDG_STATE_HOME:-~/.local/state}/a4s/message-bus/mqtt-db`.

The positional port takes precedence over `A4S_MESSAGE_BUS_PORT`, whose default
is `1884`. The database directory is restricted to the current user (`0700`)
where the filesystem supports it. Each LevelDB directory has one broker owner.
A database initialization failure exits nonzero; durable transport is required.

## Wire agreement

The broker transports payload bytes transparently. The existing messaging
agreement publishes to `synagent/v2/<to>` and adapters subscribe to
`synagent/+/<to>` for version-aware handling. Canonical envelope fields, message
kinds, delivery events and correlation remain adapter responsibilities. The
`synagent` topic namespace is wire data, independent of the package and bin names.
MQTT persistent sessions and QoS 1 provide queued delivery across a broker
restart when clients keep their durable session identity and subscription.

## Private operational logging

JSONL records are separate from stdout/stderr at
`${XDG_STATE_HOME:-$HOME/.local/state}/a4s/log/message-bus/<instance>/operational.jsonl`.
`A4S_MESSAGE_BUS_LOG_DIR` overrides only the log root.
`A4S_SERVICE_INSTANCE_ID`, `A4S_OPERATION_ID` and `A4S_CORRELATION_ID` set the
corresponding identifiers; missing values are generated. Records retain the
`a4s.otel.rca.log.v1` schema, service `@a4s/message-bus`, and scopes
`a4s.message-bus` / `a4s.message-bus.broker`.

The logger normalizes instance IDs to one path component, checks lexical and
real-path containment, and validates directory/file types and inode identity.
It requires a real instance directory (`0700`) and a regular log file (`0600`),
opening in append mode with `O_NOFOLLOW` where available and applying descriptor
permissions before writing. If secure logging cannot be established, records
are dropped with loss accounting. A portable path-replacement TOCTOU window
remains; the checks are not a filesystem sandbox.

Records contain OTel-aligned severity, resource/harness identity, correlation,
flush/loss status, allowed error phase and error taxonomy. Startup, readiness,
occupied-port, shutdown and error events are recorded. External exception
messages, stack traces, MQTT payloads, tokens, environment contents, full argv
and database paths are excluded from these records. Protocol stdout retains
`BROKER READY` and `BROKER ALREADY RUNNING` as process contracts.

`a4s.logging.flush_status=sync_requested` indicates that the following close
requests `fsync`; individual records otherwise do not request a sync. An `fsync`
failure cannot retroactively change a record already written.

## One-time local data and configuration migration

Perform this cutover with the broker stopped. The operator stops the existing
broker and any automatic restart mechanism, waits for its clean shutdown, and
keeps it stopped throughout the move. Preserve the **entire** LevelDB directory,
including journals and metadata; individual database files are not a migration
unit. A stopped-directory backup retains an independent recovery copy.

The former default directories map as follows:

| Platform | Existing directory | Canonical directory |
| --- | --- | --- |
| macOS | `~/Library/Application Support/a4s/synagent/mqtt-db` | `~/Library/Application Support/a4s/message-bus/mqtt-db` |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/a4s/synagent/mqtt-db` | `${XDG_STATE_HOME:-~/.local/state}/a4s/message-bus/mqtt-db` |

For example, on macOS, after shutdown:

```sh
old_db="$HOME/Library/Application Support/a4s/synagent/mqtt-db"
new_db="$HOME/Library/Application Support/a4s/message-bus/mqtt-db"
backup="$old_db.backup-$(date +%Y%m%d%H%M%S)"
test -d "$old_db" && test ! -e "$new_db" && test ! -e "$backup" &&
  cp -a "$old_db" "$backup" &&
  mkdir -p "$(dirname "$new_db")" &&
  mv "$old_db" "$new_db"
```

On Linux, set `old_db` and `new_db` from the table and perform the same
stopped-directory backup and move. If the destination already contains data,
resolve which complete database is authoritative before the cutover; combining
two LevelDB directories is not supported. For a custom `--db` or configured
state directory, the operator can retain that directory and point the canonical
configuration at it, with the same single-owner shutdown boundary.

Update the operator-owned shell, local launcher or service configuration in the
same cutover:

| Previous configuration | Canonical configuration |
| --- | --- |
| `@a4s/synagent-bus` package / `synagent-bus` executable | private `@a4s/message-bus` package / `message-bus` executable |
| `SYNAGENT_PORT` | `A4S_MESSAGE_BUS_PORT` |
| `SYNAGENT_DB` | `A4S_MESSAGE_BUS_DB` |
| `A4S_SYNAGENT_BUS_LOG_DIR` | `A4S_MESSAGE_BUS_LOG_DIR` |

Use the canonical keys and executable for the restarted process. The runtime
reads those names directly. Existing private log archives may remain in place;
new logs use the canonical root or the configured override. Start one broker
against the migrated directory, observe `BROKER READY` with its actual port and
path, reconnect the messaging adapters, and verify durable queued delivery.
Retain the stopped backup until the operator has validated the cutover.

## Verification evidence and joint acceptance

The extraction's targeted command ran both existing suites using
`node --test --test-concurrency=1 test/*.test.cjs`: **14 tests passed**. The syntax
checks remained `node --check broker.cjs && node --check logging.cjs` and passed.
The suites exercise canonical configuration, real MQTT, secure diagnostics,
private-prefix installation of the real bin, occupied-port handling and queued
delivery after a same-directory restart.

An isolated actual CLI smoke observed readiness on port `62062`, real MQTT
publish/subscribe on `synagent/v2/a4s-425/receiver`, `BROKER ALREADY RUNNING` for a
second process on that same port and database, and durable queued delivery after
restart on port `62081`. Root forwarding and canonical environment overrides
started a third isolated broker with private logs. Raw command/stdout/log and
assertion evidence is in
`/var/folders/h9/t8rlct3n72q_2_bfj8zcjsb00000gn/T/a4s-425-smoke-vnzOGa/evidence.json`.

Two real isolated OMP processes also loaded the real messaging adapter and used
the moved broker for two-way `task.cancel` control messages. A temporary native
command invoked the actual registered `synagent_send` implementation; both peers'
native entries recorded the received message IDs, and return traffic preserved
correlation/causation. No broker or peer was replaced. Raw commands, native RPC
input/output, wire messages and native receiver entries are in
`/var/folders/h9/t8rlct3n72q_2_bfj8zcjsb00000gn/T/a4s-425-native-JQmg4U/evidence.json`.
This is transport/control-flow evidence, **not full joint task acceptance**.

The model-backed `task.request` → `task.delivered` → `task.completed` OMP-to-OMP
smoke remains pending an independently authorized model endpoint/credential.
The preserved native rejection is `No API key found for openai.`, with
`agentInvoked:false`, in `/tmp/a4s-421-native.SimSz9/evidence.json` (also recorded
in [issue #421](https://github.com/pablontiv/a4s/issues/421#issuecomment-6299601670)).
That known rejected turn was not retried. Native slash commands can run before
model authorization, but normal inbound task delivery starts a real model turn;
the two-way cancellation probe does not establish that missing criterion.

## Security boundary

The application is a loopback-only local transport. Authentication, TLS and ACLs
are outside its current contract: any local process can publish and impersonate
a sender. Remote use requires an authenticated, authorized transport boundary.
MQTT persistence is queued transport, not historical replay, event sourcing,
high availability or a fenced semantic acknowledgment.
