# Chorus — Node + Express + Socket.io + SQLite (better-sqlite3)
FROM node:20-bookworm-slim

# better-sqlite3 may compile a native addon → needs a build toolchain.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# App source
COPY server.js ./
COPY public ./public

# Listen on all interfaces inside the container; persist the DB on a volume.
ENV HOST=0.0.0.0
ENV PORT=3000
ENV CHORUS_DB=/data/chorus.db
VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server.js"]
