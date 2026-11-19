#!/usr/bin/env bash
# Closing step, idempotent: every action first checks whether its effect already exists,
# so re-running after a partial close succeeds and never comments twice.
# Env: ISSUE PRIMARY FACTORY T3_HOME STATE BASE PUSH CLOSE_ISSUE, SHA (integrated commit,
# default: HEAD of the primary), DAG_RUN_ID (default: unknown).
set -euo pipefail
. "${FACTORY:-${A4S_FACTORY:-}}/src/cycle-env.sh"
sha="${SHA:-$(git -C "$PRIMARY" rev-parse HEAD)}"
if [ "$CLOSE_ISSUE" = "true" ]; then
  origin=$(git -C "$PRIMARY" remote get-url origin)
  state=$(gh issue view "$ISSUE" -R "$origin" --json state --jq .state)
  if [ "$state" != "CLOSED" ]; then
    gh issue close "$ISSUE" -R "$origin" \
      --comment "Integrated by the factory in $sha (CI green)."
  else
    echo "issue $ISSUE already closed: not commenting again"
  fi
fi
if [ -d "$WT" ]; then
  git -C "$PRIMARY" worktree remove --force "$WT"
else
  echo "worktree already removed"
fi
git -C "$PRIMARY" worktree prune
if git -C "$PRIMARY" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git -C "$PRIMARY" branch -q -D "$BRANCH"
else
  echo "branch $BRANCH already removed"
fi
mkdir -p "$ISSUE_STATE"
printf '{"run_id":"%s","commit":"%s","timestamp":"%s"}\n' \
  "${DAG_RUN_ID:-unknown}" "$sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$ISSUE_STATE/done.json"
echo "closed issue=$ISSUE sha=$sha"
