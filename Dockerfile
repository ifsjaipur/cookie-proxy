# Playwright base image ships Chromium and all Linux deps preinstalled.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/data/cookie-proxy.db \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Install deps without running the postinstall (browser already present in base image).
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

COPY src ./src
COPY bin ./bin

RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
USER pwuser

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
