#!/bin/bash

# Configuration
SCRIPT_DIR="$(dirname "$0")"
PROJECT_ROOT="$(realpath "$SCRIPT_DIR")"
ENV_FILE="$SCRIPT_DIR/.env"
SERVER_PORT=3001
CLIENT_PORT=5173
PNPM_CMD=()

# Keep Corepack-managed pnpm downloads non-interactive for local scripts.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Helper functions
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

configure_pnpm() {
    if command -v pnpm >/dev/null 2>&1; then
        PNPM_CMD=(pnpm)
        return 0
    fi

    if command -v corepack >/dev/null 2>&1; then
        PNPM_CMD=(corepack pnpm)
        return 0
    fi

    log "Error: 'pnpm' is not installed and 'corepack' is not available."
    log "Install pnpm 10.33.0 or activate it with Corepack:"
    log "  corepack enable"
    log "  corepack prepare pnpm@10.33.0 --activate"
    exit 1
}

run_pnpm() {
    "${PNPM_CMD[@]}" "$@"
}

prepare_native_build_env() {
    local node_bin
    local node_root

    export XDG_CACHE_HOME="${TMPDIR:-/tmp}/ludash-cache"
    export npm_config_cache="${TMPDIR:-/tmp}/ludash-npm-cache"
    node_bin="$(command -v node)"
    node_root="$(dirname "$(dirname "$node_bin")")"

    if [ -f "$node_root/include/node/node.h" ]; then
        export npm_config_nodedir="$node_root"
    fi

    mkdir -p "$XDG_CACHE_HOME" "$npm_config_cache"
}

check_better_sqlite3() {
    run_pnpm exec node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.prepare('select 1').get(); db.close();" >/dev/null 2>&1
}

rebuild_better_sqlite3() {
    local better_sqlite3_dir=""

    run_pnpm rebuild better-sqlite3 >/dev/null 2>&1 || true
    if check_better_sqlite3; then
        return 0
    fi

    better_sqlite3_dir="$(run_pnpm exec node -p "require('path').dirname(require.resolve('better-sqlite3/package.json'))" 2>/dev/null || true)"
    if [ -n "$better_sqlite3_dir" ] && [ -d "$better_sqlite3_dir" ]; then
        (cd "$better_sqlite3_dir" && npm run build-release >/dev/null 2>&1) || true
    fi

    check_better_sqlite3
}

ensure_native_dependencies() {
    log "Checking native dependencies for Node.js $(node -v)..."

    if check_better_sqlite3; then
        log "Native dependencies are ready."
        return 0
    fi

    log "Detected an incompatible better-sqlite3 native build. Rebuilding for Node.js $(node -v)..."
    prepare_native_build_env
    if rebuild_better_sqlite3; then
        log "better-sqlite3 rebuilt successfully."
        return 0
    fi

    log "better-sqlite3 is still incompatible with Node.js $(node -v) after rebuild."
    log "Try running 'pnpm install' to refresh native modules for the active Node version."
    exit 1
}

cleanup_test_containers() {
    local compose_file=$1
    local stale_containers=()

    log "Stopping and removing existing test containers..."
    if ! docker compose -f "$compose_file" down --remove-orphans; then
        log "docker compose down reported issues. Continuing with stale container cleanup..."
    fi

    while IFS= read -r container_name; do
        [ -n "$container_name" ] && stale_containers+=("$container_name")
    done < <(docker ps -a --format '{{.Names}}' | grep -E '^[0-9a-f]{12}_ludash-test-' || true)

    if [ ${#stale_containers[@]} -eq 0 ]; then
        return 0
    fi

    log "Removing stale Docker Compose recreate containers: ${stale_containers[*]}"
    if ! docker rm -f "${stale_containers[@]}"; then
        log "Failed to remove stale test containers."
        return 1
    fi

    return 0
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

# Check for Node.js and pnpm
if ! command -v node &> /dev/null; then
    log "Error: 'node' is not installed."
    log "Please install Node.js 24.14.1 to run this application locally."
    log "Alternatively, use Docker to run the containerized application."
    exit 1
fi

configure_pnpm

# 3. Determine mode
MODE="${1:-normal}"

cd "$PROJECT_ROOT" || exit 1

ensure_native_dependencies

if [ "$MODE" == "test" ]; then
    log "Starting in TEST mode..."

    if ! command -v docker &> /dev/null; then
        log "Error: 'docker' is not installed."
        exit 1
    fi

    # Recreate test containers from a clean state to avoid Compose name conflicts.
    COMPOSE_DIR="$PROJECT_ROOT/docker/test-systems"
    if [ ! -f "$COMPOSE_DIR/docker-compose.yml" ]; then
        log "Error: docker-compose.yml not found at $COMPOSE_DIR"
        exit 1
    fi

    if ! cleanup_test_containers "$COMPOSE_DIR/docker-compose.yml"; then
        log "Failed to clean up previous test containers. Aborting."
        exit 1
    fi

    log "Recreating test containers..."
    docker compose -f "$COMPOSE_DIR/docker-compose.yml" up -d --build
    if [ $? -ne 0 ]; then
        log "Failed to recreate test containers. Aborting."
        exit 1
    fi
    log "Test containers are up."

    # Continue with production mode
    export NODE_ENV=production

    log "Building application..."
    run_pnpm run build

    if [ $? -eq 0 ]; then
        log "Build successful."
        log "Starting server..."
        run_pnpm run start
    else
        log "Build failed. Aborting."
        exit 1
    fi

elif [ "$MODE" == "dev" ]; then
    log "Starting in DEVELOPMENT mode..."

    # Start both server and client via pnpm scripts
    log "Starting server (tsx watch) and client (vite)..."
    run_pnpm run dev:server &
    SERVER_PID=$!

    run_pnpm run dev:client &
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
    export NODE_ENV=production

    # Build
    log "Building application..."
    run_pnpm run build

    if [ $? -eq 0 ]; then
        log "Build successful."
        log "Starting server..."
        run_pnpm run start
    else
        log "Build failed. Aborting."
        exit 1
    fi
fi
