# Private installation and workspace development

The [source catalog](../architecture/catalog.md) identifies owners and host
qualifiers. npm package names are private workspace identities. The public GitHub
repository does not imply public npm publication. Non-lifecycle source-linked
packages need a durable pinned checkout. The deployed lifecycle engine and plugin
instead come from a verified tagged release, never an installed source checkout.

## Prerequisites and development

- Node.js as pinned in root `package.json` `engines.node`, npm workspaces and
  access to the lockfile's exact dependencies, including for standalone consumers.
- Native OMP for OMP integrations; review-routing's host compatibility and Bun
  requirement are in its manifest's `peerDependencies` and `engines.bun`.
  npm installs its `devDependencies.bun` pin for tests.
- Dagu 2.24.0 for native first-attempt evidence, Git, authenticated `gh`, `jq`,
  Bash and Node for the real gate preload. Install the separate stable launcher
  below and link/load a verified payload's complete extracted root.
  Python `fcntl` is required only by Node/tsx development tests, not the engine.
- Semantic role jobs use the station's `omp` from the service/bootstrap PATH,
  not Bun or an installed OMP source tree. The executing release ships the pinned
  runner and `triage-reviewer`; the host discovers shared `task`. Run
  `a4s role-jobs detect` to check host modules and agent sources without a host
  model turn. Service PATH and activation remain operator-owned. See [cutover](deployment.md#identity-and-adoption).
- Orca installed/running and a bound coordinator pane for Orca integration's
  actual worker lifecycle proof. Configure managed-worktree setup to run the
  repository hook and wait for its installation before checking code.
- The messaging broker is an independently started service. Each durable
  LevelDB directory has one owner. Model-backed smokes need separately authorized
  model authentication, not merely an installed CLI.

From the selected checkout:

```sh
bash scripts/bootstrap.sh # root orca.yaml delegates to this npm ci hook
npm test
npm run typecheck
```

The root and CI gates run all nine workspace test suites and eight declared
typechecks. The tool-row workspace runs transpiled behavioral tests; its optional
Pion host supplies the renderer types for host-side development. Default tests
select only top-level test files and preload `scripts/test-no-spawn.mjs`, which
rejects child commands other than direct `git`/`tar`; they do not run native CLIs,
YAML shell steps, builds or timing acceptance. `test/live/` is never selected by
`npm test`, even with `A4S_LIVE_DAGU=1`.
Before a package release, run
`A4S_GATE_JOURNAL= npm run test:live --workspace @a4s/issue-lifecycle`
with a supported Dagu runtime on `PATH`. That command sets the live opt-in,
omits the spawn guard and retains the heavy slot. Keep the service's canonical
`DAGU_HOME` in the invoking shell so the wrapper shares the station-wide lock
before the test preload isolates `HOME` and `DAGU_HOME` per process. That
orchestration lock is the single explicit exception; fixtures and subprocess
artifact caches stay isolated, including `~/.dagu` fallbacks. Messaging and
message-bus also expose explicit `test:live` scripts for their real CLI scenarios.
CI discovers current workspace manifests and transitive consumers, handles both
sides of renames, and aggregates workspace checks and PR-body validation into
`validate` for `main`.

## Stable launcher installation

Choose a reviewed immutable release, download `a4s-launch-<platform>.tar.gz` and
its `.sha256`, verify the SHA-256 before extraction, and use an operator-owned
staging directory outside the source checkout. This independent compiled binary
contains the release repository and launcher protocol, not a payload identity.
Install `a4s-launch` on the service user's PATH and make `a4s` select it, initialize
with a trusted exact payload tuple, then validate/review/install the archive's
`reconcile.yaml` (single step `a4s tick`). The launcher writes only runtime cache
state; it never writes station/service configuration, installs the DAG, or
restarts Dagu. Follow the
[exact operator commands](deployment.md#install-the-stable-launcher-tick-dag-and-release-plugin).

Launcher changes require operator reinstall. `a4s launcher-version` reports its
protocol/readable schemas; unsupported state schemas and payload protocols report
`reinstall a4s-launch`. `a4s state` and `a4s rollback` are launcher-owned even if
current cannot start. Ticks require readable native Dagu first-attempt evidence:
missing retry bindings fail closed and are never repinned.

## Whole-package OMP loading

Run from the intended consumer checkout. The lifecycle package root is the
verified extracted release directory, containing `a4s`, `identity.json`,
`package.json`, `src/`, `agents/` and `skills/`:

```sh
omp --no-extensions \
  -e <absolute-release-root> \
  -e <absolute-source-checkout>/packages/review-routing
```

More generally, `omp -e <absolute-package-directory>` is the supported one-off
package-root loader. The lifecycle root discovers both extension entries, its
agents and package skills together. Root utility skills and generic native
roles have separate installation below. `--no-extensions` suppresses ambient
extension registration; it does not disable native agent or skill discovery.
`DAGU_URL` is the actual server root (default `http://127.0.0.1:8080`), and
`DAGU_HOME` must identify that controller's store/config. The scheduler
environment sets `A4S_PRIMARY` to that station's main checkout so lifecycle
renders can resolve `PRIMARY` without a machine path in the bundle. A
per-checkout file `$DAGU_HOME/primaries/<workspace>` or the single-checkout
file `$DAGU_HOME/a4s-primary` is the same binding when the variable is unset.
Consumer policy comes only from committed `.workspace/dagu/config.json`, schema
2 without `uses`; new builds read schema 1 but ignore its legacy selection.
New admissions use `state.current`; successors and actions use the target receipt
tuple. The launcher restores and verifies missing exact immutable releases and
execs their cached binary with a process lease through payload exit. Snapshots
bind absolute `A4S_BIN`; corrupt entries and unavailable releases fail closed.

The operator owns queue capacity in Dagu config, service environment and
activation. a4s never writes station configuration/service units or restarts
Dagu. `a4s queue --lane <lane>` checks initial readiness; afterwards use
`a4s queue <primary>/.workspace/dagu/config.json`. Bootstrap authors policy and
checks readiness, not DAG installation or service repair.

For an authorized persistent lifecycle installation:

```sh
omp plugin link <absolute-release-root>
```

Initial/model-changing cutover closes admission and establishes zero nonterminal
runs and zero open role jobs. Select the intended compiled `omp` on the service
PATH, verify `a4s role-jobs detect`, and provision queues, the stable launcher
and single-step tick DAG. Remove obsolete links/PATH entries only after
references clear. Restart OMP to load the release plugin; service activation
remains exclusively the operator's. Ordinary payload promotion uses state, not
per-consumer or scheduled exact-release pins. Follow the complete
[cutover procedure](deployment.md#identity-and-adoption) and
[launcher/tick installation](deployment.md#install-the-stable-launcher-tick-dag-and-release-plugin).
`omp plugin link` must replace the old lifecycle checkout registration: the
service user's `~/.omp/plugins/node_modules/@a4s/issue-lifecycle` must resolve to
the verified extracted release root, and its managed `omp-plugins.lock.json`
entry must record that release's actual manifest version and directory source,
not `0.5.25` or PRIMARY's package directory. Preserve unrelated entries and let
the installed plugin manager maintain its lock schema. Restart OMP and retain
resolved-path, lock-entry and whole-package load evidence; no such station
changes are performed by the engine.

Both manifest extension paths (`./src/status/reloadable.ts` and
`./src/triage/reloadable.ts`) ship in the archive and select adjacent `a4s`.
For existing-run mutations the plugin requires declared dispatch protocol
`a4s-run/1`, checks receipt/config, checkpoint-protocol and role-job-store
compatibility and dispatches the run's cached executable, not the plugin's version.
HUD rows can show both releases
and flag unsupported receipts read-only; triage, protection, role dispatch and
HUD receipt writes reject unsupported/missing artifacts before mutation.

Other source-linked packages keep their selected checkout available; never use
a soon-to-be-deleted issue worktree. Native resource refresh alone does not prove
changed module bytes loaded; see [hot-reload limitations](../../packages/hot-reload/README.md).

For the host-neutral Context Management library, a private TypeScript-aware
consumer can use `npm install <absolute-package-directory>/packages/context-management`
and import `@a4s/context-management`; see its
[direct input/output example](../../packages/context-management/README.md).
For the broker, use `npm run bus --workspace @a4s/message-bus -- 1884 --db <private-state-directory>`.
Its [runbook](../../apps/message-bus/README.md) covers single-owner state migration.

## Native roles

Install canonical `.omp/agents/<role>.md` sources in the private consumer's
`.omp/agents/` root; [agents](../architecture/agents.md#private-consumer-installation)
contains the exact six-role link recipe and native source precedence. A new OMP
process selects changed definitions. Record `agentSource` and compare the child
prompt to the selected canonical definition: a same-named bundled role is not
candidate-source evidence. The catalog file itself is not installed as a role.

## Independent skills

Keep the complete directory, including relative scripts/assets and attribution,
under its own root ownership. A private consumer can install selected skills in
its native project skill root without moving them into the lifecycle package:

```sh
A4S_ROOT=<absolute-pinned-source-checkout>
CONSUMER=<absolute-private-consumer-checkout>
mkdir -p "$CONSUMER/.omp/skills"
for skill in model-routing-audit gpt-quota-audit cost-analyzer agent-throughput workspace-hygiene sandbox-threat-model; do
  ln -s "$A4S_ROOT/skills/$skill" "$CONSUMER/.omp/skills/$skill"
done
```

Existing destinations need operator resolution; plain `ln -s` preserves them by
failing. Alternatively set native `skills.customDirectories` to the absolute
A4S `skills` directory in the **consumer's** or isolated profile's config. This
loads independent roots alongside the lifecycle package's seven skills.
`--skills <csv>` filters discovered names, not paths. Read
`skill://model-routing-audit` (or another delivered skill) and execute only the
bounded, authorized operation it describes. Invocation can be a read-only
resource resolution or a script's `--help`; it does not imply a quota-policy
change or provider experiment. Pending #311 resources have destinations, not
installed skill invocations.

## Isolated native walkthrough

Create the temporary profile and sessions outside the repository. Copy only the
existing config and symlink its authorized authentication database; credentials
remain in place. Adjust routes only inside the temporary copy to tool-capable,
authorized models. In the observed print-mode OMP runtime, `task,wait` was needed for asynchronous
child completion; `cursor/*` routes do not run tools in this environment.

```sh
A4S_ROOT="$(pwd -P)"
SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/a4s-v1-smoke.XXXXXX")"
SMOKE_AGENT_DIR="$SMOKE_ROOT/agent"
SMOKE_SESSIONS="$SMOKE_ROOT/sessions"
mkdir -p "$SMOKE_AGENT_DIR" "$SMOKE_SESSIONS"
cp "$HOME/.omp/agent/config.yml" "$SMOKE_AGENT_DIR/config.yml"
ln -s "$HOME/.omp/agent/agent.db" "$SMOKE_AGENT_DIR/agent.db"
# Edit only the temporary config: disabledProviders: ["claude-plugins"];
# skills.customDirectories: ["<absolute-A4S_ROOT>/skills"].
PI_CODING_AGENT_DIR="$SMOKE_AGENT_DIR" \
PI_CODING_AGENT_SESSION_DIR="$SMOKE_SESSIONS" \
  omp --no-extensions --cwd "$PWD" \
  -e "$PWD/packages/issue-lifecycle" -e "$PWD/packages/review-routing"
```

In that process, read available `skill://` resources, run `/workflows`, and ask a
canonical `reviewer` child for a bounded read-only source check. A review-routing
policy may require the child outside both parent and `@task` families; provide
eligible routes in the temporary config rather than weakening the policy.
Persist parent/child sessions, selected `agentSource`, canonical prompt prefix,
resolved model and actual tool results. The
[walkthrough evidence](v1-walkthrough.md) separates this from deployment.
After retaining redacted evidence, stop owned temporary processes and remove
`SMOKE_ROOT`. Production configuration, credentials, links and services remain
operator-owned throughout. Spike #693 compared 1Password for Agents with this
rule and discarded product adoption and a secret-injection skill; see
[1Password Agents](../architecture/onepassword-agents.md).
