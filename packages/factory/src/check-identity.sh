#!/usr/bin/env bash
# Guard (#1120, operator request): the primary checkout (the main worktree; A4S_PRIMARY overrides) must not carry a
# LOCAL git identity. A test once leaked `user.name "Reconcile Test"` into the primary's .git/config and every commit
# made on main (by the factory or by hand) took that identity. The primary's local config is shared by all its
# worktrees, so a local user.name/user.email there overrides the operator's global identity everywhere.
set -euo pipefail
primary=${A4S_PRIMARY:-$(git worktree list --porcelain | sed -n '1s/^worktree //p')}
bad=()
for k in user.name user.email; do
  if v=$(git -C "$primary" config --local --get "$k" 2>/dev/null); then bad+=("$k=\"$v\""); fi
done
if [[ ${#bad[@]} -gt 0 ]]; then
  echo "factory-gate: the primary checkout $primary has a local git identity (${bad[*]}) in its .git/config; commits would carry it. Remove it: git -C $primary config --local --unset user.name; git -C $primary config --local --unset user.email" >&2
  exit 1
fi
