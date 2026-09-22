ARG PLAYWRIGHT_VERSION=1.63.0

FROM node:24-bookworm-slim AS dependencies

WORKDIR /build

COPY package.json package-lock.json ./
COPY apps/bot/package.json apps/bot/package.json
COPY packages/progress/package.json packages/progress/package.json
COPY packages/url-content/package.json packages/url-content/package.json
COPY packages/url-tool/package.json packages/url-tool/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --workspace @narumitw/sumire --include-workspace-root=false

FROM dependencies AS build

COPY packages/progress/ packages/progress/
COPY packages/url-content/ packages/url-content/
COPY packages/url-tool/ packages/url-tool/
COPY apps/bot/ apps/bot/
RUN npm run build --workspace @narumitw/sumire

FROM dependencies AS production-dependencies

RUN npm prune --omit=dev --workspace @narumitw/sumire --include-workspace-root=false

FROM node:24-bookworm-slim AS runtime

ARG PLAYWRIGHT_VERSION
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    npx --yes playwright@${PLAYWRIGHT_VERSION} install-deps chromium
RUN --mount=type=cache,target=/root/.npm \
    npx --yes playwright@${PLAYWRIGHT_VERSION} install chromium

WORKDIR /app

RUN groupadd --system app \
    && useradd --system --gid app --home-dir /app --shell /usr/sbin/nologin app \
    && mkdir -p /app/apps/bot /app/packages/progress /app/packages/url-content /app/packages/url-tool /app/.telegramagent /app/.events /app/skills \
    && chown -R app:app /app /ms-playwright

COPY --from=production-dependencies --chown=app:app /build/node_modules /app/node_modules

ENV NODE_ENV=production
ENV PATH="/app/node_modules/.bin:${PATH}"

COPY --from=build --chown=app:app /build/apps/bot/dist /app/apps/bot/dist
COPY --from=build --chown=app:app /build/apps/bot/package.json /app/apps/bot/package.json
COPY --from=build --chown=app:app /build/packages/progress/dist /app/packages/progress/dist
COPY --from=build --chown=app:app /build/packages/progress/package.json /app/packages/progress/package.json
COPY --from=build --chown=app:app /build/packages/url-content/dist /app/packages/url-content/dist
COPY --from=build --chown=app:app /build/packages/url-content/package.json /app/packages/url-content/package.json
COPY --from=build --chown=app:app /build/packages/url-tool/dist /app/packages/url-tool/dist
COPY --from=build --chown=app:app /build/packages/url-tool/skills /app/packages/url-tool/skills
COPY --from=build --chown=app:app /build/packages/url-tool/package.json /app/packages/url-tool/package.json
COPY --chown=app:app skills/ /app/skills/
COPY --chown=app:app SOUL.md /app/SOUL.md

USER app

ENTRYPOINT ["node", "/app/apps/bot/dist/index.js"]
