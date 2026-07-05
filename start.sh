#!/usr/bin/env bash
# Pipeline-MoE — single command launcher
# Starts: llama-server → backend (Express) → frontend (Vite)
# Stop:   Ctrl+C kills all three cleanly.
#
# Use this instead of `npm run dev` when you also need llama-server.
# `npm run dev` only starts backend + frontend (assumes llama-server already running).

set -euo pipefail
cd "$(dirname "$0")"

# Your llama-server launch script (override with the LLAMA_SCRIPT env var).
LLAMA_SCRIPT="${LLAMA_SCRIPT:-$HOME/AI/launch_llama_server_Qwopusctx.sh}"

# Allow cloud providers (Anthropic, DeepSeek…) whose API keys are already stored
# in auth.json to be usable without re-enabling them in the UI after every restart.
# Without this, presets that reference cloud models fail to load on a fresh boot:
# the credentials persist but the in-memory "enabled" flag resets each restart.
# Exported here so the backend (and its tsx child) inherit it; a shell env var
# takes precedence over .env, so this wins regardless of what .env says.
export PIPELINE_ALLOW_CLOUD=1

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'   GREEN='\033[0;32m'   AMBER='\033[0;33m'
BLUE='\033[0;34m'  DIM='\033[0;90m'     RESET='\033[0m'

log()  { echo -e "${DIM}[start]${RESET} $*"; }
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${AMBER}⚠${RESET} $*"; }
fail() { echo -e "${RED}✗${RESET} $*" >&2; exit 1; }

# ── Bootstrap .env ───────────────────────────────────────────────────────────
[[ ! -f .env ]] && [[ -f .env.example ]] && cp .env.example .env && log "Created .env from .env.example"

# ── Cleanup on exit ──────────────────────────────────────────────────────────
PIDS=()
cleanup() {
  log "Shutting down…"
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null && wait "$pid" 2>/dev/null || true
  done
  log "Done."
}
trap cleanup EXIT INT TERM

# ── 1. llama-server ──────────────────────────────────────────────────────────
if curl -sf --max-time 2 http://localhost:5000/health &>/dev/null; then
  ok "llama-server already running on :5000 — skipping launch"
else
  [[ ! -f "$LLAMA_SCRIPT" ]] && fail "llama-server script not found: $LLAMA_SCRIPT"
  log "Starting llama-server…"
  bash "$LLAMA_SCRIPT" &
  PIDS+=($!)

  # Wait for health (up to 30s — model load takes time)
  for i in $(seq 1 30); do
    if curl -sf --max-time 2 http://localhost:5000/health &>/dev/null; then
      ok "llama-server ready on :5000 (${i}s)"
      break
    fi
    [[ $i -eq 30 ]] && fail "llama-server didn't come up in 30s"
    sleep 1
  done
fi

# ── 2. Backend (Express API) ────────────────────────────────────────────────
log "Starting backend on :5300…"
node --env-file=.env node_modules/.bin/tsx src/server.ts &
PIDS+=($!)

# Wait for backend health
for i in $(seq 1 10); do
  if curl -sf --max-time 1 http://localhost:5300/api/health &>/dev/null; then
    ok "Backend ready on :5300 (${i}s)"
    break
  fi
  [[ $i -eq 10 ]] && fail "Backend didn't come up in 10s"
  sleep 1
done

# ── 3. Frontend (Vite dev server) ───────────────────────────────────────────
log "Starting frontend on :5310…"
npm --prefix web run dev -- --host &
PIDS+=($!)

# Wait for Vite to be ready
for i in $(seq 1 10); do
  if curl -sf --max-time 1 http://localhost:5310 &>/dev/null; then
    ok "Frontend ready on :5310 (${i}s)"
    break
  fi
  [[ $i -eq 10 ]] && warn "Frontend didn't respond in 10s — may still be starting"
  sleep 1
done

# ── Ready ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━ Pipeline-MoE ready ━━━${RESET}"
echo -e "  ${BLUE}UI${RESET}       http://localhost:5310"
echo -e "  ${BLUE}API${RESET}      http://localhost:5300"
echo -e "  ${BLUE}llama${RESET}    http://localhost:5000"
echo -e "  ${DIM}Ctrl+C to stop all${RESET}"
echo ""

# Keep alive — wait for any child to exit
wait
