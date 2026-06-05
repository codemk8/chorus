# Chorus — Node + Express + Socket.io + SQLite (better-sqlite3)
FROM node:20-bookworm-slim

# better-sqlite3 may compile a native addon → needs a build toolchain.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Install deps first (better layer caching). --omit=dev skips test-only packages.
COPY package*.json ./
RUN npm ci --omit=dev

# App source
COPY server.js ./
COPY public ./public

# Listen on all interfaces inside the container; persist the DB on a volume that
# the non-root runtime user can write to.
ENV HOST=0.0.0.0
ENV PORT=3000
ENV CHORUS_DB=/data/chorus.db
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
EXPOSE 3000

# Drop privileges for runtime.
USER node

# Container health from the built-in probe.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
