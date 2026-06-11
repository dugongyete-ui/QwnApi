#!/usr/bin/env bash
# =============================================================================
# install.sh — One-shot setup for Chat Gateway
# Installs all dependencies, sets up DB, builds, warms token pool.
# =============================================================================

set -euo pipefail

BOLD="\033[1m"
GREEN="\033[1;32m"
YELLOW="\033[1;33m"
RED="\033[1;31m"
CYAN="\033[1;36m"
RESET="\033[0m"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { echo -e "${BOLD}[install]${RESET} $*"; }
ok()   { echo -e "${GREEN}[✓]${RESET} $*"; }
warn() { echo -e "${YELLOW}[!]${RESET} $*"; }
err()  { echo -e "${RED}[✗]${RESET} $*" >&2; }
step() { echo -e "\n${CYAN}━━━ $* ━━━${RESET}"; }

# ── 0. Preflight ─────────────────────────────────────────────────────────────

step "Checking required tools"

check_cmd() {
  if command -v "$1" &>/dev/null; then
    ok "$1 found: $(command -v "$1")"
  else
    err "$1 not found — please install it first"
    exit 1
  fi
}

check_cmd node
check_cmd python3
check_cmd curl

NODE_VER=$(node --version 2>/dev/null | tr -d 'v')
NODE_MAJOR=${NODE_VER%%.*}
if [ "$NODE_MAJOR" -lt 18 ]; then
  err "Node.js >= 18 required (found v${NODE_VER})"
  exit 1
fi
ok "Node.js v${NODE_VER}"

PYTHON_VER=$(python3 --version 2>&1 | awk '{print $2}')
ok "Python ${PYTHON_VER}"

# Ensure pnpm
if ! command -v pnpm &>/dev/null; then
  warn "pnpm not found — installing via corepack..."
  corepack enable || npm install -g pnpm@latest
fi
ok "pnpm $(pnpm --version)"

# ── 1. Python dependencies ────────────────────────────────────────────────────

step "Installing Python dependencies"

PIP="pip3"
if ! command -v pip3 &>/dev/null; then
  if command -v pip &>/dev/null; then
    PIP="pip"
  else
    warn "pip not found — trying python3 -m pip"
    PIP="python3 -m pip"
  fi
fi

install_py_pkg() {
  local pkg="$1"
  if python3 -c "import ${pkg//-/_}" &>/dev/null 2>&1; then
    ok "${pkg} already installed"
  else
    log "Installing ${pkg}..."
    $PIP install --quiet "${pkg}"
    ok "${pkg} installed"
  fi
}

install_py_pkg "curl_cffi"

# Quick sanity check
python3 -c "import curl_cffi.requests; print('curl_cffi OK')" || {
  err "curl_cffi import failed — trying force-reinstall"
  $PIP install --quiet --force-reinstall curl_cffi
}
ok "Python deps ready"

# ── 2. Node.js / pnpm workspace ──────────────────────────────────────────────

step "Installing Node.js workspace dependencies"

cd "$SCRIPT_DIR"

log "Running pnpm install..."
pnpm install --frozen-lockfile 2>&1 | tail -5 || {
  warn "--frozen-lockfile failed, retrying without flag..."
  pnpm install 2>&1 | tail -5
}
ok "Node.js dependencies installed"

# ── 3. Database schema ────────────────────────────────────────────────────────

step "Pushing database schema"

if [ -z "${DATABASE_URL:-}" ]; then
  warn "DATABASE_URL is not set — skipping DB schema push"
  warn "Set DATABASE_URL and re-run: pnpm --filter @workspace/db push"
else
  log "Pushing schema with drizzle-kit..."
  pnpm --filter @workspace/db push-force 2>&1 | tail -10
  ok "Database schema up to date"
fi

# ── 4. Build API server ───────────────────────────────────────────────────────

step "Building API server"

log "Building artifacts/api-server..."
pnpm --filter @workspace/api-server build 2>&1 | tail -10
ok "API server built → artifacts/api-server/dist/"

# ── 5. Pre-warm token pool ────────────────────────────────────────────────────

step "Pre-warming bx-umidtoken pool"

CACHE_FILE="$SCRIPT_DIR/artifacts/api-server/token_cache.json"

log "Fetching initial token batch (this takes ~10s)..."
python3 "$SCRIPT_DIR/warmup_tokens.py" --once --output "$CACHE_FILE" && \
  ok "Token cache written: $CACHE_FILE" || \
  warn "Token pre-warm failed — server will warm pool on first startup"

# ── 6. Start background warm-up daemon ───────────────────────────────────────

step "Starting token warm-up daemon"

WARMUP_LOG="$SCRIPT_DIR/warmup_tokens.log"
WARMUP_PID_FILE="$SCRIPT_DIR/warmup_tokens.pid"

# Kill old daemon if running
if [ -f "$WARMUP_PID_FILE" ]; then
  OLD_PID=$(cat "$WARMUP_PID_FILE" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    log "Stopping old warm-up daemon (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$WARMUP_PID_FILE"
fi

nohup python3 "$SCRIPT_DIR/warmup_tokens.py" \
  --output "$CACHE_FILE" \
  --interval 3000 \
  >> "$WARMUP_LOG" 2>&1 &

WARMUP_PID=$!
echo "$WARMUP_PID" > "$WARMUP_PID_FILE"
ok "Warm-up daemon started (PID $WARMUP_PID, log: warmup_tokens.log)"

# ── 7. Summary ────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}${BOLD}════════════════════════════════════════${RESET}"
echo -e "${GREEN}${BOLD}  Installation complete!                ${RESET}"
echo -e "${GREEN}${BOLD}════════════════════════════════════════${RESET}"
echo ""
echo -e "  ${BOLD}Start API server:${RESET}"
echo -e "    PORT=8080 pnpm --filter @workspace/api-server start"
echo ""
echo -e "  ${BOLD}Start dev (build + start):${RESET}"
echo -e "    PORT=8080 pnpm --filter @workspace/api-server dev"
echo ""
echo -e "  ${BOLD}Monitor token warm-up:${RESET}"
echo -e "    tail -f warmup_tokens.log"
echo ""
echo -e "  ${BOLD}Stop warm-up daemon:${RESET}"
echo -e "    kill \$(cat warmup_tokens.pid)"
echo ""
if [ -z "${DATABASE_URL:-}" ]; then
  echo -e "  ${YELLOW}${BOLD}⚠ Remember: Set DATABASE_URL before starting the server${RESET}"
  echo ""
fi
if [ -z "${GW_MASTER_KEY:-}" ]; then
  echo -e "  ${YELLOW}${BOLD}⚠ Optional: Set GW_MASTER_KEY for API key management${RESET}"
  echo ""
fi
