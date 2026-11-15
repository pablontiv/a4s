#!/usr/bin/env bash
# Validation gate shared by CI (`validate`) and the dagu-feature GATE.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

npm ci
npm test
npm run typecheck
