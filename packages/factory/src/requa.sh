#!/usr/bin/env bash
# Re-QA of the rebased commit, run by `integrate` (#1091) inside the integration window. Usage: requa.sh ORIG NEWBASE
#   ORIG = old fork point, NEWBASE = the trunk the issue was rebased onto (the incoming range is ORIG..NEWBASE).
# Env: the cycle's (ISSUE PRIMARY FACTORY T3_HOME STATE DAG_RUN_ID LINE_TABLE) and the files requa-issue-files /
# requa-incoming-files in $ISSUE_STATE. Exit 0 = QA passed the rebased commit; 1 = it did not (step-failure.json written).
set -euo pipefail
. "${FACTORY:-${A4S_FACTORY:-}}/src/cycle-env.sh"
ORIG=$1; NEWBASE=$2
cd "$WT"
rq_from=$(date +%s%3N)
rq_brief="$ISSUE_STATE/qa-brief-requa.md"; rq_out="$ISSUE_STATE/qa-out-requa"
# The QA prompt reviews UNCOMMITTED changes: the rebased commit is folded back into the working tree (on top of the new
# trunk) for the review and recommitted afterwards with the same message, whatever the verdict.
PRE_C=$(git rev-parse HEAD)
git reset -q "$NEWBASE"
{ cat "$ISSUE_STATE/brief.md"
  printf '\n\n## Re-QA after a rebase\n\nThe trunk moved while this issue waited for the integration window. The uncommitted changes below are the issue rebased onto the new trunk and were NOT reviewed in this form. Verify every acceptance criterion again on this worktree, paying attention to how the issue interacts with the incoming changes. Incoming commit range `%s..%s`:\n\n```\n' "$ORIG" "$NEWBASE"
  git log --format='%h %s' "$ORIG..$NEWBASE"
  printf '```\n\nFiles changed by both sides:\n\n```\n'
  sort "$ISSUE_STATE/requa-issue-files" "$ISSUE_STATE/requa-incoming-files" | uniq -d
  printf '```\n\n## Worktree status (git status --short)\n\n```\n'
  git status --short
  printf '```\n\n## Worktree diff (git diff)\n\n```diff\n'
  git diff
  printf '```\n'; } > "$rq_brief"
: > "$rq_out"
rq_snap() { { git status --porcelain; git rev-parse HEAD; git diff | sha256sum; git ls-files -o --exclude-standard -z | xargs -0 -r sha256sum; } | sha256sum; }
before=$(rq_snap); rc=0
DAGU_OUTPUT_FILE="$rq_out" node "$FACTORY/src/station.mjs" --line qa --tag requa \
  --issue "$ISSUE" --run "$DAG_RUN_ID-requa" --project "$WT" \
  --brief "$rq_brief" --t3-home "$T3_HOME" \
  --state "$STATE" --lines "${LINE_TABLE:-}" >&2 || rc=$?
after=$(rq_snap)
git add -A
git commit -q -C "$PRE_C"
rq_res=$(grep '^result=' "$rq_out" | tail -n 1 | cut -d= -f2- || true)
rq_find=$(grep '^findings=' "$rq_out" | tail -n 1 | cut -d= -f2- || true)
if [ "$before" != "$after" ]; then rq_res=fail; rq_find='["re-qa changed the worktree"]'; fi
case "$rc" in 0|10) ;; *) rq_res=fail; rq_find="[\"re-qa station exit $rc\"]" ;; esac
[ -n "$rq_find" ] || rq_find='[]'
node "$FACTORY/src/requa.mjs" log --file "$ISSUE_STATE/requa.json" --from "$rq_from" --to "$(date +%s%3N)" \
  --incoming "$(git rev-list --count "$ORIG..$NEWBASE")" --result "${rq_res:-fail}" --findings "$rq_find"
if [ "$rq_res" != "pass" ]; then
  echo "re-qa result=${rq_res:-none}: aborting the integration" >&2
  node "$FACTORY/src/requa.mjs" fail --file "$ISSUE_STATE/step-failure.json" --run "$DAG_RUN_ID" --findings "$rq_find"
  exit 1
fi
