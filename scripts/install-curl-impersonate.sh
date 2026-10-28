#!/bin/sh
set -eu

case "$TARGETARCH" in
    amd64) platform=x86_64-linux-gnu; checksum=da09231c2809977266ddd00a0b60e638f8e67fc5dc97811065a185fa951a3275 ;;
    arm64) platform=aarch64-linux-gnu; checksum=b3c1c4464100e050fab66314e84f3a776d5973172e6c63e2ad1d3dea6d4870ad ;;
    *) echo "Unsupported curl-impersonate architecture: $TARGETARCH" >&2; exit 1 ;;
esac

for attempt in 1 2 3 4; do
    if curl --fail --location --silent --show-error --continue-at - \
        --connect-timeout 15 --max-time 600 --max-redirs 5 \
        --proto '=https' --proto-redir '=https' \
        "https://github.com/lexiforest/curl-impersonate/releases/download/v2.2.2/libcurl-impersonate-v2.2.2.${platform}.tar.gz" \
        --output /tmp/libcurl.tar.gz; then break; fi
    if [ "$attempt" -eq 4 ]; then exit 1; fi
    sleep 1
done

printf '%s  %s\n' "$checksum" /tmp/libcurl.tar.gz | sha256sum --check
mkdir -p /opt/curl-impersonate
tar -xzf /tmp/libcurl.tar.gz -C /opt/curl-impersonate \
    --wildcards 'libcurl-impersonate*.so*' 'LICENSE*'
rm /tmp/libcurl.tar.gz
