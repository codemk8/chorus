'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');

// ---------------------------------------------------------------------------
// CLI helper: read `--flag value` and `--flag=value` from argv.
// ---------------------------------------------------------------------------
function cliArg(name) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Access gate (login). ON by default. Provide your own credentials with
// CHORUS_USER / CHORUS_PASSWORD (or --user / --password); otherwise a username
// ('admin') and a random password are generated and printed to stdout on boot.
// Turn auth off entirely with --no-auth (or CHORUS_NO_AUTH=1).
// ---------------------------------------------------------------------------
function genPassword() {
  const cs = 'abcdefghijkmnpqrstuvwxyz23456789ACDEFGHJKLMNPQRSTUVWXYZ'; // no ambiguous 0/O/1/l/I
  const r = crypto.randomBytes(12);
  let s = ''; for (let i = 0; i < 12; i++) s += cs[r[i] % cs.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
const AUTH_REQUIRED = !(process.env.CHORUS_NO_AUTH === '1' || process.argv.slice(2).includes('--no-auth'));
const AUTH_USER = process.env.CHORUS_USER || cliArg('user') || 'admin';
const AUTH_PW_GENERATED = AUTH_REQUIRED && !(process.env.CHORUS_PASSWORD || cliArg('password'));
const AUTH_PASSWORD = !AUTH_REQUIRED ? '' : (process.env.CHORUS_PASSWORD || cliArg('password') || genPassword());
// A fresh random token each boot; a client swaps the credentials for it once,
// then presents it on every request and socket. Restarting logs everyone out.
const AUTH_TOKEN = AUTH_REQUIRED ? crypto.randomBytes(32).toString('hex') : '';
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function bearerToken(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}
function requireAuth(req, res, next) {
  if (!AUTH_REQUIRED || safeEqual(bearerToken(req), AUTH_TOKEN)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}
// Per-IP throttle so the password can't be brute-forced (10 tries / 5 min).
const loginHits = new Map();
function loginThrottle(ip) {
  const now = Date.now();
  let b = loginHits.get(ip);
  if (!b || now - b.start >= 5 * 60 * 1000) { b = { start: now, count: 0 }; loginHits.set(ip, b); }
  b.count += 1;
  return b.count <= 10;
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------
// The DB lives next to server.js by default (independent of port / cwd). Set
// CHORUS_DB to point elsewhere — tests use a throwaway file so they can never
// clobber real data.
const DB_PATH = process.env.CHORUS_DB || path.join(__dirname, 'chorus.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL'); // durable + fast under WAL

// A topic's shared playground is one document made of many "blocks" — ordered
// paragraphs. Each block is OWNED by one author and editable only by them, so
// two people never touch the same text: the document is merge-conflict-free
// without a CRDT. Anyone can add their own blocks anywhere (fractional
// `position` lets a block slot in between two others).
db.exec(`
  CREATE TABLE IF NOT EXISTS topics (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS blocks (
    id         TEXT PRIMARY KEY,
    topic_id   INTEGER NOT NULL,
    owner_id   TEXT NOT NULL DEFAULT '',
    author     TEXT NOT NULL,
    content    TEXT NOT NULL DEFAULT '',
    position   REAL NOT NULL,
    state      TEXT NOT NULL DEFAULT 'published',  -- 'editing' (being written) | 'published'
    last_modified_by TEXT NOT NULL DEFAULT '',      -- display name of the last editor
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (topic_id) REFERENCES topics(id)
  );

  CREATE INDEX IF NOT EXISTS idx_blocks_topic ON blocks (topic_id, position);
`);

// Migrations for older DBs.
const blockCols = db.prepare('PRAGMA table_info(blocks)').all().map((c) => c.name);
if (!blockCols.includes('owner_id')) {
  db.exec("ALTER TABLE blocks ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''");
  db.exec('UPDATE blocks SET owner_id = author WHERE owner_id = \'\'');
}
if (!blockCols.includes('state')) {
  db.exec("ALTER TABLE blocks ADD COLUMN state TEXT NOT NULL DEFAULT 'published'");
}
if (!blockCols.includes('last_modified_by')) {
  db.exec("ALTER TABLE blocks ADD COLUMN last_modified_by TEXT NOT NULL DEFAULT ''");
  db.exec('UPDATE blocks SET last_modified_by = author WHERE last_modified_by = \'\'');
}
// On boot, nothing is mid-edit — any leftover 'editing' rows are stale.
db.exec("UPDATE blocks SET state = 'published' WHERE state = 'editing'");

// Prepared statements
const q = {
  allTopics: db.prepare('SELECT * FROM topics ORDER BY created_at ASC, id ASC'),
  topicById: db.prepare('SELECT * FROM topics WHERE id = ?'),
  insertTopic: db.prepare('INSERT INTO topics (title, created_at) VALUES (?, ?)'),
  // The shared document = every non-empty block, in reading order.
  blocksByTopic: db.prepare(
    "SELECT * FROM blocks WHERE topic_id = ? AND content <> '' ORDER BY position ASC, created_at ASC, id ASC"
  ),
  blockById: db.prepare('SELECT * FROM blocks WHERE id = ?'),
  insertBlock: db.prepare(
    'INSERT INTO blocks (id, topic_id, owner_id, author, content, position, state, last_modified_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  // Anyone may edit; we record who last touched it. The creator (author/owner_id) is kept as-is.
  updateBlock: db.prepare('UPDATE blocks SET content = ?, state = ?, last_modified_by = ?, updated_at = ? WHERE id = ?'),
  deleteBlock: db.prepare('DELETE FROM blocks WHERE id = ?'),
  countTopics: db.prepare('SELECT COUNT(*) AS n FROM topics'),
  countBlocksInTopic: db.prepare('SELECT COUNT(*) AS n FROM blocks WHERE topic_id = ?'),
};

// Public-demo guardrails — bound storage so a single server can't be flooded.
const LIMITS = {
  maxTopics: Number(process.env.MAX_TOPICS) || 300,
  maxBlocksPerTopic: Number(process.env.MAX_BLOCKS_PER_TOPIC) || 1000,
  maxContent: 100000,
  maxTitle: 120,
};

// Insert-or-update a block. ANYONE may edit any block; `editor` is the display
// name of whoever is making this change (recorded as last_modified_by). Returns
// the saved row (or null if the per-topic block cap is hit on insert).
function saveBlock({ id, topicId, ownerId, editor, content, position, state }) {
  const now = new Date().toISOString();
  const st = state === 'editing' ? 'editing' : 'published';
  const existing = q.blockById.get(id);
  if (existing) {
    q.updateBlock.run(content, st, editor, now, id);
  } else {
    if (!q.topicById.get(topicId)) return null; // no such topic → don't create orphan blocks
    if (q.countBlocksInTopic.get(topicId).n >= LIMITS.maxBlocksPerTopic) return null; // cap reached
    q.insertBlock.run(id, topicId, ownerId, editor, content, Number(position) || 0, st, editor, now, now);
  }
  return q.blockById.get(id);
}

// Delete a block — anyone may. Returns true if removed.
function removeBlock(id) {
  const existing = q.blockById.get(id);
  if (!existing) return false;
  q.deleteBlock.run(id);
  return true;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
// Behind a reverse proxy (Fly / Render / nginx / Cloudflare)? Set TRUST_PROXY=1
// (a hop count, or 'true') so req.ip — used by the login throttle — is the real
// client address, not the proxy's. Left off by default so X-Forwarded-For can't
// be spoofed when there's no proxy in front.
if (process.env.TRUST_PROXY) {
  const tp = process.env.TRUST_PROXY;
  app.set('trust proxy', tp === 'true' ? true : (Number(tp) || tp));
}
app.use(express.json({ limit: '256kb' }));

// Security headers. The client is one inline HTML/CSS/JS file plus a few libraries
// from jsdelivr, so the CSP permits 'unsafe-inline' and that one CDN; everything
// else is restricted to same-origin.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; font-src 'self' data:; " +
    "connect-src 'self' ws: wss:; " +
    "base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  next();
});

// Liveness/readiness probe for load balancers & uptime checks (no auth).
app.get(['/healthz', '/api/health'], (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use(express.static(path.join(__dirname, 'public'), {
  // The whole app (HTML + inline JS/CSS) is one file, so force the browser to
  // revalidate it on every load — a reload can never serve a stale build.
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Auth: tell the client whether a login is needed, and trade the password for a token.
app.get('/api/auth', (req, res) => res.json({ required: AUTH_REQUIRED }));
app.post('/api/login', (req, res) => {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (!loginThrottle(ip)) return res.status(429).json({ error: 'Too many attempts — wait a few minutes.' });
  if (!AUTH_REQUIRED) return res.json({ token: '' });
  const u = (req.body && req.body.username) || '';
  const p = (req.body && req.body.password) || '';
  if (safeEqual(u, AUTH_USER) && safeEqual(p, AUTH_PASSWORD)) return res.json({ token: AUTH_TOKEN });
  res.status(401).json({ error: 'Incorrect username or password.' });
});

// REST API — used to restore state on page load (gated by requireAuth when a password is set)
app.get('/api/topics', requireAuth, (req, res) => {
  res.json(q.allTopics.all());
});

// The topic's shared playground — every block, in reading order.
app.get('/api/topics/:id/blocks', requireAuth, (req, res) => {
  const topic = q.topicById.get(req.params.id);
  if (!topic) return res.status(404).json({ error: 'Topic not found' });
  res.json(q.blocksByTopic.all(req.params.id));
});

// The whole document, canonical shape: topic metadata + ordered owned blocks +
// the assembled Markdown (blocks joined in reading order).
app.get('/api/topics/:id/document', requireAuth, (req, res) => {
  const topic = q.topicById.get(req.params.id);
  if (!topic) return res.status(404).json({ error: 'Topic not found' });
  const blocks = q.blocksByTopic.all(req.params.id);
  res.json({
    id: topic.id,
    title: topic.title,
    created_at: topic.created_at,
    blocks, // [{ id, owner_id, author, content, position, created_at, updated_at }]
    markdown: blocks.map((b) => b.content).join('\n\n'),
  });
});

// Unknown /api/* path → JSON 404 (don't fall through to the static handler).
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Central error handler — return JSON and never leak a stack trace to clients.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err.status === 400 || err.statusCode === 400)) {
    return res.status(400).json({ error: 'Bad request' });
  }
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'Payload too large' });
  }
  console.error('HTTP error:', err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Server error' });
});

// ---------------------------------------------------------------------------
// Socket.io real-time layer
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 256 * 1024 }); // bound inbound payloads

// Realtime auth: when a password is set, every socket must present the token.
io.use((socket, next) => {
  if (!AUTH_REQUIRED) return next();
  const tok = (socket.handshake.auth && socket.handshake.auth.token) || '';
  if (safeEqual(tok, AUTH_TOKEN)) return next();
  next(new Error('unauthorized'));
});

const roomName = (topicId) => `topic:${topicId}`;

// Per-socket fixed-window rate limiter. Returns false when the caller should
// drop the event. Keeps one server from being flooded by a single connection.
function rateLimit(socket, key, max, windowMs) {
  const now = Date.now();
  const buckets = socket.data.rl || (socket.data.rl = {});
  let b = buckets[key];
  if (!b || now - b.start >= windowMs) b = buckets[key] = { start: now, count: 0 };
  b.count += 1;
  return b.count <= max;
}

// Distinct online display-names currently inside a topic room.
async function onlineUsers(room) {
  const sockets = await io.in(room).fetchSockets();
  const names = sockets.map((s) => s.data.name).filter(Boolean);
  return [...new Set(names)];
}

async function broadcastUsers(room) {
  io.to(room).emit('users:update', await onlineUsers(room));
}

io.on('connection', (socket) => {
  socket.data.name = null;
  socket.data.topicId = null;

  // Wrap every handler: a malformed event or a transient DB error logs and drops,
  // it never takes down the process.
  const on = (event, fn) => socket.on(event, async (...args) => {
    try { await fn(...args); } catch (err) { console.error(`socket '${event}' failed:`, err && err.message); }
  });

  // A user opens a topic.
  on('topic:join', async ({ topicId, name }) => {
    if (!topicId || !name) return;
    if (!rateLimit(socket, 'join', 40, 10000)) return;

    // Leave a previously-open topic, if any.
    if (socket.data.topicId && socket.data.topicId !== topicId) {
      const prev = roomName(socket.data.topicId);
      socket.leave(prev);
      await broadcastUsers(prev);
    }

    socket.data.name = String(name).slice(0, 60);
    socket.data.topicId = topicId;

    const room = roomName(topicId);
    socket.join(room);
    socket.to(room).emit('user:join', { name: socket.data.name });
    await broadcastUsers(room);
  });

  // Anyone can create a topic; broadcast to every connected client.
  on('topic:create', ({ title }) => {
    const clean = String(title || '').trim();
    if (!clean) return;
    if (!rateLimit(socket, 'topicCreate', 8, 60000)) return;
    if (q.countTopics.get().n >= LIMITS.maxTopics) return; // cap reached
    const info = q.insertTopic.run(clean.slice(0, LIMITS.maxTitle), new Date().toISOString());
    const topic = q.topicById.get(info.lastInsertRowid);
    io.emit('topic:created', topic);
  });

  // EDITING a block (anyone may edit any block). Persist the in-progress content
  // for durability but DON'T relay it — peers only learn who's modifying it, and
  // can't grab a block someone else is actively editing.
  on('block:update', ({ topicId, id, ownerId, author, content, position }) => {
    const editorId = String(ownerId || '').trim(); // who is editing (stable id)
    const editor = String(author || '').trim();     // editor's display name
    const blockId = String(id || '').trim();
    if (!topicId || !editor || !blockId) return;
    if (!rateLimit(socket, 'blockUpdate', 30, 1000)) return;
    const body = String(content == null ? '' : content).slice(0, LIMITS.maxContent);

    const row = saveBlock({ id: blockId, topicId: Number(topicId), ownerId: editorId, editor, content: body, position, state: 'editing' });
    if (!row) return;
    (socket.data.editing || (socket.data.editing = new Map())).set(blockId, Number(topicId));
    socket.to(roomName(topicId)).emit('block:update', {
      topicId: Number(topicId),
      id: row.id,
      editor_id: editorId,
      last_modified_by: row.last_modified_by,
      position: row.position,
      updated_at: row.updated_at,
      state: 'editing', // peers show "<editor> is modifying…" — content withheld
    });
  });

  // PUBLISH: the editor finished (Shift+Enter / moved off). Relay the content.
  on('block:publish', ({ topicId, id, ownerId, author, content, position }) => {
    const editorId = String(ownerId || '').trim();
    const editor = String(author || '').trim();
    const blockId = String(id || '').trim();
    if (!topicId || !editor || !blockId) return;
    if (!rateLimit(socket, 'blockUpdate', 30, 1000)) return;
    const body = String(content == null ? '' : content).slice(0, LIMITS.maxContent);

    const row = saveBlock({ id: blockId, topicId: Number(topicId), ownerId: editorId, editor, content: body, position, state: 'published' });
    if (!row) return;
    if (socket.data.editing) socket.data.editing.delete(blockId);
    socket.to(roomName(topicId)).emit('block:publish', publishPayload(topicId, row, editorId));
  });

  // Delete a block — anyone may.
  on('block:delete', ({ topicId, id }) => {
    const blockId = String(id || '').trim();
    if (!topicId || !blockId) return;
    if (!rateLimit(socket, 'blockDelete', 30, 5000)) return;
    if (removeBlock(blockId)) {
      if (socket.data.editing) socket.data.editing.delete(blockId);
      socket.to(roomName(topicId)).emit('block:delete', { topicId: Number(topicId), id: blockId });
    }
  });

  on('disconnect', async () => {
    // Publish anything this socket left mid-edit so peers stop seeing the overlay.
    if (socket.data.editing) {
      for (const [blockId, topicId] of socket.data.editing) {
        const existing = q.blockById.get(blockId);
        if (existing && existing.state === 'editing') {
          const row = saveBlock({ id: blockId, topicId, ownerId: existing.owner_id, editor: existing.last_modified_by, content: existing.content, position: existing.position, state: 'published' });
          if (row) io.to(roomName(topicId)).emit('block:publish', publishPayload(topicId, row, ''));
        }
      }
    }
    if (!socket.data.topicId) return;
    await broadcastUsers(roomName(socket.data.topicId));
  });
});

function publishPayload(topicId, row, editorId) {
  return {
    topicId: Number(topicId),
    id: row.id,
    editor_id: editorId || '',
    last_modified_by: row.last_modified_by,
    content: row.content,
    position: row.position,
    updated_at: row.updated_at,
    state: 'published',
  };
}

// ---------------------------------------------------------------------------
// Config: read --host / --port from CLI args (and HOST / PORT env vars).
// Supports both `--host=0.0.0.0` and `--host 0.0.0.0` forms.
const PORT = cliArg('port') || process.env.PORT || 3000;
// Default to localhost-only. Pass --host=0.0.0.0 to listen on all interfaces
// (useful behind a tunnel like ngrok/cloudflared, or on a LAN).
const HOST = cliArg('host') || process.env.HOST || '127.0.0.1';

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n✗ Port ${PORT} is already in use by another program.`);
    console.error(`  Pick a different port:   node server.js --port=3000`);
    console.error(`  Or find what's using it: sudo lsof -nP -iTCP:${PORT} -sTCP:LISTEN\n`);
    process.exit(1);
  }
  if (err.code === 'EACCES') {
    console.error(`\n✗ No permission to bind port ${PORT} (ports below 1024 need elevated privileges). Try a higher port.\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log(`Chorus running on http://${shown}:${PORT}  (bound to ${HOST}:${PORT})`);
  console.log(`Data: ${DB_PATH}`);
  if (AUTH_REQUIRED) {
    console.log('────────────────────────────────────────');
    console.log('🔒 Login required — sign in with:');
    console.log(`     Username:  ${AUTH_USER}`);
    console.log(`     Password:  ${AUTH_PASSWORD}`);
    if (AUTH_PW_GENERATED) console.log('   (auto-generated — set CHORUS_USER / CHORUS_PASSWORD to choose your own, or --no-auth to disable login)');
    console.log('────────────────────────────────────────');
  } else {
    console.log('🔓 No login (--no-auth) — anyone who can reach this URL can read & write.');
  }
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.log('Listening on all interfaces — reachable over your LAN / tunnel.');
  }
});

// Graceful shutdown: stop accepting connections, close the sockets, fold the WAL
// into the main DB file, then exit. A timeout guarantees we never hang on exit.
let closing = false;
function shutdown(code) {
  if (closing) return;
  closing = true;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch (_) { /* ignore */ }
    process.exit(code || 0);
  };
  try { io.close(finish); } catch (_) { finish(); }   // closes sockets + the HTTP server
  setTimeout(finish, 3000).unref();                    // don't wait forever for a stuck connection
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Don't die silently. Log, checkpoint the DB, and let the process manager restart us.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err && err.stack ? err.stack : err);
  shutdown(1);
});

// Keep the main chorus.db current instead of letting all data pile up in the
// write-ahead log: fold the WAL back into the .db file on a timer. PASSIVE never
// blocks live writers, so this is cheap. The payoff: even a hard `kill -9` (no
// clean shutdown) or a plain `cp chorus.db` backup is at most a few seconds
// behind — your data never lives *only* in the .wal file for long.
const checkpointTimer = setInterval(() => {
  if (closing) return;
  try { db.pragma('wal_checkpoint(PASSIVE)'); } catch (_) { /* ignore */ }
}, 15000);
checkpointTimer.unref(); // never keep the process alive just to checkpoint
