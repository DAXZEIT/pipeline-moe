#!/usr/bin/env bash
# predev.sh — runs before npm run dev
# 1. Bootstrap .env from .env.example if missing
# 2. Warn if llama-server (:5000) is not reachable (non-blocking)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# 1. Bootstrap .env
if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  if [[ -f "$PROJECT_DIR/.env.example" ]]; then
    cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
    echo "[predev] Created .env from .env.example"
  fi
fi

# 2. Check llama-server health (non-blocking — just warn)
if command -v curl &>/dev/null; then
  if ! curl -sf --max-time 2 http://localhost:5000/health &>/dev/null; then
    echo "[predev] ⚠ llama-server not reachable on :5000 — agents will fail if it's not started"
  else
    echo "[predev] ✓ llama-server OK on :5000"
  fi
else
  echo "[predev] ⚠ curl not found — skipping llama-server check"
fi
