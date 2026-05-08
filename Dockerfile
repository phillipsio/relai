# syntax=docker/dockerfile:1.6
#
# Production image for the @getrelai/api service.
#
# The shared workspace packages (@getrelai/db, @getrelai/types) export
# TypeScript source directly — no build step — so we run the API from source
# under tsx instead of fighting the monorepo build graph.

FROM node:20-alpine AS base
RUN apk add --no-cache tini
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

# ── deps ──────────────────────────────────────────────────────────────────────
# Copy only manifests first so the install layer caches across source edits.
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/api/package.json           packages/api/package.json
COPY shared/db/package.json              shared/db/package.json
COPY shared/types/package.json           shared/types/package.json
RUN pnpm install --frozen-lockfile \
      --filter @getrelai/api... \
      --filter @getrelai/db... \
      --filter @getrelai/types...

# ── runtime ───────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules                       node_modules
COPY --from=deps /app/packages/api/node_modules          packages/api/node_modules
COPY --from=deps /app/shared/db/node_modules             shared/db/node_modules
COPY pnpm-workspace.yaml package.json                    ./
COPY packages/api                                        packages/api
COPY shared/db                                           shared/db
COPY shared/types                                        shared/types

EXPOSE 3010
USER node
WORKDIR /app/packages/api
ENTRYPOINT ["/sbin/tini", "--"]
# Invoke tsx via the api package's binary. Avoids pnpm at runtime (corepack
# tries to resolve a newer pnpm than the build-time pin) and works with
# pnpm's non-hoisted layout where tsx lives in this package's node_modules.
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
