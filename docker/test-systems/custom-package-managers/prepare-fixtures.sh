#!/bin/sh
set -eu

ROOT=/opt/ludash-fixtures
BUILD=/tmp/ludash-custom-package-build
SRC=/opt/ludash-custom-package-managers

rm -rf "$ROOT" "$BUILD"
mkdir -p "$ROOT/npm/tarballs" "$ROOT/pypi/packages" "$ROOT/pypi/simple" "$BUILD/npm" "$BUILD/python"

create_npm_package() {
  name=$1
  version=$2
  dir=$3
  mkdir -p "$dir"
  printf '{\n  "name": "%s",\n  "version": "%s",\n  "description": "Ludash custom package manager fixture",\n  "main": "index.js"\n}\n' "$name" "$version" > "$dir/package.json"
  printf 'module.exports = "%s@%s";\n' "$name" "$version" > "$dir/index.js"
  npm pack "$dir" --pack-destination "$ROOT/npm/tarballs" >/dev/null
}

create_python_package() {
  package=$1
  module=$2
  version=$3
  with_console=$4
  dir="$BUILD/python/$package-$version"
  mkdir -p "$dir"
  if [ "$with_console" = "1" ]; then
    cat > "$dir/setup.py" <<EOF
from setuptools import setup

setup(
    name="$package",
    version="$version",
    py_modules=["$module"],
    entry_points={"console_scripts": ["$package=$module:main"]},
)
EOF
    cat > "$dir/$module.py" <<EOF
def main():
    print("$package $version")
EOF
  else
    cat > "$dir/setup.py" <<EOF
from setuptools import setup

setup(name="$package", version="$version", py_modules=["$module"])
EOF
    printf 'VERSION = "%s"\n' "$version" > "$dir/$module.py"
  fi
  (cd "$dir" && python3 setup.py bdist_wheel --dist-dir "$ROOT/pypi/packages" >/dev/null)
}

create_simple_index() {
  package=$1
  normalized=$2
  wheel_prefix=$(printf '%s' "$package" | tr - _)
  mkdir -p "$ROOT/pypi/simple/$normalized"
  {
    printf '<!doctype html><html><body>\n'
    for wheel in "$ROOT"/pypi/packages/$wheel_prefix-*.whl; do
      file=$(basename "$wheel")
      printf '<a href="../../packages/%s">%s</a>\n' "$file" "$file"
    done
    printf '</body></html>\n'
  } > "$ROOT/pypi/simple/$normalized/index.html"
}

create_npm_package "ludash-npm-global-fixture" "1.0.0" "$BUILD/npm/npm-global-1.0.0"
create_npm_package "ludash-npm-global-fixture" "1.1.0" "$BUILD/npm/npm-global-1.1.0"
create_npm_package "@ludash/npm-project-fixture" "1.0.0" "$BUILD/npm/npm-project-1.0.0"
create_npm_package "@ludash/npm-project-fixture" "1.1.0" "$BUILD/npm/npm-project-1.1.0"

node "$SRC/npm-registry-server.mjs" &
NPM_REGISTRY_PID=$!
trap 'kill "$NPM_REGISTRY_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4873/ludash-npm-global-fixture >/dev/null; then
    break
  fi
  sleep 1
done

create_python_package "ludash-pip-user-fixture" "ludash_pip_user_fixture" "1.0.0" "0"
create_python_package "ludash-pip-user-fixture" "ludash_pip_user_fixture" "1.1.0" "0"
create_python_package "ludash-pip-venv-fixture" "ludash_pip_venv_fixture" "1.0.0" "0"
create_python_package "ludash-pip-venv-fixture" "ludash_pip_venv_fixture" "1.1.0" "0"
create_python_package "ludash-pipx-fixture-app" "ludash_pipx_fixture_app" "1.0.0" "1"
create_python_package "ludash-pipx-fixture-app" "ludash_pipx_fixture_app" "1.1.0" "1"
create_simple_index "ludash-pip-user-fixture" "ludash-pip-user-fixture"
create_simple_index "ludash-pip-venv-fixture" "ludash-pip-venv-fixture"
create_simple_index "ludash-pipx-fixture-app" "ludash-pipx-fixture-app"

su - testuser -c 'mkdir -p "$HOME/.config/pip" "$HOME/.local/bin" "$HOME/.local/share/pipx"'
cat > /home/testuser/.config/pip/pip.conf <<'EOF'
[global]
index-url = http://127.0.0.1:8080/simple
trusted-host = 127.0.0.1
break-system-packages = true
EOF
chown -R testuser:testuser /home/testuser/.config /home/testuser/.local

su - testuser -c "$SRC/reset-fixtures.sh"

kill "$NPM_REGISTRY_PID" 2>/dev/null || true
trap - EXIT

chown -R testuser:testuser /home/testuser/ludash-npm-project /home/testuser/ludash-pip-venv /home/testuser/.npm /home/testuser/.npm-global /home/testuser/.config /home/testuser/.local
rm -rf "$BUILD"
