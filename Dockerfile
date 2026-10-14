# syntax=docker/dockerfile:1.7

# ---- builder: compile TypeScript ----
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:20-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash app

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY public ./public
COPY docs ./docs
RUN chown -R app:app /app

USER app
WORKDIR /home/app
RUN curl -fsSL https://cursor.com/install | bash

ENV PATH=/home/app/.local/bin:$PATH \
    NODE_ENV=production \
    CURSOR_BRIDGE_HOST=0.0.0.0 \
    CURSOR_BRIDGE_PORT=8765

WORKDIR /app
EXPOSE 8765

# /healthz bypasses CURSOR_BRIDGE_API_KEY — safer for container probes
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8765/healthz || exit 1

ENTRYPOINT ["node", "/app/dist/cli.js"]
