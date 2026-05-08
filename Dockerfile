# Use the official Node 22 LTS image. better-sqlite3 ships prebuilt
# binaries for this Node version, and Playwright will install Chromium +
# its OS dependencies into this image during build.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/data/cookie-proxy.db \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# Install only what's needed to run "playwright install --with-deps"
# (which then installs every Chromium runtime library it needs).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
 && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

# Have Playwright install Chromium + every system dep it requires.
RUN npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

COPY src ./src
COPY bin ./bin

# Create a non-root user and a writable data dir for the SQLite file.
RUN groupadd -r app && useradd -r -g app -d /app app \
 && mkdir -p /data \
 && chown -R app:app /data /app /ms-playwright
USER app

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

CMD ["node", "src/server.js"]
