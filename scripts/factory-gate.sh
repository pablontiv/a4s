#!/usr/bin/env bash
# Gate used by the factory cycle on the operator host: the repository gate plus the
# binary selftest (the candidate must still close one full factory cycle).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# The native Dagu tests match the official 2.26.0 release (also used by CI); prefer it when present.
official="$HOME/.local/opt/dagu-2.26.0/dagu"
if [[ -z "${DAGU_BIN:-}" && -x "$official" ]]; then export DAGU_BIN="$official"; fi
bash scripts/gate.sh
npm run selftest
