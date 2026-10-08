# syntax=docker/dockerfile:1

# Match the libcurl release pinned by impers 0.1.2; verify each platform's archive.
FROM node:24-bookworm-slim AS curl-impersonate

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

FROM node:24-bookworm-slim AS dependencies

WORKDIR /build

COPY package.json package-lock.json ./
COPY apps/bot/package.json apps/bot/package.json
COPY packages/login/package.json packages/login/package.json
COPY packages/progress/package.json packages/progress/package.json
COPY packages/url-content/package.json packages/url-content/package.json
COPY packages/url-tool/package.json packages/url-tool/package.json
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace @narumitw/sumire --include-workspace-root=false --no-audit --no-fund

# Compile only source/configuration, keeping tests, docs, and skills out of build cache keys.
FROM dependencies AS login-build

COPY packages/login/tsconfig*.json packages/login/
COPY packages/login/src/ packages/login/src/
RUN npm run build --workspace @narumitw/sumire-login

FROM dependencies AS progress-build

COPY packages/progress/tsconfig*.json packages/progress/
COPY packages/progress/src/ packages/progress/src/
RUN npm run build --workspace @narumitw/sumire-progress

FROM dependencies AS url-content-build

COPY packages/url-content/tsconfig*.json packages/url-content/
COPY packages/url-content/src/ packages/url-content/src/
RUN npm run build --workspace @narumitw/sumire-url-content

FROM dependencies AS url-tool-build

COPY --from=url-content-build /build/packages/url-content/dist /build/packages/url-content/dist
COPY packages/url-tool/tsconfig*.json packages/url-tool/
COPY packages/url-tool/src/ packages/url-tool/src/
# Dependencies are already compiled; skip the prebuild hook that recompiles them.
RUN npm --ignore-scripts run build --workspace @narumitw/sumire-url-tool

FROM dependencies AS build

COPY --from=login-build /build/packages/login/dist /build/packages/login/dist
COPY --from=progress-build /build/packages/progress/dist /build/packages/progress/dist
COPY --from=url-content-build /build/packages/url-content/dist /build/packages/url-content/dist
COPY --from=url-tool-build /build/packages/url-tool/dist /build/packages/url-tool/dist
COPY apps/bot/tsconfig*.json apps/bot/
COPY apps/bot/src/ apps/bot/src/
RUN npm --ignore-scripts run build --workspace @narumitw/sumire

FROM dependencies AS production-dependencies

RUN --mount=type=cache,target=/root/.npm \
    npm prune --omit=dev --workspace @narumitw/sumire --include-workspace-root=false --no-audit --no-fund

FROM node:24-bookworm-slim AS audio-dependencies

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

FROM node:24-bookworm-slim AS runtime-dependencies

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
    && mkdir -p /workdir /app/apps/bot /app/packages/login /app/packages/progress /app/packages/url-content /app/packages/url-tool /app/.telegramagent /app/.events /app/.cache/whisper /app/instructions /app/skills \
    && chown -R app:app /app /workdir

COPY --from=browser-download --chown=app:app /ms-playwright /ms-playwright
COPY --from=audio-dependencies /opt/audio /opt/audio
COPY --from=production-dependencies --chown=app:app /build/node_modules /app/node_modules

ENV NODE_ENV=production
ENV PATH="/opt/audio/bin:/app/node_modules/.bin:${PATH}"

COPY --from=production-dependencies --chown=app:app /build/apps/bot/package.json /app/apps/bot/package.json
COPY --from=production-dependencies --chown=app:app /build/packages/login/package.json /app/packages/login/package.json
COPY --from=production-dependencies --chown=app:app /build/packages/progress/package.json /app/packages/progress/package.json
COPY --from=production-dependencies --chown=app:app /build/packages/url-content/package.json /app/packages/url-content/package.json
COPY --from=production-dependencies --chown=app:app /build/packages/url-tool/package.json /app/packages/url-tool/package.json
COPY --from=login-build --chown=app:app /build/packages/login/dist /app/packages/login/dist
COPY --from=progress-build --chown=app:app /build/packages/progress/dist /app/packages/progress/dist
COPY --from=url-content-build --chown=app:app /build/packages/url-content/dist /app/packages/url-content/dist
COPY --from=url-tool-build --chown=app:app /build/packages/url-tool/dist /app/packages/url-tool/dist
COPY --from=build --chown=app:app /build/apps/bot/dist /app/apps/bot/dist
COPY --chown=app:app packages/url-content/skills/ /app/packages/url-content/skills/
COPY --chown=app:app packages/url-tool/skills/ /app/packages/url-tool/skills/
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
