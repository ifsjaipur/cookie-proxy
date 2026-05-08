# Playwright base image ships Chromium and all Linux deps preinstalled.
# We replace the bundled Node with Node 22 LTS so better-sqlite3 has
# matching prebuilt binaries (it ships prebuilds for Node 20/22, not 24).
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/data/cookie-proxy.db

# Install Node 22 LTS from NodeSource and force it onto the PATH ahead of
# the Playwright base image's bundled Node 24 (which lives in /usr/local/bin
# and would otherwise win). better-sqlite3 ships prebuilt binaries for Node
# 22 but not yet for Node 24, so we need 22 specifically.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && ln -sf /usr/bin/node /usr/local/bin/node \
 && ln -sf /usr/bin/npm /usr/local/bin/npm \
 && ln -sf /usr/bin/npx /usr/local/bin/npx \
 && node --version \
 && npm --version \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Scripts ARE allowed so better-sqlite3 can install its prebuilt binary
# (or compile from source if no prebuild exists for this platform).
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY bin ./bin

RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
USER pwuser

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

CMD ["node", "src/server.js"]
