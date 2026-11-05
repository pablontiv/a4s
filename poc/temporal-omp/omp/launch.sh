#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$ROOT/.runtime/compiled-cwd"
cd "$ROOT/.runtime/compiled-cwd"
exec env -u NODE_PATH -u PI_SESSION_ID -u PI_SESSION_FILE -u PI_TOOL_CALL_ID \
  PI_CODING_AGENT_DIR="$ROOT/.runtime" NATIVE_HOST_EVENTS="$ROOT/events.jsonl" \
  /home/pones/.local/share/tern/omp/bin/omp --cwd "$PWD" --session-dir "$ROOT/.runtime/sessions" \
  --no-extensions --no-skills --no-rules --no-context-files --no-lsp --no-title \
  --tools task --model cliproxy/gpt-6.1-sol --config "$ROOT/smoke-config.yml" \
  --extension "$ROOT/dist/extension.js" --max-time 120s --auto-approve \
  'Bounded native Temporal smoke: wait for the extension request then invoke native task exactly as requested. No other tools, no file changes. If request has not arrived, reply READY. Stop after NATIVE_HOST_DONE.'
