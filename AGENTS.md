# A4S operating contract

## Scope and resources

A4S is a private npm monorepo with libraries/extensions in `packages/`, the
independent broker in `apps/message-bus/`, native roles in `.omp/agents/`, package
skills in `packages/issue-lifecycle/skills/`, and independent skills in `skills/`.
Preserve each host's contracts and the affected workspaces' behavioral tests.

- [README](README.md): entry points and delivered components.
- [Source catalog](docs/architecture/catalog.md): ownership and delivered/pending assets.
- [Agent catalog](docs/architecture/agents.md): conceptual roles versus canonical runtime definitions.
- [Lifecycle architecture](docs/architecture/issue-lifecycle.md): actual identity and advisory boundaries.
- [Private installation](docs/operations/private-install.md): prerequisites, native loading and local development.
- [Deployment/recovery](docs/operations/deployment.md): lanes, authorization, shared controller and active runs.
- [Execution skill](packages/issue-lifecycle/skills/issue-execution/SKILL.md): executable feature/PoC contract.

## Setup and checks

Root `orca.yaml` delegates setup to the versioned bootstrap. From any directory:

```sh
bash scripts/bootstrap.sh
```

Run the full gate from the assigned worktree root after setup completes:

```sh
npm ci && npm test && npm run typecheck
```

Use the Node.js requirement in root `package.json` `engines.node` and the shared
tools in its `devDependencies`; access to locked registry dependencies is required. Root
and CI gates run all workspace tests and the eight declared workspace typechecks.
The optional-host tool-row workspace is test-only; its renderer types come from
the consumer's Pion host. Orca managed-worktree setup should run by default
(`--setup run` when explicitly required). Its setup terminal can remain active
after worktree creation returns; wait for it.
Default workspace scripts preload `scripts/test-no-spawn.mjs` and select only
top-level tests, excluding `test/live/`. They exercise logic in-process, allowing
only direct `git`/`tar` child commands; the default gate is unslotted. Native CLI,
YAML, compiled-release, OS-lock and timing scenarios require explicit workspace
`test:live` (or lifecycle `test:compiled`) commands and isolated temporary state.

Real integration acceptance requires the corresponding native hosts, broker,
pinned Dagu and authorized model credentials; unit tests are a separate claim.

## Operational ownership

Work in the assigned issue worktree and preserve operator changes. Keep `npm ci`
reproducible; intentional dependency changes update manifests and lockfile
together. Preserve the Orca hook's delegation to the repository bootstrap.

The operator uses native OMP. Start coordination from the lane's clean independent
PRIMARY on its base branch; implement only in the assigned worktree. Preserve the
existing run/session owner, candidate and receipt through recovery. Publication,
push, PR, merge, adoption, local links/service/configuration and Dagu human-task
actions require explicit assignment authority; a local gate grants none.
Scheduled CI/merge observation belongs to the designated reconciler. Credentials
and external services remain operator-owned.

## Versioned source and configuration

Git versions source and configuration. That is content written through a pull
request, or generated deterministically from a versioned revision and declared
inputs so that regenerating it yields identical bytes. Changes to it land through
a commit, such as a version bump or an adoption.

Runtime state is written by a running process and carries per-execution data:
run identifiers, timestamps, process IDs, attempt counters, or observed external
state such as PR heads and check results. It lives under `.git/dagu-feature/runs/`
or `$DAGU_HOME`. Do not commit it.

Classify a file in three steps:

1. Identify its producer (a person through a pull request, a generator such as the
   bootstrap render step, or a running process such as a DAG step or observer) and
   the producer's declared inputs.
2. If a generator produces it, regenerate it twice at the same revision with
   identical declared inputs. Identical bytes make it configuration. A render that
   changes only because a declared input changed (bundle version, repository, queue)
   is still configuration.
3. A file whose content records an execution (run identifiers, timestamps, process
   IDs, attempt counters, or observed external state) is runtime state, regardless
   of format or how often it changed.

Hand-written test fixtures, and a pull-request document that quotes a finished
operation, stay source: their producer is the pull request. A process-owned
receipt, observation or status log is runtime state even when a broad commit
tracked it. The consumer config file `.workspace/dagu/config.json`, and hand-written manifests such as
`package.json` and `.workspace/config/refine.json`, are configuration. Generated per-run DAG snapshots are runtime state.
[Deployment](docs/operations/deployment.md) states the same rule beside adoption.

## Pull request descriptions

Every PR, including syncs, adoptions and manual fixes outside Dagu, uses `.github/pull_request_template.md`: `Closes #<N>` or `Refs #<N>`, at most five Summary bullets, one command/result per Verification line, and Risk notes or `None`. Use repository-relative paths or placeholders (`<primary>`, `<worktree>`, `~`, `$DAGU_HOME`); keep host absolute paths, usernames and private repository names out of public bodies. Logs stay in run artifacts. CI validates the required structure and host-path rule on PR events, including body edits.
