FROM oven/bun:1.3.10 AS base
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
ARG APP_REPOSITORY=""
ARG APP_REPO_URL=""
ENV VITE_APP_VERSION=$APP_VERSION
ENV VITE_APP_BUILD_DATE=$APP_BUILD_DATE
ENV VITE_APP_COMMIT_HASH=$APP_COMMIT_HASH
ENV VITE_APP_BRANCH=$APP_BRANCH
ENV VITE_APP_REPOSITORY=$APP_REPOSITORY
ENV VITE_APP_REPO_URL=$APP_REPO_URL

COPY . .
RUN bun run build

# Production image
FROM base AS production
ARG APP_VERSION=""
ARG APP_BUILD_DATE=""
ARG APP_COMMIT_HASH=""
ARG APP_BRANCH=""
ARG APP_REPOSITORY=""
ARG APP_REPO_URL=""
RUN apt-get update && apt-get install -y openssh-client && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
RUN rm -rf node_modules/esbuild node_modules/@esbuild node_modules/@esbuild-kit \
    node_modules/vite node_modules/@vitejs
COPY --from=build /app/dist ./dist
COPY --from=build /app/assets ./assets
COPY --from=build /app/server ./server
COPY --from=build /app/package.json ./
COPY docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh && mkdir -p /data

ENV NODE_ENV=production
ENV LUDASH_DB_PATH=/data/dashboard.db
ENV LUDASH_APP_VERSION=$APP_VERSION
ENV LUDASH_APP_BRANCH=$APP_BRANCH
ENV LUDASH_APP_REPOSITORY=$APP_REPOSITORY
ENV LUDASH_APP_REPO_URL=$APP_REPO_URL
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3001/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["./entrypoint.sh"]
CMD ["bun", "run", "server/index.ts"]
