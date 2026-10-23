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

Node.js >=22.19.0 and access to locked registry dependencies are required. Root
and CI gates run all workspace tests and the seven declared workspace typechecks.
The optional-host tool-row workspace is test-only; its renderer types come from
the consumer's Pion host. Orca managed-worktree setup should run by default
(`--setup run` when explicitly required). Its setup terminal can remain active
after worktree creation returns; wait for it.
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

## Pull request descriptions

Every PR, including syncs, adoptions and manual fixes outside Dagu, uses `.github/pull_request_template.md`: `Closes #<N>` or `Refs #<N>`, at most five Summary bullets, one command/result per Verification line, and Risk notes or `None`. Use repository-relative paths or placeholders (`<primary>`, `<worktree>`, `~`, `$DAGU_HOME`); keep host absolute paths, usernames and private repository names out of public bodies. Logs stay in run artifacts. CI validates the required structure and host-path rule on PR events, including body edits.
