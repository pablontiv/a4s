#!/usr/bin/env bash
# Delivered issue: move $STATE/<n>/ to $STATE/archive/<n>/ (atomic rename; an existing entry gets a -<ts> suffix).
# Best effort: a failure is logged and never fails the run (always exits 0).
. "${FACTORY:-${A4S_FACTORY:-}}/src/cycle-env.sh" || exit 0
src="$STATE/$ISSUE"
[ -d "$src" ] || { echo "archive-state: no $src (nothing to move)"; exit 0; }
dest="$STATE/archive/$ISSUE"
{
  mkdir -p "$STATE/archive" &&
  if [ -e "$dest" ] || [ -L "$dest" ]; then dest="$dest-$(date -u +%Y%m%dT%H%M%SZ)"; fi &&
  mv -T "$src" "$dest" &&
  echo "archive-state: $src -> $dest"
} || echo "archive-state: could not move $src to $dest (ignored)" >&2
exit 0
