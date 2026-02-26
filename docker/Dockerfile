FROM oven/bun:1.3.5 AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Build client
FROM deps AS build

ARG APP_VERSION=""
ARG APP_BUILD_DATE=""
ARG APP_COMMIT_HASH=""
ARG APP_BRANCH=""
ENV VITE_APP_VERSION=$APP_VERSION
ENV VITE_APP_BUILD_DATE=$APP_BUILD_DATE
ENV VITE_APP_COMMIT_HASH=$APP_COMMIT_HASH
ENV VITE_APP_BRANCH=$APP_BRANCH

COPY . .
RUN bun run build

# Production image
FROM base AS production
RUN apt-get update && apt-get install -y openssh-client && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
RUN rm -rf node_modules/esbuild node_modules/@esbuild node_modules/@esbuild-kit \
    node_modules/vite node_modules/@vitejs node_modules/drizzle-kit \
    node_modules/esbuild-register node_modules/@drizzle-team
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/package.json ./
COPY docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh && mkdir -p /data

ENV NODE_ENV=production
ENV LUDASH_DB_PATH=/data/dashboard.db
EXPOSE 3001

ENTRYPOINT ["./entrypoint.sh"]
CMD ["bun", "run", "server/index.ts"]
