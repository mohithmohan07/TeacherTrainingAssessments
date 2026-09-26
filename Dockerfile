# Build stage: install production dependencies, with the toolchain that
# better-sqlite3 needs if no prebuilt binary matches this platform.
FROM node:22-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public
COPY scanner-helper ./scanner-helper

# Runtime stage: just Node and the built app.
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app

COPY --from=build /app /app

# The Fly volume is mounted here; this only matters when running without one.
RUN mkdir -p /data

EXPOSE 8080

CMD ["node", "server/index.js"]
