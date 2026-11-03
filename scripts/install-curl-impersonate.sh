#!/bin/sh
set -eu

case "$TARGETARCH" in
    amd64) platform=x86_64-linux-gnu; checksum=7716be1ec87f13ecc776c211003bd1122c345287829b1f18a494a5467c90ab1e ;;
    arm64) platform=aarch64-linux-gnu; checksum=1cb74a3b5103df020c252f9efef5a779c87380ee6244b365a90a0e4f7086864e ;;
    *) echo "Unsupported curl-impersonate architecture: $TARGETARCH" >&2; exit 1 ;;
esac

for attempt in 1 2 3 4; do
    if curl --fail --location --silent --show-error --continue-at - \
        --connect-timeout 15 --max-time 600 --max-redirs 5 \
        --proto '=https' --proto-redir '=https' \
        "https://github.com/lexiforest/curl-impersonate/releases/download/v2.3.2/libcurl-impersonate-v2.3.2.${platform}.tar.gz" \
        --output /tmp/libcurl.tar.gz; then break; fi
    if [ "$attempt" -eq 4 ]; then exit 1; fi
    sleep 1
done

printf '%s  %s\n' "$checksum" /tmp/libcurl.tar.gz | sha256sum --check
mkdir -p /opt/curl-impersonate
tar -xzf /tmp/libcurl.tar.gz -C /opt/curl-impersonate \
    --wildcards 'libcurl-impersonate*.so*' 'LICENSE*'
rm /tmp/libcurl.tar.gz
