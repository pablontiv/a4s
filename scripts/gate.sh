#!/usr/bin/env bash
# Validation gate shared by CI (`validate`) and the dagu-feature GATE.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

DAGU_BIN=${DAGU_BIN:-$(command -v dagu || true)}
if [[ -z "$DAGU_BIN" || ! -x "$DAGU_BIN" ]]; then
  echo "Dagu is required for native tests: set DAGU_BIN to an executable or install dagu on PATH." >&2
  exit 1
fi
export DAGU_BIN

npm ci
npm test
npm run typecheck
