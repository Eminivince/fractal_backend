# A-87: Dockerfile for the Fractal API service
# Build: docker build -t fractal-api -f apps/api/Dockerfile .
# Run:   docker run -p 4000:4000 --env-file .env fractal-api

FROM node:24-alpine AS base
WORKDIR /app

# Use the workspace-pinned package manager for reproducible image builds.
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# ── Dependencies ──────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
RUN pnpm --filter @fractal/api... install --frozen-lockfile

# ── Build ─────────────────────────────────────────────────────────────────────
FROM deps AS builder
COPY apps/api ./apps/api
COPY tsconfig*.json ./
WORKDIR /app/apps/api
RUN pnpm run build

# ── Production image ──────────────────────────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app

# Security: run as non-root user
RUN addgroup --system --gid 1001 fractal && \
    adduser --system --uid 1001 fractal

COPY --from=builder --chown=fractal:fractal /app/apps/api/dist ./dist
# `dist/*.js` is ESM. Preserve the package boundary/type at the flattened
# runtime root so Node does not reinterpret the server as CommonJS.
COPY --from=builder --chown=fractal:fractal /app/apps/api/package.json ./package.json
COPY --from=deps --chown=fractal:fractal /app/node_modules ./node_modules
COPY --from=deps --chown=fractal:fractal /app/apps/api/node_modules ./apps/api/node_modules

USER fractal

EXPOSE 4000
ENV NODE_ENV=production
ENV PORT=4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/livez').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

# --import preloads OpenTelemetry instrumentation before the app (no-op unless OTEL_ENABLED).
CMD ["node", "--import", "./dist/instrumentation.js", "dist/server.js"]
