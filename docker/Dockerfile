ARG NODE_VERSION=24.15.0
FROM node:${NODE_VERSION}-trixie-slim AS base
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade libc6 libc-bin \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@10.33.0

# Install dependencies
FROM base AS deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

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
RUN pnpm run build \
    && pnpm prune --prod

# Production image
FROM base AS production
ARG APP_VERSION=""
ARG APP_BUILD_DATE=""
ARG APP_COMMIT_HASH=""
ARG APP_BRANCH=""
ARG APP_REPOSITORY=""
ARG APP_REPO_URL=""

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/assets ./assets
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
  CMD node -e "fetch('http://localhost:3001/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "dist/server/index.js"]
