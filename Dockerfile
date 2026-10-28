# syntax=docker/dockerfile:1

# Match the libcurl release pinned by impers 0.1.2; verify each platform's archive.
FROM node:26-bookworm-slim AS curl-impersonate

ARG TARGETARCH
RUN rm -f /etc/apt/apt.conf.d/docker-clean
RUN --mount=type=cache,id=apt-cache-${TARGETARCH},target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lists-${TARGETARCH},target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl
RUN --mount=type=bind,source=scripts/install-curl-impersonate.sh,target=/tmp/install-curl-impersonate.sh \
    sh /tmp/install-curl-impersonate.sh

FROM node:26-bookworm-slim AS dependencies

WORKDIR /build

COPY package.json package-lock.json ./
COPY apps/bot/package.json apps/bot/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/policy/package.json packages/policy/package.json
COPY packages/login/package.json packages/login/package.json
COPY packages/progress/package.json packages/progress/package.json
COPY packages/imagegen/package.json packages/imagegen/package.json
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

FROM dependencies AS progress-build

COPY packages/progress/tsconfig*.json packages/progress/
COPY packages/progress/src/ packages/progress/src/
RUN npm run build --workspace @narumitw/sumire-progress

FROM dependencies AS imagegen-build

COPY packages/imagegen/tsconfig*.json packages/imagegen/
COPY packages/imagegen/src/ packages/imagegen/src/
RUN npm run build --workspace @narumitw/sumire-imagegen

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

COPY --from=progress-build /build/packages/progress/dist /build/packages/progress/dist
COPY --from=imagegen-build /build/packages/imagegen/dist /build/packages/imagegen/dist
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

# Assemble the same application tree for CI import checks and the final image.
FROM node:26-bookworm-slim AS runtime-application

WORKDIR /app
ENV NODE_ENV=production

COPY --from=production-dependencies /build/node_modules /app/node_modules
# These directories contain only manifests and workspace-local production dependencies.
COPY --from=production-dependencies /build/apps/bot /app/apps/bot
COPY --from=production-dependencies /build/packages /app/packages
COPY --from=policy-build /build/packages/policy/dist /app/packages/policy/dist
COPY --from=contracts-build /build/packages/contracts/dist /app/packages/contracts/dist
COPY --from=progress-build /build/packages/progress/dist /app/packages/progress/dist
COPY --from=imagegen-build /build/packages/imagegen/dist /app/packages/imagegen/dist
COPY --from=url-reader-build /build/packages/url-reader/dist /app/packages/url-reader/dist
COPY --from=pi-url-reader-build /build/packages/pi-url-reader/dist /app/packages/pi-url-reader/dist
COPY --from=polymarket-build /build/packages/pi-polymarket/dist /app/packages/pi-polymarket/dist
COPY --from=build /build/apps/bot/dist /app/apps/bot/dist
COPY --from=admin-build /build/apps/admin/dist /app/apps/admin/dist

# Import without credentials or network access; do not start the bot.
RUN --network=none node --input-type=module -e "await import('/app/apps/bot/dist/startup.js')"

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
COPY --from=runtime-application --chown=app:app /app /app

ENV NODE_ENV=production
ENV PATH="/opt/audio/bin:/app/node_modules/.bin:${PATH}"

COPY --chown=app:app packages/pi-url-reader/skills/ /app/packages/pi-url-reader/skills/
COPY --chown=app:app instructions/ /app/instructions/
COPY --chown=app:app skills/ /app/skills/
COPY --chown=app:app apps/bot/scripts/ /app/apps/bot/scripts/

# Check startup again in the complete runtime image.
RUN node --input-type=module -e "await import('/app/apps/bot/dist/startup.js')"

ENV HOME=/workdir
USER app

# Import image generation offline as the runtime user; do not resolve auth or consume quota.
RUN --network=none node --input-type=module -e "const m = await import('/app/packages/imagegen/dist/index.js'); if (typeof m.generateImage !== 'function') process.exit(1)"

# Verify both locked browser binaries and a real offline headless launch as the runtime user.
RUN --network=none node /app/apps/bot/scripts/check-browser.mjs

# Check Chrome fingerprint compatibility offline, using the runtime user's library.
RUN --network=none node /app/apps/bot/scripts/check-curl-impersonate.mjs

# Verify URL diagnostics and installed media tools without external requests or model downloads.
RUN --network=none node /app/apps/bot/scripts/check-url-failures.mjs

# Fail the build if Git or SSH tools are unavailable to the bot user.
RUN git --version && ssh -V && command -v ssh-keygen

ENTRYPOINT ["node", "/app/apps/bot/dist/index.js"]
