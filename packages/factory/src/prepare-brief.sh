#!/usr/bin/env bash
# Writes $STATE/<n>/brief.md + title (from BRIEF_FILE or the GitHub issue) and appends the previous run's
# findings (carry.json). Used by the `prepare` step of dags/cycle.yaml. Env: ISSUE PRIMARY FACTORY STATE [BRIEF_FILE].
set -euo pipefail
. "${FACTORY:-${A4S_FACTORY:-}}/src/cycle-env.sh"
mkdir -p "$ISSUE_STATE"
if [ -n "${BRIEF_FILE:-}" ]; then
  cp "$BRIEF_FILE" "$ISSUE_STATE/brief.md"
  sed -n '1s/^#* *//p' "$BRIEF_FILE" > "$ISSUE_STATE/title"
else
  origin=$(git -C "$PRIMARY" remote get-url origin)
  gh issue view "$ISSUE" -R "$origin" --json title,body \
    --jq '"# " + .title + "\n\n" + .body' > "$ISSUE_STATE/brief.md"
  gh issue view "$ISSUE" -R "$origin" --json title --jq .title > "$ISSUE_STATE/title"
fi
# automatic retry: the findings that failed the previous run (labels.mjs finish -> carry.json)
node "$FACTORY/src/labels.mjs" carry --issue "$ISSUE" --state "$STATE" >> "$ISSUE_STATE/brief.md"
