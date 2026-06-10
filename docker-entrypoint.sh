#!/bin/sh
set -e

# Started as root (the image default): make the data directory writable by the
# runtime user — bind mounts and platform volumes (Fly.io, Render disks, …)
# often arrive root-owned, which would crash SQLite at boot with
# SQLITE_CANTOPEN — then drop privileges for the actual process.
#
# Started with --user <uid>: skip all of that and exec straight through.
if [ "$(id -u)" = "0" ]; then
  DATA_DIR="$(dirname "${CHORUS_DB:-/data/chorus.db}")"
  mkdir -p "$DATA_DIR" 2>/dev/null || true
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  exec gosu node "$@"
fi

exec "$@"
