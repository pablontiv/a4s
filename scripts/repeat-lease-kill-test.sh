#!/usr/bin/env bash
# Runs the Dagu "run killed while holding the lease" test N times and reports pass/fail counts.
# Usage: scripts/repeat-lease-kill-test.sh [N=20]
#   NODE_BIN selects the node binary (default: node on PATH); the full output of each failed run is kept in
#   LOG_DIR (default: a new temporary directory, printed at the end).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)/packages/factory"
command -v dagu >/dev/null || { echo "dagu not found: the test would be skipped" >&2; exit 2; }
n=${1:-20}; node=${NODE_BIN:-node}; pass=0; fail=0
logs=${LOG_DIR:-$(mktemp -d -t lease-kill-test.XXXXXX)}; mkdir -p "$logs"
echo "node $("$node" -v), $n runs"
for i in $(seq 1 "$n"); do
  # a pass counts only when the test really ran and passed (a renamed or skipped test is not a pass)
  if out=$("$node" --test --test-name-pattern='a run killed while holding the lease does not block the next one, which reclaims it and integrates' test/dags.test.mjs 2>&1) \
    && printf '%s\n' "$out" | grep -qE '^(ℹ|#) pass 1$' && printf '%s\n' "$out" | grep -qE '^(ℹ|#) skipped 0$'; then
    pass=$((pass+1)); echo "run $i: pass"
  else
    fail=$((fail+1)); printf '%s\n' "$out" > "$logs/run-$i.log"; echo "--- run $i: FAIL (full output: $logs/run-$i.log)"; printf '%s\n' "$out" | tail -60
  fi
done
echo "pass=$pass fail=$fail (node $("$node" -v); failure logs: $logs)"
[ "$fail" -eq 0 ]
