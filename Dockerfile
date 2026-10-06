# Build stage: install production dependencies, with the toolchain that
# better-sqlite3 needs if no prebuilt binary matches this platform.
FROM node:22-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# PDF.js's optional canvas is for drawing PDFs in Node; the app draws them in
# the browser, so it is left out.
RUN npm ci --omit=dev --omit=optional

COPY server ./server
COPY public ./public
COPY scanner-helper ./scanner-helper

# Runtime stage: Node, the built app, and Chromium's headless shell, which
# prints the reports to PDF for "Download all reports" (the full Chromium
# instead if this Debian has no headless shell), with fonts for it.
FROM node:22-slim

RUN apt-get update \
  && (apt-get install -y --no-install-recommends chromium-headless-shell \
      || apt-get install -y --no-install-recommends chromium) \
  && apt-get install -y --no-install-recommends fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app

COPY --from=build /app /app

# The Fly volume is mounted here; this only matters when running without one.
RUN mkdir -p /data

EXPOSE 8080

CMD ["node", "server/index.js"]
