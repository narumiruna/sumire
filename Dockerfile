FROM node:24-bookworm-slim AS dependencies

WORKDIR /build

COPY package.json package-lock.json ./
COPY apps/bot/package.json apps/bot/package.json
COPY packages/kabigon/package.json packages/kabigon/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --workspace telegramagent-typescript --include-workspace-root=false

FROM dependencies AS build

COPY packages/kabigon/ packages/kabigon/
COPY apps/bot/ apps/bot/
RUN npm run build --workspace telegramagent-typescript

FROM dependencies AS production-dependencies

RUN npm prune --omit=dev --workspace telegramagent-typescript --include-workspace-root=false

FROM node:24-bookworm-slim

WORKDIR /app

RUN groupadd --system app \
    && useradd --system --gid app --home-dir /app --shell /usr/sbin/nologin app \
    && mkdir -p /app/apps/bot /app/packages/kabigon /app/.telegramagent /app/.events /app/skills \
    && chown -R app:app /app

COPY --from=production-dependencies --chown=app:app /build/node_modules /app/node_modules

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN ./node_modules/.bin/playwright install --with-deps chromium \
    && chown -R app:app /ms-playwright

COPY --from=build --chown=app:app /build/apps/bot/dist /app/apps/bot/dist
COPY --from=build --chown=app:app /build/apps/bot/package.json /app/apps/bot/package.json
COPY --from=build --chown=app:app /build/packages/kabigon/dist /app/packages/kabigon/dist
COPY --from=build --chown=app:app /build/packages/kabigon/package.json /app/packages/kabigon/package.json
COPY --chown=app:app SOUL.md /app/SOUL.md

USER app

ENTRYPOINT ["node", "/app/apps/bot/dist/index.js"]
