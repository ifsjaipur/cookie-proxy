# Playwright base image ships Chromium and all Linux deps preinstalled.
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/data/cookie-proxy.db

WORKDIR /app

# Copy manifest and install. Scripts ARE allowed so better-sqlite3 can
# compile its native binding against the container's Node + glibc.
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
