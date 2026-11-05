FROM node:24-bookworm-slim@sha256:6042915a8b58012e6699f998ed96bca43ec9d8582447bdb68bc2445d0fafeb79 AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
RUN npm run db:generate && npm run check && npm run build

FROM build AS migrate
CMD ["sh", "-c", "npm run db:migrate && node scripts/grant-runtime.mjs"]

FROM build AS production-dependencies
RUN npm prune --omit=dev --no-audit --no-fund

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DEMO_ENABLED=false
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/data ./data
COPY --from=build --chown=node:node /app/demo ./demo
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/kari/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/api/main.js"]
