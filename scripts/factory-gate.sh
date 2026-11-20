#!/usr/bin/env bash
# Gate used by the factory cycle on the operator host: the repository gate plus the
# binary selftest (the candidate must still close one full factory cycle).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# The native Dagu tests match the official 2.26.0 release (also used by CI); prefer it when present.
official="$HOME/.local/opt/dagu-2.26.0/dagu"
if [[ -z "${DAGU_BIN:-}" && -x "$official" ]]; then export DAGU_BIN="$official"; fi
# Run the repository gate on the same Node major as CI (.github/workflows/ci.yml), not the host's.
ci_node=$(sed -n 's/^ *node-version: *\([0-9][0-9]*\).*/\1/p' .github/workflows/ci.yml | head -1)
if [[ -n "$ci_node" ]] && command -v nix >/dev/null && [[ "$(node -p 'process.versions.node.split(".")[0]')" != "$ci_node" ]]; then
  nix shell "nixpkgs#nodejs_${ci_node}" -c bash scripts/gate.sh
else
  bash scripts/gate.sh
fi
node packages/factory/src/check-models.mjs
node packages/factory/src/check-packages.mjs
npm run selftest:stub -w @a4s/factory
npm run selftest
