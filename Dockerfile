FROM oven/bun:1-slim AS builder
WORKDIR /app
COPY package.json ./
RUN bun install
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN bun install --production
COPY --from=builder /app/dist ./dist
COPY public ./public
COPY docs ./docs
COPY scripts ./scripts
EXPOSE 8765
ENTRYPOINT ["bun", "/app/dist/cli.js"]
