#!/usr/bin/env bash
# Hand fix -> trunk through the integration window (packages/factory/CONTRACTS.md, Integration lease contract).
# Usage, from the hand-fix worktree (a worktree of the primary clone, never the primary itself), with the fix
# committed on its branch:
#   scripts/hand-push.sh <label>
# Takes the integration lease as a manual holder (this shell's pid), rebases the branch on the trunk, runs the
# factory gate, fast-forwards the primary checkout and pushes it (the remote only accepts a fast-forward), waits for
# CI on that SHA and releases the lease on every exit path. A red CI is reported, not reverted: revert by hand.
# Env: A4S_PRIMARY (default: the main worktree), A4S_STATE (default ~/.local/state/a4s/factory), BASE (default main),
#      GATE (default `bash scripts/factory-gate.sh`), CI_TIMEOUT_MIN (default 30), CI_WORKFLOWS (default CI),
#      HAND_PUSH_SKIP_CI=1 (do not wait for CI) and A4S_LEASE_JS (lease module) for tests.
set -euo pipefail
label=${1:?usage: scripts/hand-push.sh <label>}
run="hand-$label"
top=$(git rev-parse --show-toplevel)
PRIMARY=${A4S_PRIMARY:-$(git worktree list --porcelain | sed -n '1s/^worktree //p')}
STATE=${A4S_STATE:-$HOME/.local/state/a4s/factory}
BASE=${BASE:-main}
GATE=${GATE:-bash scripts/factory-gate.sh}
[ "$(cd "$top" && pwd -P)" != "$(cd "$PRIMARY" && pwd -P)" ] || { echo "hand-push: run it from a hand-fix worktree, not the primary checkout" >&2; exit 2; }
[ -z "$(git -C "$top" status --porcelain)" ] || { echo "hand-push: commit the fix first (the worktree is not clean)" >&2; exit 2; }
[ -z "$(git -C "$PRIMARY" status --porcelain --untracked-files=no)" ] || { echo "hand-push: the primary checkout has local changes" >&2; exit 2; }
test "$(git -C "$PRIMARY" branch --show-current)" = "$BASE"
branch=$(git -C "$top" branch --show-current)
[ -n "$branch" ] && [ "$branch" != "$BASE" ] || { echo "hand-push: the worktree must be on its own branch" >&2; exit 2; }

# the lease module of the live factory (the primary checkout): the format every factory run reads
LEASE_JS=${A4S_LEASE_JS:-$PRIMARY/packages/factory/src/lease.mjs}
lease() { local sub=$1; shift; node "$LEASE_JS" "$sub" --state "$STATE" --run "$run" "$@"; }
lease acquire --manual --pid $$
trap 'lease release' EXIT

cd "$top"
git -C "$PRIMARY" fetch -q origin "$BASE"
git -C "$PRIMARY" merge -q --ff-only "origin/$BASE"
git rebase -q "$BASE"
bash -euo pipefail -c "$GATE"
git -C "$PRIMARY" merge -q --ff-only "$branch"
sha=$(git -C "$PRIMARY" rev-parse HEAD)
git -C "$PRIMARY" push -q origin "$BASE"
echo "hand-push: pushed $sha to $BASE"
[ "${HAND_PUSH_SKIP_CI:-}" = 1 ] && exit 0
cls=$(node "$PRIMARY/packages/factory/src/ci.mjs" wait --primary "$PRIMARY" --origin "$(git -C "$PRIMARY" remote get-url origin)" \
  --sha "$sha" --base "$BASE" --workflows "${CI_WORKFLOWS:-CI}" --timeout-min "${CI_TIMEOUT_MIN:-30}")
echo "hand-push: ci $(printf '%s' "$cls" | jq -c '{state, conclusion, url}')"
[ "$(printf '%s' "$cls" | jq -r .state)" != red ] || { echo "hand-push: CI red on $sha: revert it by hand" >&2; exit 1; }
