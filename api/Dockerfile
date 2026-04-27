# syntax=docker/dockerfile:1.6

FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git config --global url."https://github.com/".insteadOf "git@github.com:" \
 && git config --global url."https://".insteadOf "git+ssh://git@" \
 && git config --global url."https://github.com/".insteadOf "git+ssh://git@github.com/"
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS prod-deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git config --global url."https://github.com/".insteadOf "git@github.com:" \
 && git config --global url."https://".insteadOf "git+ssh://git@" \
 && git config --global url."https://github.com/".insteadOf "git+ssh://git@github.com/"
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini curl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/sesiones /app/static /app/backups \
    && chown -R node:node /app

USER node
EXPOSE 3005
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
