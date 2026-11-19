#!/usr/bin/env bash
# Closing gate: fails unless the delivery is verifiably closed. Each check prints its result.
# Env: ISSUE PRIMARY FACTORY T3_HOME STATE BASE PUSH CLOSE_ISSUE, SHA (integrated commit).
set -uo pipefail
. "${FACTORY:-${A4S_FACTORY:-}}/src/cycle-env.sh"
fails=0
res() { # name status(ok|FAIL|skipped) detail
  printf 'verify_close: %-28s %s %s\n' "$1" "$2" "${3:-}"
  if [ "$2" = FAIL ]; then fails=$((fails + 1)); fi
}
sha="${SHA:-}"
origin=$(git -C "$PRIMARY" remote get-url origin 2>/dev/null || true)

# 1. origin/BASE contains the integrated commit
if [ "$PUSH" = "true" ]; then
  if git -C "$PRIMARY" fetch -q origin 2>/dev/null && [ -n "$sha" ] &&
     git -C "$PRIMARY" merge-base --is-ancestor "$sha" "origin/$BASE" 2>/dev/null; then
    res origin_has_commit ok "$sha"
  else
    res origin_has_commit FAIL "$sha not in origin/$BASE"
  fi
else
  res origin_has_commit skipped "PUSH=false"
fi

# 2. the issue is closed
if [ "$CLOSE_ISSUE" = "true" ]; then
  st=$(gh issue view "$ISSUE" -R "$origin" --json state --jq .state 2>/dev/null || echo unknown)
  if [ "$st" = "CLOSED" ]; then res issue_closed ok; else res issue_closed FAIL "state=$st"; fi
else
  res issue_closed skipped "CLOSE_ISSUE=false"
fi

# 3. worktree and branch are gone
if [ ! -e "$WT" ] && ! git -C "$PRIMARY" worktree list --porcelain | grep -qxF "worktree $WT"; then
  res worktree_removed ok
else
  res worktree_removed FAIL "$WT still exists"
fi
if git -C "$PRIMARY" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  res branch_removed FAIL "$BRANCH still exists"
else
  res branch_removed ok
fi

# 4. primary checkout: on BASE, clean, equal to origin/BASE when pushed
cur=$(git -C "$PRIMARY" branch --show-current)
if [ "$cur" = "$BASE" ]; then res primary_on_base ok; else res primary_on_base FAIL "on '$cur'"; fi
if [ -z "$(git -C "$PRIMARY" status --porcelain --untracked-files=no)" ]; then
  res primary_clean ok
else
  res primary_clean FAIL "tracked changes"
fi
if [ "$PUSH" = "true" ]; then
  if [ "$(git -C "$PRIMARY" rev-parse HEAD)" = "$(git -C "$PRIMARY" rev-parse "origin/$BASE" 2>/dev/null)" ]; then
    res primary_equals_origin ok
  else
    res primary_equals_origin FAIL "HEAD != origin/$BASE"
  fi
else
  res primary_equals_origin skipped "PUSH=false"
fi

# 5. done.json with run-id, commit and timestamp
done_file="$ISSUE_STATE/done.json"
if [ -f "$done_file" ] && node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.exit(d.run_id && d.commit && d.timestamp ? 0 : 1)' "$done_file" 2>/dev/null; then
  res done_json ok "$done_file"
else
  res done_json FAIL "missing or incomplete $done_file"
fi

# information only (archiving is VS6): does the issue's T3 project still exist?
if node "$FACTORY/src/t3cli.mjs" project list 2>/dev/null | grep -q "issue-$ISSUE\b"; then
  echo "verify_close: t3_project (info) still exists: issue-$ISSUE"
else
  echo "verify_close: t3_project (info) not found or not listable: issue-$ISSUE"
fi

if [ "$fails" -gt 0 ]; then echo "verify_close: $fails check(s) failed" >&2; exit 1; fi
echo "verify_close: all checks passed"
