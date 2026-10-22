# Certificate trust in historical test images

These fixtures deliberately retain old packages to test update behavior. Their
certificate stores must still distrust the roots affected by the October 2026
eMudhra intermediate-key compromise.

`distrust-emudhra.sh` applies the distribution's persistent distrust configuration
after fixture setup. It does not upgrade or repair the fixture packages. The
offline deb-get image has no CA bundle and needs no trust-store change.

The two public root certificates come from
https://emudhra.we-have-a-problem.com/roots.json. Their SHA-256 fingerprints are:

- emSign ECC Root CA - G3: `86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b`
- AAA Certificate Services: `d7a7a0fb5d7e2731d771e9484ebcdef71d5f0c3e0a2948782bc83ee0ea699ef4`

RHEL-family and Arch images use these certificates as blocklist entries. Debian,
Ubuntu, and Alpine images disable the corresponding entries in
`/etc/ca-certificates.conf` and regenerate their stores.
