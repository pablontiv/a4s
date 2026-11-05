#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
STAGE="$1"
MANDATE="$2"
shift 2
mkdir -p "$ROOT/evidence/$STAGE" "$ROOT/.runtime/compiled-cwd"
cd "$ROOT/.runtime/compiled-cwd"
set +e
env -u NODE_PATH -u PI_SESSION_ID -u PI_SESSION_FILE -u PI_TOOL_CALL_ID \
 PI_CODING_AGENT_DIR="$ROOT/.runtime" NATIVE_OBJECTIVE_EVIDENCE="$ROOT/evidence/$STAGE" NATIVE_OBJECTIVE_MANDATE="$MANDATE" \
 /home/pones/.local/share/tern/omp/bin/omp --cwd "$PWD" --session-dir "$ROOT/.runtime/sessions-$STAGE" \
 --no-extensions --no-skills --no-rules --no-context-files --no-lsp --no-title \
 --tools task --model cliproxy/gpt-6.1-sol --config "$ROOT/smoke-config.yml" \
 --extension "$ROOT/dist/extension.js" --max-time 210s --auto-approve "$@" \
 'Bounded Temporal objective. Wait for extension requests and invoke native task synchronously exactly as requested. No other tools, no file changes. If no request yet, reply READY. After each task reply ITEM_DONE; successors arrive automatically.'
CODE="$?"
node "$ROOT/record-exit.mjs" "$ROOT/evidence/$STAGE" "$CODE"
exit "$CODE"
