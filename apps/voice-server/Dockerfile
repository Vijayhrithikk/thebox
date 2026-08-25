# Built with the repo root as build context (pnpm workspace needs the root
# lockfile) — see fly.toml, which points --dockerfile here but deploys from
# the repo root: `fly deploy --config apps/voice-server/fly.toml`.

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/voice-server/package.json ./apps/voice-server/package.json
RUN pnpm install --frozen-lockfile --filter voice-server...

FROM deps AS build
COPY apps/voice-server ./apps/voice-server
RUN pnpm --filter voice-server build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/voice-server/node_modules ./apps/voice-server/node_modules
COPY --from=build /app/apps/voice-server/dist ./apps/voice-server/dist
COPY apps/voice-server/package.json ./apps/voice-server/package.json
# RESUME_PATH/ARCHITECTURE_IMAGE_PATH default to ../../assets/... relative
# to this process's cwd (apps/voice-server) — needs this directory present
# at /app/assets for the post-call follow-up's attachments to resolve.
COPY assets ./assets

WORKDIR /app/apps/voice-server
EXPOSE 8080
CMD ["node", "dist/server.js"]
