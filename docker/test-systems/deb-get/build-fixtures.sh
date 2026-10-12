#!/bin/sh
# Builds tiny .deb packages for the deb-get fixture and registers them the way
# deb-get does in /etc/deb-get/installed ("<app> <definition-version> <method>").
set -eu

FIXTURE=/opt/deb-get-fixture
mkdir -p "$FIXTURE/debs" "$FIXTURE/published" /etc/deb-get

build() {
  name="$1"
  version="$2"
  root="$(mktemp -d)"
  mkdir -p "$root/DEBIAN" "$root/usr/share/doc/$name"
  printf 'Package: %s\nVersion: %s\nArchitecture: all\nMaintainer: Linux Update Dashboard <fixtures@example.invalid>\nDescription: deb-get fixture app %s\n' \
    "$name" "$version" "$name" > "$root/DEBIAN/control"
  printf '%s %s\n' "$name" "$version" > "$root/usr/share/doc/$name/fixture-version"
  dpkg-deb --build --root-owner-group "$root" "$FIXTURE/debs/${name}_${version}_all.deb" >/dev/null
  rm -rf "$root"
}

# drawio: direct download; obsidian: GitHub release (needs DEBGET_TOKEN in the
# fixture); vscode: installed from an APT repository, so APT owns its updates.
build drawio 1.0.0
build drawio 1.5.0
build obsidian 1.0.0
build obsidian 2.0.0
build vscode 1.0.0
build vscode 1.1.0

echo 1.5.0 > "$FIXTURE/published/drawio"
echo 2.0.0 > "$FIXTURE/published/obsidian"
echo 1.1.0 > "$FIXTURE/published/vscode"
printf '%s\n' "drawio 1 direct" "obsidian 2 github" "vscode 1 apt" > /etc/deb-get/installed
