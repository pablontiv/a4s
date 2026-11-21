#!/usr/bin/env bash
# Gate used by the factory cycle on the operator host: the repository gate plus the
# stub selftest. The full selftest (real models) never runs here: only the scheduled daily selftest on main runs it.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# fail early when the primary checkout carries a local git identity (#1120)
bash packages/factory/src/check-identity.sh
# test what is in use plus what changes (#1120): @a4s/factory always, other workspaces only when the candidate (diff
# against the merge base with BASE) touches them; scripts/gate.sh prints which workspaces run and why
export GATE_BASE=${GATE_BASE:-${BASE:-main}}
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
