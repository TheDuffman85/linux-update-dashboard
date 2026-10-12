#!/bin/sh
# Reinstall every fixture app at 1.0.0 so the next check reports updates again.
set -eu
for app in drawio obsidian vscode; do
  dpkg -i "/opt/deb-get-fixture/debs/${app}_1.0.0_all.deb" >/dev/null 2>&1
done
echo "deb-get fixtures reset to 1.0.0"
