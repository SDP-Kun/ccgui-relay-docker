# syntax=docker/dockerfile:1

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-alpine

LABEL org.opencontainers.image.title="ccgui-relay" \
      org.opencontainers.image.description="Self-hosted relay for CC GUI remote access" \
      org.opencontainers.image.source="https://github.com/SDP-Kun/ccgui-relay-docker" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=8787

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]