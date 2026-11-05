#!/usr/bin/env bash
# Local, foreground Temporal Server; never start-dev and never systemd.
set -euo pipefail
umask 077
readonly VERSION=1.32.2
readonly SHA256=6260f110b6853d2d7f8daa31793d1fac44096077e3b058dc3482de6ac50bc543
readonly SOURCE=https://github.com/temporalio/temporal/releases/download/v${VERSION}/temporal_${VERSION}_linux_amd64.tar.gz
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-}" in
  install)
    [[ "$(uname -m)" == x86_64 && "$(uname -s)" == Linux ]] || { echo 'This pinned release supports Linux x86_64 only.' >&2; exit 1; }
    if [[ -z "${TEMPORAL_SQLITE_RUNTIME:-}" ]]; then
      TEMPORAL_SQLITE_RUNTIME="$(mktemp -d /tmp/a4s-temporal-sqlite.XXXXXXXX)"
    fi
    mkdir -p -- "$TEMPORAL_SQLITE_RUNTIME"
    chmod 700 -- "$TEMPORAL_SQLITE_RUNTIME"
    curl -fL --retry 2 --output "$TEMPORAL_SQLITE_RUNTIME/server.tar.gz" "$SOURCE"
    printf '%s  %s\n' "$SHA256" "$TEMPORAL_SQLITE_RUNTIME/server.tar.gz" | sha256sum --check -
    tar -xzf "$TEMPORAL_SQLITE_RUNTIME/server.tar.gz" -C "$TEMPORAL_SQLITE_RUNTIME"
    printf 'TEMPORAL_SQLITE_RUNTIME=%q\n' "$TEMPORAL_SQLITE_RUNTIME"
    ;;
  start)
    : "${TEMPORAL_SQLITE_RUNTIME:?Set the private directory printed by install}"
    [[ -d "$TEMPORAL_SQLITE_RUNTIME" && -O "$TEMPORAL_SQLITE_RUNTIME" ]] || { echo 'Runtime must exist and be owned by this user.' >&2; exit 1; }
    chmod 700 -- "$TEMPORAL_SQLITE_RUNTIME"
    cd -- "$TEMPORAL_SQLITE_RUNTIME"
    exec ./temporal-server --config-file "$SCRIPT_DIR/server.yaml" --allow-no-auth start
    ;;
  version)
    : "${TEMPORAL_SQLITE_RUNTIME:?Set the private runtime directory}"
    "$TEMPORAL_SQLITE_RUNTIME/temporal-server" --version
    ;;
  *) echo "Usage: bash $0 install|start|version" >&2; exit 2 ;;
esac
