#!/bin/sh
set -eu

npm config set prefix "$HOME/.npm-global" >/dev/null
npm config set registry http://127.0.0.1:4873 >/dev/null
npm install -g ludash-npm-global-fixture@1.0.0 >/dev/null

mkdir -p "$HOME/ludash-npm-project"
cd "$HOME/ludash-npm-project"
if [ ! -f package.json ]; then
  npm init -y >/dev/null
fi
npm config set registry http://127.0.0.1:4873 >/dev/null
npm install --save-exact @ludash/npm-project-fixture@1.0.0 >/dev/null

python3 -m pip install --user --break-system-packages /opt/ludash-fixtures/pypi/packages/ludash_pip_user_fixture-1.0.0-py3-none-any.whl >/dev/null

if [ ! -x "$HOME/ludash-pip-venv/bin/python" ]; then
  python3 -m venv "$HOME/ludash-pip-venv"
fi
"$HOME/ludash-pip-venv/bin/python" -m pip install /opt/ludash-fixtures/pypi/packages/ludash_pip_venv_fixture-1.0.0-py3-none-any.whl >/dev/null

PIPX_HOME="$HOME/.local/share/pipx"
PIPX_BIN_DIR="$HOME/.local/bin"
export PIPX_HOME PIPX_BIN_DIR
pipx uninstall ludash-pipx-fixture-app >/dev/null 2>&1 || true
pipx install /opt/ludash-fixtures/pypi/packages/ludash_pipx_fixture_app-1.0.0-py3-none-any.whl --pip-args="--no-index --find-links /opt/ludash-fixtures/pypi/packages" >/dev/null

echo "custom package manager fixtures reset"
