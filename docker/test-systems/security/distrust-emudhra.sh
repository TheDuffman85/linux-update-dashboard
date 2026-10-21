#!/bin/sh
set -eu

# Keep old package-manager fixtures usable without trusting the roots involved
# in the October 2026 eMudhra incident. Use each distribution's persistent
# distrust configuration so later package updates do not restore trust.
security_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -f /etc/ca-certificates.conf ]; then
    sed -i \
        -e 's|^mozilla/emSign_ECC_Root_CA_-_G3.crt$|!&|' \
        -e 's|^mozilla/Comodo_AAA_Services_root.crt$|!&|' \
        /etc/ca-certificates.conf
    update-ca-certificates --fresh
elif command -v update-ca-trust >/dev/null 2>&1; then
    if [ -d /etc/ca-certificates/trust-source ]; then
        blocklist=/etc/ca-certificates/trust-source/blocklist
    elif [ -d /etc/pki/ca-trust/source/blocklist ]; then
        blocklist=/etc/pki/ca-trust/source/blocklist
    else
        blocklist=/etc/pki/ca-trust/source/blacklist
    fi
    mkdir -p "$blocklist"
    cp "$security_dir/emSign-ECC-Root-CA-G3.pem" "$blocklist/"
    cp "$security_dir/AAA-Certificate-Services.pem" "$blocklist/"
    update-ca-trust extract
else
    # The offline deb-get fixture deliberately has no CA package or bundle.
    for bundle in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt; do
        if [ -s "$bundle" ]; then
            echo "Cannot update certificate trust: no supported CA-store tool" >&2
            exit 1
        fi
    done
fi
