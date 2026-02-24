#!/bin/bash
set -e
snap wait system seed.loaded

# Install all snaps (latest version from store)
for pkg in hello-world jq yq micro btop tree httpie certbot lolcat go; do
  case "$pkg" in
    micro|certbot|go) snap install "$pkg" --classic || true ;;
    *) snap install "$pkg" || true ;;
  esac
done

# Hold auto-refresh so snaps stay at the installed version
snap refresh --hold

# Downgrade non-classic snaps to their previous store revision so that
# "snap refresh --list" always reports available updates for testing.
for pkg in hello-world jq yq btop tree httpie lolcat; do
  REV=$(snap list "$pkg" 2>/dev/null | awk -v p="$pkg" '$1==p {print $3}')
  if [ -n "$REV" ] && [ "$REV" -gt 1 ]; then
    OLD=$((REV - 1))
    snap remove "$pkg" 2>/dev/null || true
    if snap download --basename="$pkg" --revision="$OLD" --target-directory=/tmp "$pkg" 2>/dev/null; then
      snap ack "/tmp/$pkg.assert" 2>/dev/null || true
      snap install "/tmp/$pkg.snap" 2>/dev/null || true
      rm -f "/tmp/$pkg.snap" "/tmp/$pkg.assert"
    else
      # Previous revision unavailable — reinstall latest
      snap install "$pkg" || true
    fi
  fi
done

touch /var/snap/.snaps-installed
