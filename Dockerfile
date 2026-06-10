# Chorus — Node + Express + Socket.io + SQLite (better-sqlite3)
FROM node:22-bookworm-slim

# better-sqlite3 may compile a native addon → needs a build toolchain.
# gosu lets the entrypoint fix volume ownership as root, then drop privileges.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ gosu \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Install deps first (better layer caching). --omit=dev skips test-only packages.
COPY package*.json ./
RUN npm ci --omit=dev

# App source
COPY server.js ./
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Listen on all interfaces inside the container; persist the DB on a volume.
ENV HOST=0.0.0.0
ENV PORT=3000
ENV CHORUS_DB=/data/chorus.db
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
EXPOSE 3000

# The container starts as root ONLY so the entrypoint can chown /data — bind
# mounts and platform volumes (Fly.io, etc.) often arrive root-owned, which
# would otherwise crash SQLite at boot — then it drops to the 'node' user.
# Running with --user is also supported: the entrypoint execs straight through.

# Container health from the built-in probe.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
