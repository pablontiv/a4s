#!/usr/bin/env bash
# Validation gate shared by CI (`validate`) and the dagu-feature GATE.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# The @pablontiv/pion dev tarball (github.com/pablontiv/pi releases) is no
# longer downloadable. Install without it, then restore the manifests that
# the identity tests read.
pion='@pablontiv/pion'
manifests=(package-lock.json packages/context-expert/package.json packages/pi-tool-row-presentation/package.json)
trap 'git checkout -- "${manifests[@]}"' EXIT
for manifest in "${manifests[@]:1}"; do
  jq --arg p "$pion" 'del(.devDependencies[$p])' "$manifest" > "$manifest.gate"
  mv "$manifest.gate" "$manifest"
done
jq --arg p "$pion" '
  del(.packages["node_modules/" + $p])
  | .packages |= with_entries(
      if .value.devDependencies then .value.devDependencies |= del(.[$p]) else . end)' \
  package-lock.json > package-lock.gate.json
mv package-lock.gate.json package-lock.json
npm ci
git checkout -- "${manifests[@]}"

npm test
# @a4s/pi-tool-row-presentation typechecks against @pablontiv/pion.
for workspace in @a4s/context-expert @a4s/orca-omp-integration @a4s/omp-dagu @a4s/synagent @a4s/synagent-bus; do
  npm run typecheck --workspace "$workspace"
done
