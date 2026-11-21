#!/usr/bin/env bash
# Validation gate shared by CI (`validate`) and the dagu-feature GATE.
# Without GATE_BASE it is the full gate (every workspace). With GATE_BASE=<ref> it tests what is in use plus what
# changes (#1120): @a4s/factory always, any other workspace only when the diff against the merge base with <ref>
# touches it, every workspace when a root file changes or the base is unknown (packages/factory/src/affected.mjs).
# GATE_DRY_RUN=1 prints the npm commands instead of running them (tests).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

run() { if [[ "${GATE_DRY_RUN:-}" == 1 ]]; then echo "gate-dry-run: $*"; else "$@"; fi; }

if [[ "${GATE_DRY_RUN:-}" != 1 ]]; then
  DAGU_BIN=${DAGU_BIN:-$(command -v dagu || true)}
  if [[ -z "$DAGU_BIN" || ! -x "$DAGU_BIN" ]]; then
    echo "Dagu is required for native tests: set DAGU_BIN to an executable or install dagu on PATH." >&2
    exit 1
  fi
  export DAGU_BIN
fi

names=(--all)
if [[ -n "${GATE_BASE:-}" ]]; then
  echo "gate: GATE_BASE=$GATE_BASE: testing what is in use plus what changes" >&2
  # stdout: the names (or --all); stderr: one `gate: <workspace>: <why>` line per selected workspace
  mapfile -t names < <(node packages/factory/src/affected.mjs --base "$GATE_BASE")
  [[ ${#names[@]} -gt 0 ]] || { echo "gate: affected workspaces unknown; running all" >&2; names=(--all); }
else
  echo "gate: no GATE_BASE: full gate" >&2
fi
echo "gate: workspaces: ${names[*]}" >&2

run npm ci
if [[ "${names[*]}" == --all ]]; then
  run npm test
  run npm run typecheck
else
  for w in "${names[@]}"; do
    run npm test --workspace "$w" --if-present
    run npm run typecheck --workspace "$w" --if-present
  done
fi
