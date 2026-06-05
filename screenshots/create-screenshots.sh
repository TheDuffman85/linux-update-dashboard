#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

export LUDASH_SCREENSHOT_FRONTEND_HOST="${LUDASH_SCREENSHOT_FRONTEND_HOST:-127.0.0.1}"
export LUDASH_SCREENSHOT_FRONTEND_PORT="${LUDASH_SCREENSHOT_FRONTEND_PORT:-5173}"
export LUDASH_SCREENSHOT_BACKEND_PORT="${LUDASH_SCREENSHOT_BACKEND_PORT:-3001}"
export LUDASH_SCREENSHOT_BASE_URL="${LUDASH_SCREENSHOT_BASE_URL:-http://${LUDASH_SCREENSHOT_FRONTEND_HOST}:${LUDASH_SCREENSHOT_FRONTEND_PORT}}"
export LUDASH_SCREENSHOT_OUTPUT_DIR="${LUDASH_SCREENSHOT_OUTPUT_DIR:-$SCRIPT_DIR}"
export LUDASH_SCREENSHOT_CHROME_PORT="${LUDASH_SCREENSHOT_CHROME_PORT:-9223}"

export LUDASH_DB_PATH="${LUDASH_DB_PATH:-${TMPDIR:-/tmp}/ludash-screenshots/dashboard.db}"
export LUDASH_ENCRYPTION_KEY="${LUDASH_ENCRYPTION_KEY:-MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=}"
export LUDASH_SECRET_KEY="${LUDASH_SECRET_KEY:-ludash-readme-screenshot-session-key}"
export LUDASH_BASE_URL="${LUDASH_BASE_URL:-http://localhost:${LUDASH_SCREENSHOT_FRONTEND_PORT}}"
export LUDASH_PORT="$LUDASH_SCREENSHOT_BACKEND_PORT"
export LUDASH_LOG_LEVEL="${LUDASH_LOG_LEVEL:-error}"

export VITE_APP_VERSION="${VITE_APP_VERSION:-dev-screenshots}"
export VITE_APP_BRANCH="${VITE_APP_BRANCH:-main}"
export VITE_APP_COMMIT_HASH="${VITE_APP_COMMIT_HASH:-screenshot}"
export VITE_APP_BUILD_DATE="${VITE_APP_BUILD_DATE:-2026-06-05}"

if [[ -z "${CHROME_PATH:-}" ]]; then
  for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
      export CHROME_PATH="$(command -v "$candidate")"
      break
    fi
  done
fi

if [[ -z "${CHROME_PATH:-}" ]]; then
  echo "Unable to find Chrome/Chromium. Set CHROME_PATH in screenshots/.env." >&2
  exit 1
fi

BACKEND_PID=""
FRONTEND_PID=""

stop_pid() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  stop_pid "$FRONTEND_PID"
  stop_pid "$BACKEND_PID"
}
trap cleanup EXIT INT TERM

wait_for_url() {
  local url="$1"
  local label="$2"
  local attempts=120

  for _ in $(seq 1 "$attempts"); do
    if node -e "fetch(process.argv[1]).then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" "$url"; then
      return 0
    fi
    sleep 0.25
  done

  echo "Timed out waiting for $label at $url" >&2
  return 1
}

cd "$REPO_ROOT"

echo "Initializing screenshot database schema: $LUDASH_DB_PATH"
pnpm exec tsx server/index.ts &
BACKEND_PID="$!"
wait_for_url "http://127.0.0.1:${LUDASH_SCREENSHOT_BACKEND_PORT}/api/auth/status" "backend schema initialization"
stop_pid "$BACKEND_PID"
BACKEND_PID=""

echo "Seeding screenshot database: $LUDASH_DB_PATH"
node "$SCRIPT_DIR/seed-demo-data.mjs"

echo "Starting backend on port $LUDASH_SCREENSHOT_BACKEND_PORT"
pnpm exec tsx server/index.ts &
BACKEND_PID="$!"
wait_for_url "http://127.0.0.1:${LUDASH_SCREENSHOT_BACKEND_PORT}/api/auth/status" "backend"

echo "Starting frontend on ${LUDASH_SCREENSHOT_FRONTEND_HOST}:${LUDASH_SCREENSHOT_FRONTEND_PORT}"
pnpm exec vite --host "$LUDASH_SCREENSHOT_FRONTEND_HOST" --port "$LUDASH_SCREENSHOT_FRONTEND_PORT" &
FRONTEND_PID="$!"
wait_for_url "$LUDASH_SCREENSHOT_BASE_URL" "frontend"

echo "Capturing screenshots with $CHROME_PATH"
node "$SCRIPT_DIR/capture-screenshots.mjs"

echo "Screenshots written to $LUDASH_SCREENSHOT_OUTPUT_DIR"
