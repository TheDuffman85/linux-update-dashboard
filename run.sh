#!/bin/bash

# Configuration
SCRIPT_DIR="$(dirname "$0")"
PROJECT_ROOT="$(realpath "$SCRIPT_DIR")"
ENV_FILE="$SCRIPT_DIR/.env"
SERVER_PORT=3001
CLIENT_PORT=5173

# Helper functions
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

shutdown_service() {
    local port=$1
    local name=$2
    if command -v fuser >/dev/null 2>&1; then
        if fuser -k "$port/tcp" >/dev/null 2>&1; then
            log "Stopped $name running on port $port (via fuser)."
        else
            log "No $name found on port $port."
        fi
    else
        log "Warning: 'fuser' not found. Attempting fallback kill via lsof..."
        local pid=$(lsof -t -i:$port 2>/dev/null)
        if [ -n "$pid" ]; then
             kill $pid
             log "Stopped $name running on port $port (PID: $pid)."
        fi
    fi
}

# 1. Shutdown existing services
log "Checking for running services..."
shutdown_service $SERVER_PORT "server"
shutdown_service $CLIENT_PORT "client"

# 2. Load environment variables
if [ -f "$ENV_FILE" ]; then
    log "Loading environment variables from $ENV_FILE..."
    set -a
    source "$ENV_FILE"
    set +a
else
    log "No .env file found at $ENV_FILE. Proceeding with default environment."
fi

# Check for Bun
if ! command -v bun &> /dev/null; then
    log "Error: 'bun' runtime is not installed."
    log "Please install Bun to run this application locally: https://bun.sh"
    log "Example: curl -fsSL https://bun.sh/install | bash"
    log "Alternatively, use Docker to run the containerized application."
    exit 1
fi

# 3. Determine mode
MODE="${1:-normal}"

cd "$PROJECT_ROOT" || exit 1

if [ "$MODE" == "dev" ]; then
    log "Starting in DEVELOPMENT mode..."

    # Start both server and client via bun run dev
    log "Starting server (bun --watch) and client (vite)..."
    bun run dev:server &
    SERVER_PID=$!

    bun run dev:client &
    CLIENT_PID=$!

    log "Services started. Server PID: $SERVER_PID, Client PID: $CLIENT_PID"

    # Trap for cleanup
    cleanup() {
        log "Stopping services..."
        kill $SERVER_PID 2>/dev/null
        kill $CLIENT_PID 2>/dev/null
        wait $SERVER_PID 2>/dev/null
        wait $CLIENT_PID 2>/dev/null
        exit 0
    }
    trap cleanup SIGINT SIGTERM

    # Wait for both processes
    while kill -0 $SERVER_PID 2>/dev/null || kill -0 $CLIENT_PID 2>/dev/null; do
        wait
    done
else
    log "Starting in PRODUCTION mode..."

    # Build
    log "Building application..."
    bun run build

    if [ $? -eq 0 ]; then
        log "Build successful."
        log "Running database migrations..."
        bun run db:migrate 2>/dev/null || log "Migrations skipped (tables may already exist)"
        log "Starting server..."
        bun run start
    else
        log "Build failed. Aborting."
        exit 1
    fi
fi
