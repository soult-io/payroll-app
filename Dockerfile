# syntax=docker/dockerfile:1
# Multi-stage build per plan/specs/deployment.md (spec 8):
#   build web → build server → node:22-alpine runtime.
# The same image serves the app and runs the app-migrate one-shot.

## ---- build: install deps, build all packages (web + server + libs) ----
FROM node:22-alpine AS build
RUN npm install -g pnpm@11.17.0
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
# pnpm -r builds in topological order: engine/shared/db → web/server.
RUN pnpm -r run build
# Self-contained production deploys (workspace:* deps resolved + inlined).
RUN pnpm deploy --legacy --filter @payroll/server --prod /prod/app
RUN pnpm deploy --legacy --filter @payroll/db --prod /prod/db

## ---- runtime: node:22-alpine, non-root, healthcheck on /health ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8989 \
    SECRETS_DIR=/run/secrets
WORKDIR /app
# Strip npm/npx/yarn/corepack from the runtime image: the app runs `node`
# directly and drizzle-kit runs via its own node shebang — none of these
# package managers are needed, and npm bundles a CRITICAL-vulnerable tar
# (CVE-2026-59873, Trivy gate). Also shrinks the attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /opt/yarn-v* \
           /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg \
           /usr/local/bin/corepack
RUN addgroup -S payroll && adduser -S payroll -G payroll
COPY --from=build --chown=payroll:payroll /prod/app ./
# Built SPA — Fastify static serving is wired in a later step (spec 8 says the
# server serves the SPA; step 1 only ships the assets in the image).
COPY --from=build --chown=payroll:payroll /app/apps/web/dist ./public
# Migration package for the app-migrate one-shot: drizzle-kit + SQL migrations.
COPY --from=build --chown=payroll:payroll /prod/db ./db
USER payroll
EXPOSE 8989
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8989/health || exit 1
CMD ["node", "dist/index.js"]
