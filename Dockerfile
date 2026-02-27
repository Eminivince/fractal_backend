# A-87: Dockerfile for the Fractal API service
# Build: docker build -t fractal-api -f apps/api/Dockerfile .
# Run:   docker run -p 4000:4000 --env-file .env fractal-api

FROM node:20-alpine AS base
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# ── Dependencies ──────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
RUN pnpm install --frozen-lockfile --filter=api

# ── Build ─────────────────────────────────────────────────────────────────────
FROM deps AS builder
COPY apps/api ./apps/api
COPY tsconfig*.json ./
WORKDIR /app/apps/api
RUN pnpm run build

# ── Production image ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# Security: run as non-root user
RUN addgroup --system --gid 1001 fractal && \
    adduser --system --uid 1001 fractal

COPY --from=builder --chown=fractal:fractal /app/apps/api/dist ./dist
COPY --from=deps --chown=fractal:fractal /app/node_modules ./node_modules
COPY --from=deps --chown=fractal:fractal /app/apps/api/node_modules ./apps/api/node_modules

USER fractal

EXPOSE 4000
ENV NODE_ENV=production
ENV PORT=4000

CMD ["node", "dist/server.js"]
