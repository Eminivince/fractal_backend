# Dockerfile for the Fractal API service.
# Build: docker build -t fractal-api .
# Run:   docker run -p 4000:4000 --env-file .env fractal-api

FROM node:24-alpine AS base
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

FROM base AS deps
COPY package.json ./
RUN pnpm install --no-frozen-lockfile

FROM deps AS builder
COPY tsconfig*.json ./
COPY src ./src
COPY scripts ./scripts
RUN pnpm run build
RUN pnpm prune --prod

FROM node:24-alpine AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 fractal && \
    adduser --system --uid 1001 fractal

COPY --from=builder --chown=fractal:fractal /app/dist ./dist
COPY --from=builder --chown=fractal:fractal /app/package.json ./package.json
COPY --from=builder --chown=fractal:fractal /app/node_modules ./node_modules

USER fractal

EXPOSE 4000
ENV NODE_ENV=production
ENV PORT=4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/livez').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

# --import preloads OpenTelemetry instrumentation before the app (no-op unless OTEL_ENABLED).
CMD ["node", "--import", "./dist/instrumentation.js", "dist/server.js"]
