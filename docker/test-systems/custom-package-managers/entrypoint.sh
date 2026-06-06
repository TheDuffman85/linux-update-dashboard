#!/bin/sh
set -eu

node /opt/ludash-custom-package-managers/npm-registry-server.mjs &
NPM_REGISTRY_PID=$!

python3 -m http.server 8080 --bind 127.0.0.1 --directory /opt/ludash-fixtures/pypi &
PYPI_SERVER_PID=$!

trap 'kill "$NPM_REGISTRY_PID" "$PYPI_SERVER_PID" 2>/dev/null || true' INT TERM EXIT

exec /usr/sbin/sshd -D
