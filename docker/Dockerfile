FROM oven/bun:1.3.5 AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production=false

# Build client
FROM deps AS build
COPY . .
RUN bun run build

# Production image
FROM base AS production
RUN apt-get update && apt-get install -y openssh-client && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./
COPY docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh && mkdir -p /data

ENV NODE_ENV=production
ENV LUDASH_DB_PATH=/data/dashboard.db
EXPOSE 3001

ENTRYPOINT ["./entrypoint.sh"]
CMD ["bun", "run", "server/index.ts"]
