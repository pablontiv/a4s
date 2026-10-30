#!/usr/bin/env bash
set -euo pipefail
: "${1:?Usage: poc/hot-loader/drive.sh <isolated-root>}"
: "${POC_HOT_EVIDENCE:?Set the retained evidence directory}"
: "${POC_HOT_TMUX:?Set the native tmux executable}"
: "${POC_HOT_OMP:?Set the native omp executable}"
export POC_HOT_WORKTREE="$(git rev-parse --show-toplevel)"
exec python3 "$POC_HOT_EVIDENCE/native-driver.py" "$1"
