---
name: workspace-hygiene
description: "Audit and clean the current session's own repository: preserve live WIP and stash variants, publish approved work as a PR, and verify approved cleanup."
---

# Workspace hygiene

Inventory the current session's own repository, preserve valuable work, and propose an explicit cleanup action table. Auditing is read-only; cleanup and publication require separate operator approval. A clean result is an observed outcome, not an assumption.

Run when the user asks to audit or clean worktrees, branches, stashes or Orca contexts. For a multi-repository request, hand each foreign repository to its owning session through the current OrcaCLI's version-matched session handoff command. Its owner performs inventory, recovery and cleanup and returns evidence; this session operates only its own repository.

## Read-only inventory

Read `skill://orca-cli`, resolve its executable once, and load that executable's version-matched guide with `ORCA skills get orca-cli --json` before using Orca. Here `ORCA` means that resolved executable (normally `orca` on macOS), not a new shell variable. Use only supported commands and flags; consult its `--help` when needed. The following examples assume the selected executable is `orca`.

```sh
orca repo list --json
orca worktree ps --json
orca worktree current --json
orca worktree list --repo id:<repoId> --json
```

Restrict detailed inspection to this session's own repository. Include folder contexts and Orca-only contexts, as well as every Git worktree, local branch and stash in that repository. Reconcile Git paths with Orca's full `<repoId>::<worktreePath>` ids; Orca visibility can hide external worktrees. Record the current session's checkout, default branch, remote identity and collection time. Use the provider's default branch or locally available `refs/remotes/origin/HEAD`; unresolved identity is a preservation blocker.

For each primary clone:

```sh
git -C <repo> remote -v
git -C <repo> symbolic-ref refs/remotes/origin/HEAD
git -C <repo> worktree list --porcelain
git -C <repo> branch --format='%(refname:short) %(upstream:short) %(upstream:track)'
git -C <repo> stash list
git -C <repo> status --short --branch
```

For every linked checkout, collect `git -C <wt> status --porcelain=v1 --branch`, `git -C <wt> log --oneline origin/<default>..HEAD`, and, when useful, `git -C <wt> diff --stat` and `du -sh <wt>`. Inspect untracked files and stash contents (`git -C <repo> stash show --stat 'stash@{N}'`) before proposing disposal. Branches without checkouts and each stash get their own table row. Stashes are repository-wide: repeat their count in checkout rows for context, but count each stash once in totals.

Local remote-tracking refs may be stale. Report that limitation; `git fetch --prune origin`, `git worktree prune`, and `git worktree repair` all mutate state and belong in the approval table. A broken `.git` file is ambiguous evidence to preserve and investigate, not proof of disposable residue.

## Live sessions

```sh
orca terminal list --worktree 'path:<wt>' --json
orca worktree show --worktree 'path:<wt>' --json
```

Use `worktree ps` plus per-worktree terminal/session evidence. Record available `workspaceStatus`, `status`, `liveTerminalCount`, `hasAttachedPty`, comments, terminal `connected` and `lastOutputAt`, and engine/structured-agent run state. A connected terminal or output within the operator's window (default 24 hours) is preservation evidence. An active engine run remains live even with no terminal handle. `in-progress` alone proves neither life nor death; a missing terminal, inaccessible host, unsupported session field, or stale handle makes liveness unknown, not exited. Preserve unknown sessions. Keep the current session's worktree regardless of other signals.

Immediately before each approved mutation, refresh Orca worktree/session and terminal evidence for that exact target, together with Git status and branch identity. If ownership, contents or liveness changed, preserve the target and obtain approval for a revised table.

## Publication state

Match remote identity, repository and exact source branch, not titles or branch names across unrelated remotes. Read existing PRs, including closed PRs:

```sh
gh pr list --repo <owner/repo> --state all --limit 500 --json number,state,isDraft,headRefName,baseRefName,mergedAt,closedAt,url,title
az repos pr list --organization <url> --project <project> --repository <repository> --source-branch <branch> --status all --output json
```

Resolve pagination/truncation before claiming completeness. Record PR URLs and provider state. `MERGED` (GitHub) or `completed` (Azure) establishes PR integration; verify the current local commits and dirty/untracked work are covered too. A closed/unmerged PR, a published branch, or an open PR alone does not establish integration. Unavailable provider access means publication unknown and preservation required.

## Classification

Present the complete nine-column table, with exactly one worktree row per Git inventory entry and additional clearly labelled branch, stash and Orca-only context rows:

| repo | path | branch | dirty | stash | PR | live session | class | action |
|---|---|---|---|---|---|---|---|---|
| <repo> | <checkout or object identity> | <branch/detached SHA> | <tracked/untracked state> | <count or stash identity> | <URL/state or unknown> | <evidence/time or unknown> | <keep/preserve/remove> | <exact proposed commands or retain> |

- **keep**: default-branch checkout and default branch, the current session checkout, and live-session WIP. Retain their branches, changes and contexts.
- **preserve**: intentional work without a live session, identified by a deliverable in the diff, issue or documentation. Propose publication as a PR before local cleanup. Ambiguous work is always preserved: nothing ambiguous is discarded. Unknown liveness or integration is a reason to retain locally pending resolution, not automatic permission to publish.
- **remove**: demonstrably integrated, stale, duplicate or generated residue whose unique contents have been accounted for. Corrupt state requires recovery evidence before disposal. Explain the evidence per row.

Enumerate exact targets and order, preservation commits/files, PR title/body/base, stash identities and any fetch, repair or pruning separately. Independently compare each repo's table worktree-row count to the number of `worktree ` records from `git worktree list --porcelain`.

## Approval

Show the entire action table before requesting an explicit operator **go** for those exact actions, targets and publication values. Audit permission is not cleanup permission. Changed scope, newly discovered work or unknown evidence requires a revised approval. With no go, deliver inventory and verification only.

## Approved execution

Recheck liveness and contents at every mutation. Preserve intentional dirty and untracked work in an operator-approved commit before publishing; show the exact file set and commit message. Confirm the resulting commit contains that work. An existing PR may be reused only after verifying its head includes the preserved commits.

GitHub publication example, after approval:

```sh
local_oid=$(git -C <wt> rev-parse HEAD) &&
git -C <wt> push -u origin <branch> &&
remote_line=$(git -C <wt> ls-remote --heads origin refs/heads/<branch>) &&
test "$remote_line" = "$(printf '%s\t%s' "$local_oid" 'refs/heads/<branch>')" &&
gh pr create --repo <owner/repo> --base <default> --head <branch> --title '<type>: preserve <deliverable>' --body '<reason and originating session/issue>'
```

Azure alternative: substitute the following command for `gh pr create` as the final command of the same successful push/SHA chain:

```sh
az repos pr create --organization <url> --project <project> --repository <repository> --source-branch <branch> --target-branch <default> --draft true --title '<title>' --description '<preservation evidence>'
```

For an intentional stash, include its exact object id, selected stash ref, new recovery path/branch, approved files and commit message, publication values and subsequent cleanup scope in the full approval table. The recovery path must be a new Git worktree distinct from the default and current-session checkouts; the recovery branch must be new. Record the immutable stash id before recovery, then substitute the approved values below:

```sh
stash_ref='stash@{N}'
approved_stash_oid='<approved-stash-object-id>'
stash_oid=$(git -C <primary> rev-parse --verify "$stash_ref") &&
test "$stash_oid" = "$approved_stash_oid" &&
git -C <primary> worktree add -b <recovery-branch> <new-recovery-wt> "$stash_oid^1" &&
git -C <new-recovery-wt> stash apply --index "$stash_oid"
```

Compare the recorded id with the approved stash id before creating the worktree. Applying by object id retains the original stash. Inspect the recovered index, worktree, untracked and ignored files separately; the stash's second parent is the staged version, its own tree the tracked worktree version, and its optional third parent the saved untracked/ignored files. Inventory what the stash actually contains: `-u` does not save ignored files, while `-a` does. Preserve any additional local content too.

Keep the recovered index intact. Before selecting approved content, root its full tree with a create-only recovery ref and root the original stash with a second create-only ref. Use a new absolute directory under the recovery worktree's Git metadata for a separate publication index; the approved table records these resource names. Run the sequence in a shell that stops on each failure:

```sh
index_tree=$(git -C <new-recovery-wt> write-tree) &&
test "$index_tree" = "$(git -C <new-recovery-wt> rev-parse "$stash_oid^2^{tree}")" &&
git -C <new-recovery-wt> update-ref refs/recovery/<unique-id>/index "$index_tree" '' &&
git -C <new-recovery-wt> update-ref refs/recovery/<unique-id>/stash "$stash_oid" '' &&
mkdir <new-absolute-recovery-state-dir> &&
cp "$(git -C <new-recovery-wt> rev-parse --path-format=absolute --git-path index)" <new-absolute-recovery-state-dir>/original-index &&
cmp "$(git -C <new-recovery-wt> rev-parse --path-format=absolute --git-path index)" <new-absolute-recovery-state-dir>/original-index &&
GIT_INDEX_FILE=<new-absolute-recovery-state-dir>/publish-index git -C <new-recovery-wt> read-tree HEAD
```

Use the separate index for every selection, inspection and commit command. For approved staged versions, select from the rooted index tree:

```sh
GIT_INDEX_FILE=<new-absolute-recovery-state-dir>/publish-index git -C <new-recovery-wt> restore --source="$index_tree" --staged -- <approved-staged-paths> &&
GIT_INDEX_FILE=<new-absolute-recovery-state-dir>/publish-index git -C <new-recovery-wt> diff --cached --name-status &&
GIT_INDEX_FILE=<new-absolute-recovery-state-dir>/publish-index git -C <new-recovery-wt> diff --cached --binary
```

Select approved tracked worktree versions with `restore --source="$stash_oid" --staged -- <paths>` using that same separate index. Select approved saved untracked/ignored versions from `"$stash_oid^3"` likewise; a missing parent or path stops selection. For approved partial content, edit only the separate index using `GIT_INDEX_FILE=... git ... add -p` and review the resulting full binary delta. Record explicitly which version or hunks are approved. Git tree entries preserve blob bytes and modes, including deletions; inspect mode changes as well as content.

Compare the entire separate index's staged path set and delta with approval before `GIT_INDEX_FILE=<new-absolute-recovery-state-dir>/publish-index git -C <new-recovery-wt> commit -m '<approved-message>'`. Confirm the commit's full delta matches approval and compare the recovered index file against `original-index` again. The original index, rooted trees, index backup and recovered worktree remain recovery resources; the commit changes HEAD, so subsequent status is relative to that new HEAD, not the original stash base. Reconstruct original staged/unstaged distinctions using the recorded base, index tree and stash trees rather than interpreting that status alone.

This recipe performs no mixed reset: index-only bytes remain in the original recovered index, its backup and a reachable tree before publication. Retain the recovery worktree/branch, state directory, both recovery refs and original stash until every staged, unstaged, untracked, ignored and binary variant has positive byte/tree/mode preservation evidence and separately approved disposition. A clean status or successful ordinary worktree removal is insufficient preservation evidence, especially for ignored files or index-only variants. Symlinks, gitlinks/submodule working directories and other unusual modes require their own mode/content proof; Git's saved gitlink alone does not save a submodule's dirty files. When such proof is unavailable, keep all resources and ask the owner to resolve the uncertainty; scope remains preserved, not silently discarded. On conflicts or any preservation, commit or publication failure, stop this target's sequence and retain all resources.

Publication and provider verification precede any separately approved stash disposal or recovery cleanup. Before approved stash disposal, verify that `git -C <new-recovery-wt> ls-remote --heads origin refs/heads/<recovery-branch>` returns the same SHA as `git -C <new-recovery-wt> rev-parse HEAD`, and verify the actual GitHub or Azure PR URL and its matching repository, source branch and head SHA. A successful push alone is insufficient. Account for every unapproved recovered change and retain its recovery copy and original stash until its preservation or disposal receives separate approval. Re-resolve the selected stash ref immediately before dropping:

```sh
test "$(git -C <primary> rev-parse --verify "$stash_ref")" = "$stash_oid" &&
git -C <primary> stash drop "$stash_ref"
```

If the ref changed, is missing or resolves to another id, stop without dropping anything; refresh the inventory and approval rather than substituting another stash. Keep other stash mutations serialized during this identity check and drop. Recovery worktree/branch, state directory and recovery-ref removal each require their own approved scope, complete variant accounting and the same publication proof.

Verify the remote head SHA and actual PR URL before any approved local removal. For Orca-managed contexts use the matched guide's command, which is itself destructive:

```sh
orca worktree rm --worktree 'path:<wt>' --force --json
```

For Git-only worktrees use `git -C <primary> worktree remove <wt>` (or explicitly approved `--force` for disposable contents). Choose one removal owner per checkout; inspect the result before proposing any additional removal. After successful worktree removal and renewed branch checks, an explicitly approved `git -C <primary> branch -D <branch>` removes its local branch. Approved stash disposal uses the identity-checked procedure above. Other approved residue operations may include `git -C <primary> worktree prune` or `git -C <primary> worktree repair <path>`, each with its exact scope and reason. Repair updates Git metadata; it is not a read-only diagnostic. Close/remove only approved Orca contexts and processes, preserving live or unknown work.

## Final verification

From each primary clone, substitute the confirmed default branch:

```sh
git status --short --branch && printf '%s\n' '--- worktrees' && git worktree list --porcelain && printf '%s\n' '--- branches' && git branch --format='%(refname:short) %(upstream:short) %(upstream:track)' && printf '%s\n' '--- stashes' && git stash list && printf '%s\n' '--- head' && git rev-parse HEAD origin/<default>
```

Refresh `orca worktree ps --json` and the relevant terminal/session evidence. Compare observed state with each approved action and with Git's inventory independently. A converged idle repo has a clean default checkout, one worktree, no non-default branches or stashes, no ahead/behind, and equal default/remote SHA. Live WIP and the current session are legitimate retained exceptions; report them explicitly. Investigate zero-terminal `in-progress` contexts with engine evidence rather than declaring them stale. Local refs cannot prove current server convergence without an approved fetch.

## Report

Return the complete classification table with actual action outcomes, all created/reused PR URLs, failures and retained exceptions. Give observed final counters: secondary Git worktrees, non-default local branches, stashes, repos ahead/behind, and repos whose divergence is unknown. Separate Orca-only contexts from Git worktrees. State inventory/table row counts and verification time. In audit-only mode report zero executed mutations and the actual nonclean or non-converged states; never substitute desired zeroes for observed results.

## Boundaries

The operator's explicit go governs every mutation and publication. Preserve default branches, live or unverifiable WIP, ambiguous work and the current session's checkout. Keep history intact and use ordinary pushes. Operate only this session's own repository and approved targets; hand foreign repositories to their owners through current OrcaCLI and retain protected work until safe recovery and specific approval exist.
