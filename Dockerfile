# syntax=docker/dockerfile:1

# Match the libcurl release pinned by impers 0.1.2; verify each platform's archive.
FROM node:26-bookworm-slim AS curl-impersonate

ARG TARGETARCH
RUN rm -f /etc/apt/apt.conf.d/docker-clean
RUN --mount=type=cache,id=apt-cache-${TARGETARCH},target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lists-${TARGETARCH},target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl
RUN set -eu; \
    case "$TARGETARCH" in \
        amd64) platform=x86_64-linux-gnu; checksum=da09231c2809977266ddd00a0b60e638f8e67fc5dc97811065a185fa951a3275 ;; \
        arm64) platform=aarch64-linux-gnu; checksum=b3c1c4464100e050fab66314e84f3a776d5973172e6c63e2ad1d3dea6d4870ad ;; \
        *) echo "Unsupported curl-impersonate architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    for attempt in 1 2 3 4; do \
        if curl --fail --location --silent --show-error --continue-at - \
            --connect-timeout 15 --max-time 600 --max-redirs 5 \
            --proto '=https' --proto-redir '=https' \
            "https://github.com/lexiforest/curl-impersonate/releases/download/v2.2.2/libcurl-impersonate-v2.2.2.${platform}.tar.gz" \
            --output /tmp/libcurl.tar.gz; then break; fi; \
        if [ "$attempt" -eq 4 ]; then exit 1; fi; \
        sleep 1; \
    done; \
    printf '%s  %s\n' "$checksum" /tmp/libcurl.tar.gz | sha256sum --check; \
    mkdir -p /opt/curl-impersonate; \
    tar -xzf /tmp/libcurl.tar.gz -C /opt/curl-impersonate \
        --wildcards 'libcurl-impersonate*.so*' 'LICENSE*'; \
    rm /tmp/libcurl.tar.gz

FROM node:26-bookworm-slim AS dependencies

WORKDIR /build

COPY package.json package-lock.json ./
COPY apps/bot/package.json apps/bot/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/policy/package.json packages/policy/package.json
COPY packages/login/package.json packages/login/package.json
COPY packages/progress/package.json packages/progress/package.json
COPY packages/url-reader/package.json packages/url-reader/package.json
COPY packages/pi-url-reader/package.json packages/pi-url-reader/package.json
COPY packages/pi-polymarket/package.json packages/pi-polymarket/package.json
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace @narumitw/sumire --workspace @narumitw/sumire-admin --include-workspace-root=false --no-audit --no-fund

# Compile only source/configuration, keeping tests, docs, and skills out of build cache keys.
FROM dependencies AS policy-build

COPY packages/policy/tsconfig*.json packages/policy/
COPY packages/policy/src/ packages/policy/src/
RUN npm run build --workspace @narumitw/sumire-policy

FROM dependencies AS contracts-build

COPY --from=policy-build /build/packages/policy/dist /build/packages/policy/dist
COPY packages/contracts/tsconfig*.json packages/contracts/
COPY packages/contracts/src/ packages/contracts/src/
RUN npm --ignore-scripts run build --workspace @narumitw/sumire-contracts

FROM dependencies AS login-build

COPY packages/login/tsconfig*.json packages/login/
COPY packages/login/src/ packages/login/src/
RUN npm run build --workspace @narumitw/sumire-login

FROM dependencies AS progress-build

COPY packages/progress/tsconfig*.json packages/progress/
COPY packages/progress/src/ packages/progress/src/
RUN npm run build --workspace @narumitw/sumire-progress

FROM dependencies AS polymarket-build

COPY packages/pi-polymarket/tsconfig*.json packages/pi-polymarket/
COPY packages/pi-polymarket/src/ packages/pi-polymarket/src/
RUN npm run build --workspace @narumitw/sumire-pi-polymarket

FROM dependencies AS url-reader-build

COPY packages/url-reader/tsconfig*.json packages/url-reader/
COPY packages/url-reader/src/ packages/url-reader/src/
RUN npm run build --workspace @narumitw/sumire-url-reader

FROM dependencies AS pi-url-reader-build

COPY --from=url-reader-build /build/packages/url-reader/dist /build/packages/url-reader/dist
COPY packages/pi-url-reader/tsconfig*.json packages/pi-url-reader/
COPY packages/pi-url-reader/src/ packages/pi-url-reader/src/
# Dependencies are already compiled; skip the prebuild hook that recompiles them.
RUN npm --ignore-scripts run build --workspace @narumitw/sumire-pi-url-reader

FROM dependencies AS build

COPY --from=policy-build /build/packages/policy/dist /build/packages/policy/dist
COPY --from=contracts-build /build/packages/contracts/dist /build/packages/contracts/dist

COPY --from=login-build /build/packages/login/dist /build/packages/login/dist
COPY --from=progress-build /build/packages/progress/dist /build/packages/progress/dist
COPY --from=polymarket-build /build/packages/pi-polymarket/dist /build/packages/pi-polymarket/dist
COPY --from=url-reader-build /build/packages/url-reader/dist /build/packages/url-reader/dist
COPY --from=pi-url-reader-build /build/packages/pi-url-reader/dist /build/packages/pi-url-reader/dist
COPY apps/bot/tsconfig*.json apps/bot/
COPY apps/bot/src/ apps/bot/src/
RUN npm --ignore-scripts run build --workspace @narumitw/sumire

FROM dependencies AS admin-build

COPY --from=policy-build /build/packages/policy/dist /build/packages/policy/dist
COPY --from=contracts-build /build/packages/contracts/dist /build/packages/contracts/dist

COPY apps/admin/tsconfig.json apps/admin/vite.config.ts apps/admin/index.html apps/admin/
COPY apps/admin/src/ apps/admin/src/
RUN npm --ignore-scripts run build --workspace @narumitw/sumire-admin

FROM dependencies AS production-dependencies

RUN --mount=type=cache,target=/root/.npm \
    npm prune --omit=dev --workspace @narumitw/sumire --include-workspace-root=false --no-audit --no-fund

FROM node:26-bookworm-slim AS audio-dependencies

ARG TARGETARCH
# Docker's default apt hook deletes downloaded packages, defeating the cache mount.
RUN rm -f /etc/apt/apt.conf.d/docker-clean
RUN --mount=type=cache,id=apt-cache-${TARGETARCH},target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lists-${TARGETARCH},target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv
RUN --mount=type=cache,target=/root/.cache/pip \
    python3 -m venv /opt/audio \
    && /opt/audio/bin/pip install --upgrade pip \
    && /opt/audio/bin/pip install torch==2.8.0 --extra-index-url https://download.pytorch.org/whl/cpu
# Keep the heavyweight torch layer reusable when audio tool versions change.
RUN --mount=type=cache,target=/root/.cache/pip \
    /opt/audio/bin/pip install openai-whisper==20250625 yt-dlp==2026.8.19

FROM dependencies AS browser-download

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Use the npm-ci installation, including its locked browser revisions and headless shell.
RUN node node_modules/playwright/cli.js install chromium

FROM node:26-bookworm-slim AS runtime-dependencies

ARG TARGETARCH
RUN rm -f /etc/apt/apt.conf.d/docker-clean
RUN --mount=type=cache,id=apt-cache-${TARGETARCH},target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lists-${TARGETARCH},target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git openssh-client python3 ffmpeg libcurl4

# Resolve OS dependencies with the exact same locked CLI as the browser download.
RUN --mount=type=bind,from=dependencies,source=/build/node_modules,target=/build/node_modules \
    --mount=type=cache,id=apt-cache-${TARGETARCH},target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lists-${TARGETARCH},target=/var/lib/apt/lists,sharing=locked \
    node /build/node_modules/playwright/cli.js install-deps chromium

FROM runtime-dependencies AS runtime

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV XDG_CACHE_HOME=/app/.cache
ENV IMPER_DOWNLOAD_LIBCURL=0
ENV LIBCURL_PATH=/opt/curl-impersonate/libcurl-impersonate.so

COPY --from=curl-impersonate /opt/curl-impersonate /opt/curl-impersonate

WORKDIR /workdir

RUN groupadd --system app \
    && useradd --system --gid app --home-dir /workdir --shell /usr/sbin/nologin app \
    && mkdir -p /workdir /app/apps/bot /app/packages/login /app/packages/progress /app/packages/url-reader /app/packages/pi-url-reader /app/.telegramagent /app/.events /app/.cache/whisper /app/instructions /app/skills \
    && chown -R app:app /app /workdir

COPY --from=browser-download --chown=app:app /ms-playwright /ms-playwright
COPY --from=audio-dependencies /opt/audio /opt/audio
COPY --from=production-dependencies --chown=app:app /build/node_modules /app/node_modules

ENV NODE_ENV=production
ENV PATH="/opt/audio/bin:/app/node_modules/.bin:${PATH}"

COPY --from=production-dependencies --chown=app:app /build/apps/bot/package.json /app/apps/bot/package.json
COPY --from=production-dependencies --chown=app:app /build/packages/contracts/package.json /app/packages/contracts/package.json
COPY --from=production-dependencies --chown=app:app /build/packages/policy/package.json /app/packages/policy/package.json
COPY --from=production-dependencies --chown=app:app /build/packages/login/package.json /app/packages/login/package.json
COPY --from=production-dependencies --chown=app:app /build/packages/progress/package.json /app/packages/progress/package.json
COPY --from=production-dependencies --chown=app:app /build/packages/url-reader/package.json /app/packages/url-reader/package.json
COPY --from=production-dependencies --chown=app:app /build/packages/pi-url-reader/package.json /app/packages/pi-url-reader/package.json
COPY --from=production-dependencies --chown=app:app /build/packages/pi-polymarket/package.json /app/packages/pi-polymarket/package.json
COPY --from=policy-build --chown=app:app /build/packages/policy/dist /app/packages/policy/dist
COPY --from=contracts-build --chown=app:app /build/packages/contracts/dist /app/packages/contracts/dist
COPY --from=login-build --chown=app:app /build/packages/login/dist /app/packages/login/dist
COPY --from=progress-build --chown=app:app /build/packages/progress/dist /app/packages/progress/dist
COPY --from=polymarket-build --chown=app:app /build/packages/pi-polymarket/dist /app/packages/pi-polymarket/dist
COPY --from=url-reader-build --chown=app:app /build/packages/url-reader/dist /app/packages/url-reader/dist
COPY --from=pi-url-reader-build --chown=app:app /build/packages/pi-url-reader/dist /app/packages/pi-url-reader/dist
COPY --from=build --chown=app:app /build/apps/bot/dist /app/apps/bot/dist
COPY --from=admin-build --chown=app:app /build/apps/admin/dist /app/apps/admin/dist
COPY --chown=app:app packages/pi-url-reader/skills/ /app/packages/pi-url-reader/skills/
COPY --chown=app:app instructions/ /app/instructions/
COPY --chown=app:app skills/ /app/skills/
COPY --chown=app:app apps/bot/scripts/ /app/apps/bot/scripts/

# Fail the build if production pruning removed a module needed at startup.
RUN node --input-type=module -e "await import('/app/apps/bot/dist/startup.js')"

ENV HOME=/workdir
USER app

# Verify both locked browser binaries and a real offline headless launch as the runtime user.
RUN --network=none node /app/apps/bot/scripts/check-browser.mjs

# Check Chrome fingerprint compatibility offline, using the runtime user's library.
RUN --network=none node /app/apps/bot/scripts/check-curl-impersonate.mjs

# Fail the build if Git or SSH tools are unavailable to the bot user.
RUN git --version && ssh -V && command -v ssh-keygen

ENTRYPOINT ["node", "/app/apps/bot/dist/index.js"]
