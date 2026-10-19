# syntax=docker/dockerfile:1.6

# Dependencias completas (compila TypeScript). npm ci = reproducible desde package-lock.json.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Solo dependencias de producción, podadas del árbol ya instalado (sin segunda descarga).
FROM deps AS prod-deps
RUN npm prune --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini curl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/sesiones /app/static \
    && chown -R node:node /app

USER node
EXPOSE 3005
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
