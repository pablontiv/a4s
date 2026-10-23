# Private installation and workspace development

The [source catalog](../architecture/catalog.md) identifies owners and host
qualifiers. npm package names are private workspace identities. The public GitHub
repository does not imply public npm publication. Select a pinned source revision
and keep the checkout available for every source link.

## Prerequisites and development

- Node.js >=22.19.0, npm workspaces and access to the lockfile's exact dependencies.
- The private pinned `@pablontiv/pion` development tarball (release access or an
  intact npm cache) for the full local typecheck. CI's documented Pion-stripping
  installation is a different, bounded gate, not a full local substitute.
- Native OMP for OMP integrations; review-routing requires OMP >=18.12.5 and
  Bun >=1.3.14. npm installs the pinned development Bun used by its tests.
- Official Dagu 2.20.1 for lifecycle runtime; Git, authenticated `gh`, `jq`,
  Python 3 with `fcntl`, and Bash for bootstrap/execution. Semantic role jobs
  also require Bun and the installed OMP runtime.
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

The root gate visits all eight workspaces. Lifecycle's default tests force
`A4S_LIVE_DAGU=0`; selected real Dagu cases skip. Explicit live acceptance uses
`npm run test:live --workspace @a4s/issue-lifecycle` with the exact pinned runtime.
CI discovers current workspace manifests and transitive consumers, handles both
sides of renames, and aggregates workspace checks plus six pinned-Dagu partitions
into `validate` for `main` and `integration/v1`.

## Whole-package OMP loading

Run from the intended consumer checkout. Replace placeholders with absolute,
canonical directories from the selected source revision:

```sh
omp --no-extensions \
  -e <absolute-package-directory>/packages/issue-lifecycle \
  -e <absolute-package-directory>/packages/review-routing
```

More generally, `omp -e <absolute-package-directory>` is the supported one-off
package-root loader. The lifecycle root discovers both extension entries, its
agents and package skills together. Root utility skills and generic native
roles have separate installation below. `--no-extensions` suppresses ambient
extension registration; it does not disable native agent or skill discovery.
`DAGU_URL` is the actual server root (default `http://127.0.0.1:8080`), and
`DAGU_HOME` must identify that controller's store/config.

For an expressly authorized persistent user installation, from the durable
selected checkout:

```sh
omp plugin link <absolute-package-directory>
# For example, link the whole packages/issue-lifecycle directory, not src/status.
```

Link each desired extension package separately. Linked sources remain on disk;
use stable pinned source, not a soon-to-be-deleted issue worktree. Operator-owned
plugin registrations, service PATH, environment and model settings change only
under their own authorization. Re-link moved package roots deliberately and
restart OMP after lifecycle redeployment. Native `/reload-plugins` refreshes
builtin resources. The A4S hot-reload wrapper refreshes supported existing
implementation generations and defers busy reload through `agent_end`; changed
shims/helpers/package bindings, new TypeScript modules, bare dependencies and
registration/schema changes require restart. Discovery refresh is not proof that
new module bytes loaded. See the [bounded helper evidence](../../packages/hot-reload/README.md).

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
for skill in model-routing-audit gpt-quota-audit cost-analyzer agent-throughput; do
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
authorized models. In print mode OMP 18.12.6 needs `task,wait` for asynchronous
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
operator-owned throughout.
