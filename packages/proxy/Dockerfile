# syntax=docker/dockerfile:1

FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@12.3.4 --activate
WORKDIR /app

FROM base AS install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile

FROM install AS build
RUN pnpm --filter @keylease/cli build && pnpm --filter @keylease/proxy build
RUN pnpm --filter @keylease/proxy deploy --prod /app/deploy

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup --system keylease && adduser --system --ingroup keylease keylease
COPY --from=build --chown=keylease:keylease /app/deploy /app
USER keylease
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "packages/proxy/dist/index.js"]
