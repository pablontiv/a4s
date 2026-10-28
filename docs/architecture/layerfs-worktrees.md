# LayerFS and git worktrees (#694)

**Decision: descartar.**

The hypothesis was that LayerFS covers a real gap versus the git worktrees a4s
uses. The source post describes a filesystem that gives each agent a complete
writable Workspace on a shared history, without copying the base, and that lets
each agent commit in parallel. a4s already gives each issue a linked git
worktree under an independent PRIMARY, and it publishes through Git. The
ignored-file install that a worktree omits stays a lockfile boundary:
`npm ci` fills that checkout, and the station gate cache reuses a later test
or typecheck pass when that lockfile still matches.

## Evidence

The radar source is
https://x.com/CamilleRoux/status/2114733867739295888 (26 Oct 2026). The post
says LayerFS gives each agent a complete modifiable Workspace on shared
history without copying the base, that each agent commits in parallel, and
that 157 snapshots fit in 100 MB, 19.9 times less than Btrfs with zstd, under
an MIT license. The same comparison is specified in the
[compare](https://layerfs.ai/docs/compare/),
[concepts](https://layerfs.ai/docs/concepts/), and
[platform](https://layerfs.ai/docs/platform/) docs. The radar canvas page
returned 403 to this run.

[Compare](https://layerfs.ai/docs/compare/) says a git worktree checks out
tracked files only, so `node_modules`, build output, and caches are missing
and each new worktree installs again. A LayerFS Workspace includes those
files and `.git`. A mount copies nothing. Each `fs` write and each
`workspace.commit` is a Commit. Branches merge three ways. The same page's
157-snapshot sample of the DeepSeek harness is 4.94 GB of trees, 100.1 MB in
LayerFS, 1,994.6 MB on Btrfs with zstd, and 55.1 MB in a Git pack.
[Concepts](https://layerfs.ai/docs/concepts/) says `LayerFS.init` imports the
whole tree once, ignore rules included, into one SQLite store, and that
`branch.publish` overwrites main layers published since the fork unless the
caller merges first. A Workspace is a mount inside a Docker sandbox, at a
path such as `/workspaces/1`.
[Platform](https://layerfs.ai/docs/platform/) requires one Linux kernel and a
local ext4, xfs, or btrfs store. macOS reaches that store through a Docker
worker. Sandboxes are Docker containers. The SDK is linked from a LayerFS
checkout, not published as an npm dependency. The store profile is
Disposable: SQLite WAL with `synchronous=OFF`. Durability is not claimed; a
power loss can lose recent history, and the docs say to push Git for anything
that must survive. Agents on different machines cannot share one store.
History is never deleted. There is no garbage collection yet.

| LayerFS claim | What this repository already does |
| --- | --- |
| A new agent checkout should include ignored files without a copy | `start_gate` runs `git worktree add` for `.workspace/worktrees/issue-N` (`packages/issue-lifecycle/skills/issue-execution/feature.yaml`). `.gitignore` omits `node_modules/`. The adopted gate in `.workspace/dagu/answers.json` is `npm test && npm run typecheck`. A linked worktree reuses a stored test or typecheck pass from `<git-common-dir>/dagu-feature/gate-cache` when sources, the lockfile, the dependency graph, and the Node/npm identity match (`packages/issue-lifecycle/skills/issue-execution/SKILL.md`). A lockfile change is a cache miss and needs `npm ci`. |
| One shared store, including `.git`, for every agent on the host | PRIMARY is an independent clone: its Git directory equals its common Git directory (`docs/operations/deployment.md`, `feature.yaml` `admit`). The issue worktree must share that common directory and that path. Station executors clone with `--no-local`, refuse object alternates, and run `npm ci --ignore-scripts` (`packages/issue-lifecycle/src/station-executors.ts`). |
| Parallel commits and a three-way filesystem merge | One candidate is one private-index Git commit, then rebase and a PR. A conflicting rebase returns to `implement` with the conflict paths. Publication crosses machines through Git remotes. |
| A mount is enough isolation for another agent | Ownership is primary, worktree, branch, run, and session. `skills/sandbox-threat-model/references/boundaries.md` records that a separate Git worktree is not an OS sandbox. Queue `a4s=8` and the role-job capacity already bound how many runs proceed. |

Orca `worktree` commands inventory Git checkouts and Orca contexts
(`skills/workspace-hygiene/SKILL.md`). Review-routing overlays are native
settings files. Neither is a copy-on-write filesystem. The worktree factory
is `start_gate`; the coordinator does not call `git worktree add`.

## Why there is no skill

A skill that mounted a LayerFS Workspace would need the store, the Docker
sandbox, the native addon, and a single-host Linux filesystem. That is the
product. This spike compares it with the worktree model and does not rewrite
`start_gate` or the executor installer.

A skill that only copied `node_modules` into a new worktree would skip the
lockfile. The gate cache already reuses a pass when the lockfile matches.
`station-executors.ts` installs from the lockfile into a clone that does not
share Git objects. Those two paths are the pattern.

## Dogfood

Station admission is blocked by the Dagu pin hold. This CloudAgent change is
the decision record only. It leaves the Dagu pin, `.workspace/dagu/answers.json`,
station install, and #685 unchanged. LayerFS was not installed: no store, no
Docker worker, and no native addon. No feature or PoC run was admitted for it.
The worktree steps in `feature.yaml` are unchanged.
