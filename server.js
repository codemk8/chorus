'use strict';

const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');
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
// Successful logins clear their bucket (an office NAT must not lock itself
// out), and stale buckets are pruned so the map can't grow without bound.
const loginHits = new Map();
function loginThrottle(ip) {
  const now = Date.now();
  if (loginHits.size > 5000) {
    for (const [k, v] of loginHits) { if (now - v.start >= 5 * 60 * 1000) loginHits.delete(k); }
  }
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
function openDatabase(p) {
  try { return new Database(p); } catch (err) {
    console.error(`\n✗ Cannot open the database at ${p}`);
    console.error('  Check that the directory exists and is writable by this user.');
    console.error(`  (${err.message})\n`);
    process.exit(1);
  }
}
const db = openDatabase(DB_PATH);
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

  -- Every published version of a block (newest last). Capped per block, so a
  -- busy block keeps its recent history without unbounded growth.
  CREATE TABLE IF NOT EXISTS revisions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    block_id   TEXT NOT NULL,
    content    TEXT NOT NULL,
    author     TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_revisions_block ON revisions (block_id, id);
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
  // A block mid-edit has its content WITHHELD here too — "composing…" content
  // must never be readable via REST or the export while it's unpublished.
  blocksByTopic: db.prepare(
    "SELECT id, topic_id, owner_id, author, " +
    "CASE WHEN state = 'editing' THEN '' ELSE content END AS content, " +
    "position, state, last_modified_by, created_at, updated_at " +
    "FROM blocks WHERE topic_id = ? AND content <> '' ORDER BY position ASC, created_at ASC, id ASC"
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
  renameTopic: db.prepare('UPDATE topics SET title = ? WHERE id = ?'),
  deleteTopic: db.prepare('DELETE FROM topics WHERE id = ?'),
  blockIdsByTopic: db.prepare('SELECT id FROM blocks WHERE topic_id = ?'),
  deleteBlocksByTopic: db.prepare('DELETE FROM blocks WHERE topic_id = ?'),
  insertRevision: db.prepare('INSERT INTO revisions (block_id, content, author, created_at) VALUES (?, ?, ?, ?)'),
  lastRevision: db.prepare('SELECT content FROM revisions WHERE block_id = ? ORDER BY id DESC LIMIT 1'),
  revisionsByBlock: db.prepare('SELECT id, content, author, created_at FROM revisions WHERE block_id = ? ORDER BY id DESC LIMIT 50'),
  pruneRevisions: db.prepare('DELETE FROM revisions WHERE block_id = ? AND id NOT IN (SELECT id FROM revisions WHERE block_id = ? ORDER BY id DESC LIMIT 30)'),
  deleteRevisionsForBlock: db.prepare('DELETE FROM revisions WHERE block_id = ?'),
  deleteRevisionsForTopic: db.prepare('DELETE FROM revisions WHERE block_id IN (SELECT id FROM blocks WHERE topic_id = ?)'),
};

// Record a block's published state as a revision (skipping no-op republishes),
// keeping at most the 30 most recent versions per block.
function recordRevision(row) {
  const last = q.lastRevision.get(row.id);
  if (last && last.content === row.content) return;
  q.insertRevision.run(row.id, row.content, row.last_modified_by || row.author || '', row.updated_at);
  q.pruneRevisions.run(row.id, row.id);
}

// Delete a whole topic: its blocks' history, its blocks, then the topic row —
// atomically, so a crash can't leave orphans.
const deleteTopicCascade = db.transaction((topicId) => {
  q.deleteRevisionsForTopic.run(topicId);
  q.deleteBlocksByTopic.run(topicId);
  q.deleteTopic.run(topicId);
});

// Public-demo guardrails — bound storage so a single server can't be flooded.
const LIMITS = {
  maxTopics: Number(process.env.MAX_TOPICS) || 300,
  maxBlocksPerTopic: Number(process.env.MAX_BLOCKS_PER_TOPIC) || 1000,
  maxContent: 100000,
  maxTitle: 120,
};

// Insert-or-update a block. Anyone may edit any block UNLESS another identity
// holds its editing lock (checked by the socket handlers); `editor` is the
// display name of whoever is making this change (recorded as last_modified_by).
// Returns { row, error } — error is a machine-readable reason for the ack:
// 'no-topic' | 'empty' | 'cap'. Updates keep the row's real topic; a forged
// topicId can't move a block or desync the room broadcast.
function saveBlock({ id, topicId, ownerId, editor, content, position, state }) {
  const now = new Date().toISOString();
  const st = state === 'editing' ? 'editing' : 'published';
  if (!String(content).trim()) return { row: null, error: 'empty' }; // never store invisible blocks
  const existing = q.blockById.get(id);
  if (existing) {
    q.updateBlock.run(content, st, editor, now, id);
  } else {
    if (!q.topicById.get(topicId)) return { row: null, error: 'no-topic' }; // don't create orphan blocks
    if (q.countBlocksInTopic.get(topicId).n >= LIMITS.maxBlocksPerTopic) return { row: null, error: 'cap' };
    const pos = Number(position);
    q.insertBlock.run(id, topicId, ownerId, editor, content, Number.isFinite(pos) ? pos : 0, st, editor, now, now);
  }
  return { row: q.blockById.get(id), error: null };
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

// Security headers. The client is one inline HTML/CSS/JS file and its libraries are
// vendored under /public/vendor, so everything is same-origin — the CSP only needs
// 'unsafe-inline' for the inline app script/styles; no external origins are allowed.
// connect-src is pinned to this request's own host (not a blanket ws:/wss:), so a
// compromised script still can't open a websocket to an attacker's origin.
const HOST_RE = /^[A-Za-z0-9.\-:[\]]+$/; // hostname[:port], incl. IPv6 brackets
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const host = String(req.headers.host || '');
  const connect = HOST_RE.test(host) ? `'self' ws://${host} wss://${host}` : "'self' ws: wss:";
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; font-src 'self' data:; " +
    `connect-src ${connect}; ` +
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

// Light per-IP rate limit on the whole /api surface: /document can legitimately
// be large, so a flood of reads is the cheapest way to hurt a small instance.
// 120 requests / 10s per IP is far beyond anything the stock client does.
const apiHits = new Map();
app.use('/api', (req, res, next) => {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  let b = apiHits.get(ip);
  if (!b || now - b.start >= 10000) {
    if (apiHits.size > 10000) apiHits.clear(); // bound the map under address spoofing
    b = { start: now, count: 0 }; apiHits.set(ip, b);
  }
  b.count += 1;
  if (b.count > 120) return res.status(429).json({ error: 'Too many requests' });
  next();
});

// Auth: tell the client whether a login is needed, and trade the password for a token.
app.get('/api/auth', (req, res) => res.json({ required: AUTH_REQUIRED }));
app.post('/api/login', (req, res) => {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (!loginThrottle(ip)) return res.status(429).json({ error: 'Too many attempts — wait a few minutes.' });
  if (!AUTH_REQUIRED) return res.json({ token: '' });
  const u = (req.body && req.body.username) || '';
  const p = (req.body && req.body.password) || '';
  if (safeEqual(u, AUTH_USER) && safeEqual(p, AUTH_PASSWORD)) {
    loginHits.delete(ip); // a successful login must not count toward the lockout
    return res.json({ token: AUTH_TOKEN });
  }
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
    // Mid-edit blocks are masked to '' by the query — drop them from the export.
    markdown: blocks.map((b) => b.content).filter(Boolean).join('\n\n'),
  });
});

// A block's published history, newest first (drafts are never recorded).
app.get('/api/blocks/:id/revisions', requireAuth, (req, res) => {
  if (!q.blockById.get(req.params.id)) return res.status(404).json({ error: 'Block not found' });
  res.json(q.revisionsByBlock.all(req.params.id));
});

// Consistent point-in-time backup of the whole database, safe against live
// writers (SQLite's VACUUM INTO — unlike `cp`, it can never capture a torn
// page). Download it from the Export menu or:
//   curl -H "Authorization: Bearer <token>" -o backup.db http://…/api/backup
app.get('/api/backup', requireAuth, (req, res) => {
  const tmp = path.join(os.tmpdir(), `chorus-backup-${process.pid}-${Date.now()}.db`);
  try {
    db.prepare('VACUUM INTO ?').run(tmp);
    res.download(tmp, 'chorus-backup.db', () => fs.unlink(tmp, () => {}));
  } catch (err) {
    fs.unlink(tmp, () => {});
    console.error('backup failed:', err && err.message);
    res.status(500).json({ error: 'Backup failed' });
  }
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
  if (res.headersSent) return next(err); // mid-stream failure → let express close the socket
  res.status(500).json({ error: 'Server error' });
});

// ---------------------------------------------------------------------------
// Socket.io real-time layer
// ---------------------------------------------------------------------------
const server = http.createServer(app);
// Bound inbound payloads. Must comfortably exceed maxContent in BYTES: 100k
// characters can be ~400KB as UTF-8, and engine.io kills the connection (it
// doesn't just drop the packet) when a frame exceeds this.
const io = new Server(server, { maxHttpBufferSize: 1024 * 1024 });

// Realtime auth + identity: when a password is set, every socket must present
// the token. The client's stable identity (ownerId) and display name are bound
// to the socket ONCE at the handshake — block handlers use these, never the
// per-event payload, so one client can't impersonate another or release
// someone else's editing lock by forging event fields.
// Cap concurrent sockets per IP: the per-socket rate limits would otherwise
// multiply away with N connections (each socket gets its own write budget).
const MAX_SOCKETS_PER_IP = Number(process.env.MAX_SOCKETS_PER_IP) || 20;
const ipSockets = new Map();
io.use((socket, next) => {
  const ip = socket.handshake.address || 'unknown';
  const n = ipSockets.get(ip) || 0;
  if (n >= MAX_SOCKETS_PER_IP) return next(new Error('too many connections'));
  ipSockets.set(ip, n + 1);
  socket.once('disconnect', () => {
    const c = (ipSockets.get(ip) || 1) - 1;
    if (c <= 0) ipSockets.delete(ip); else ipSockets.set(ip, c);
  });
  next();
});

io.use((socket, next) => {
  const a = socket.handshake.auth || {};
  socket.data.ownerId = String(a.ownerId || '').slice(0, 64);
  socket.data.name = String(a.name || '').slice(0, 60);
  if (!AUTH_REQUIRED) return next();
  if (safeEqual(a.token || '', AUTH_TOKEN)) return next();
  next(new Error('unauthorized'));
});

const roomName = (topicId) => `topic:${topicId}`;

// ---------------------------------------------------------------------------
// Server-enforced editing locks. A block being edited is locked to ONE identity
// (ownerId): update/publish/delete from anyone else is rejected with an ack, so
// "two people never touch the same text" holds even against racing or crafted
// clients — the client-side isLocked check is now just UX, not the enforcement.
//
// Lifecycle: claimed/refreshed on block:update, released on publish/delete.
// On disconnect the holder gets a grace window (EDIT_GRACE_MS) to reconnect and
// re-claim before the draft is force-published — a network blip no longer leaks
// the withheld draft to the room. If another live socket shares the identity
// (same user, another tab), the lock is handed over instead of published.
// ---------------------------------------------------------------------------
const EDIT_GRACE_MS = Number(process.env.EDIT_GRACE_MS) || 8000;
const editLocks = new Map(); // blockId -> { ownerId, name, socketId, at, grace }

function ownerSocket(ownerId, exceptId) {
  for (const s of io.of('/').sockets.values()) {
    if (s.id !== exceptId && s.data.ownerId && s.data.ownerId === ownerId) return s;
  }
  return null;
}

// Release a lock and publish whatever draft content the row holds (the editor
// is gone for good — peers must stop seeing the "modifying…" overlay).
function releaseAndPublish(blockId) {
  const lock = editLocks.get(blockId);
  if (!lock) return;
  if (lock.grace) clearTimeout(lock.grace);
  editLocks.delete(blockId);
  const existing = q.blockById.get(blockId);
  if (existing && existing.state === 'editing') {
    const { row } = saveBlock({
      id: blockId, topicId: existing.topic_id, ownerId: existing.owner_id,
      editor: existing.last_modified_by, content: existing.content,
      position: existing.position, state: 'published',
    });
    if (row) {
      recordRevision(row);
      io.to(roomName(existing.topic_id)).emit('block:publish', publishPayload(existing.topic_id, row, lock.ownerId));
    }
  }
}

// Safety net: reap locks whose holder has no live connection at all (missed
// disconnect events, crashed processes). Locks held by CONNECTED owners are
// left alone — a blurred draft may legitimately sit unpublished for hours.
const lockSweeper = setInterval(() => {
  for (const [blockId, lock] of editLocks) {
    if (lock.grace) continue; // departure already being handled by its grace timer
    if (!ownerSocket(lock.ownerId)) releaseAndPublish(blockId);
  }
}, 60000);
lockSweeper.unref();

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
  socket.data.topicId = null;

  // Wrap every handler: a malformed event or a transient DB error logs and drops,
  // it never takes down the process. Every write handler takes an optional ack
  // callback as its last argument and ALWAYS answers it — the client must never
  // be left believing a rejected write was saved.
  const on = (event, fn) => socket.on(event, async (...args) => {
    try { await fn(...args); } catch (err) { console.error(`socket '${event}' failed:`, err && err.message); }
  });
  const reply = (ack, payload) => { if (typeof ack === 'function') ack(payload); };

  // A user opens a topic.
  on('topic:join', async (payload) => {
    const { topicId, name, ownerId } = payload || {};
    if (!topicId || !name) return;
    if (!rateLimit(socket, 'join', 40, 10000)) return;

    // Leave a previously-open topic, if any.
    if (socket.data.topicId && socket.data.topicId !== topicId) {
      const prev = roomName(socket.data.topicId);
      socket.leave(prev);
      await broadcastUsers(prev);
    }

    socket.data.name = String(name).slice(0, 60);
    // Identity normally arrives in the handshake; accept it here only if the
    // handshake didn't carry one (it never changes for the life of the socket).
    if (!socket.data.ownerId && ownerId) socket.data.ownerId = String(ownerId).slice(0, 64);
    socket.data.topicId = topicId;

    const room = roomName(topicId);
    socket.join(room);
    socket.to(room).emit('user:join', { name: socket.data.name });
    await broadcastUsers(room);
  });

  // Anyone can create a topic; broadcast to every connected client.
  on('topic:create', (payload, ack) => {
    const clean = String((payload && payload.title) || '').trim();
    if (!clean) return reply(ack, { ok: false, error: 'invalid' });
    if (!rateLimit(socket, 'topicCreate', 8, 60000)) return reply(ack, { ok: false, error: 'rate' });
    if (q.countTopics.get().n >= LIMITS.maxTopics) return reply(ack, { ok: false, error: 'cap' });
    const info = q.insertTopic.run(clean.slice(0, LIMITS.maxTitle), new Date().toISOString());
    const topic = q.topicById.get(info.lastInsertRowid);
    io.emit('topic:created', topic);
    reply(ack, { ok: true, topic });
  });

  // Rename a topic — broadcast so every sidebar updates.
  on('topic:rename', (payload, ack) => {
    const { topicId } = payload || {};
    const clean = String((payload && payload.title) || '').trim();
    if (!topicId || !clean) return reply(ack, { ok: false, error: 'invalid' });
    if (!rateLimit(socket, 'topicMod', 10, 60000)) return reply(ack, { ok: false, error: 'rate' });
    const topic = q.topicById.get(Number(topicId));
    if (!topic) return reply(ack, { ok: false, error: 'no-topic' });
    q.renameTopic.run(clean.slice(0, LIMITS.maxTitle), topic.id);
    io.emit('topic:renamed', { id: topic.id, title: clean.slice(0, LIMITS.maxTitle) });
    reply(ack, { ok: true });
  });

  // Delete a topic and everything in it. Refused while someone ELSE is mid-edit
  // inside it — never yank a document out from under an active editor.
  on('topic:delete', (payload, ack) => {
    const { topicId } = payload || {};
    if (!topicId) return reply(ack, { ok: false, error: 'invalid' });
    if (!rateLimit(socket, 'topicMod', 10, 60000)) return reply(ack, { ok: false, error: 'rate' });
    const topic = q.topicById.get(Number(topicId));
    if (!topic) return reply(ack, { ok: false, error: 'no-topic' });
    const blockIds = q.blockIdsByTopic.all(topic.id).map((r) => r.id);
    for (const id of blockIds) {
      const lock = editLocks.get(id);
      if (lock && lock.ownerId !== socket.data.ownerId) return reply(ack, { ok: false, error: 'locked', by: lock.name });
    }
    deleteTopicCascade(topic.id);
    for (const id of blockIds) {
      const lock = editLocks.get(id);
      if (lock) { if (lock.grace) clearTimeout(lock.grace); editLocks.delete(id); }
    }
    io.emit('topic:deleted', { id: topic.id });
    reply(ack, { ok: true });
  });

  // EDITING a block. Persist the in-progress content for durability but DON'T
  // relay it — peers only learn who's modifying it. The block's lock is claimed
  // here; updates from anyone else are rejected until the holder lets go.
  on('block:update', (payload, ack) => {
    const { topicId, id, content, position } = payload || {};
    const editorId = socket.data.ownerId;
    const editor = socket.data.name || '';
    const blockId = String(id || '').trim();
    if (!topicId || !editorId || !editor || !blockId) return reply(ack, { ok: false, error: 'invalid' });
    if (!rateLimit(socket, 'blockUpdate', 30, 1000)) return reply(ack, { ok: false, error: 'rate' });
    const raw = String(content == null ? '' : content);
    const body = raw.slice(0, LIMITS.maxContent);

    const lock = editLocks.get(blockId);
    if (lock && lock.ownerId !== editorId) return reply(ack, { ok: false, error: 'locked', by: lock.name });

    const { row, error } = saveBlock({ id: blockId, topicId: Number(topicId), ownerId: editorId, editor, content: body, position, state: 'editing' });
    if (!row) return reply(ack, { ok: false, error });
    // Claim or refresh the lock (a reconnected session re-claims here, which
    // cancels any pending disconnect grace timer from its dead predecessor).
    if (lock) {
      if (lock.grace) { clearTimeout(lock.grace); lock.grace = null; }
      lock.socketId = socket.id; lock.at = Date.now(); lock.name = editor;
    } else {
      editLocks.set(blockId, { ownerId: editorId, name: editor, socketId: socket.id, at: Date.now(), grace: null });
    }
    (socket.data.editing || (socket.data.editing = new Set())).add(blockId);
    socket.to(roomName(row.topic_id)).emit('block:update', {
      topicId: row.topic_id,
      id: row.id,
      editor_id: editorId,
      last_modified_by: row.last_modified_by,
      position: row.position,
      updated_at: row.updated_at,
      state: 'editing', // peers show "<editor> is modifying…" — content withheld
    });
    reply(ack, { ok: true, updated_at: row.updated_at, truncated: raw.length > body.length });
  });

  // PUBLISH: the editor finished (Shift+Enter / moved off). Relay the content
  // and release the lock.
  on('block:publish', (payload, ack) => {
    const { topicId, id, content, position } = payload || {};
    const editorId = socket.data.ownerId;
    const editor = socket.data.name || '';
    const blockId = String(id || '').trim();
    if (!topicId || !editorId || !editor || !blockId) return reply(ack, { ok: false, error: 'invalid' });
    if (!rateLimit(socket, 'blockUpdate', 30, 1000)) return reply(ack, { ok: false, error: 'rate' });
    const raw = String(content == null ? '' : content);
    const body = raw.slice(0, LIMITS.maxContent);

    const lock = editLocks.get(blockId);
    if (lock && lock.ownerId !== editorId) return reply(ack, { ok: false, error: 'locked', by: lock.name });

    const { row, error } = saveBlock({ id: blockId, topicId: Number(topicId), ownerId: editorId, editor, content: body, position, state: 'published' });
    if (!row) return reply(ack, { ok: false, error });
    recordRevision(row);
    if (lock) { if (lock.grace) clearTimeout(lock.grace); editLocks.delete(blockId); }
    if (socket.data.editing) socket.data.editing.delete(blockId);
    socket.to(roomName(row.topic_id)).emit('block:publish', publishPayload(row.topic_id, row, editorId));
    reply(ack, { ok: true, updated_at: row.updated_at, truncated: raw.length > body.length });
  });

  // Delete a block — anyone may, unless someone else is mid-edit in it.
  on('block:delete', (payload, ack) => {
    const { id } = payload || {};
    const blockId = String(id || '').trim();
    if (!blockId) return reply(ack, { ok: false, error: 'invalid' });
    if (!rateLimit(socket, 'blockDelete', 30, 5000)) return reply(ack, { ok: false, error: 'rate' });
    const lock = editLocks.get(blockId);
    if (lock && lock.ownerId !== socket.data.ownerId) return reply(ack, { ok: false, error: 'locked', by: lock.name });
    const existing = q.blockById.get(blockId);
    if (!existing) return reply(ack, { ok: true, missing: true });
    q.deleteBlock.run(blockId);
    q.deleteRevisionsForBlock.run(blockId);
    if (lock) { if (lock.grace) clearTimeout(lock.grace); editLocks.delete(blockId); }
    if (socket.data.editing) socket.data.editing.delete(blockId);
    // Broadcast to the block's REAL topic room (never the payload's claim).
    socket.to(roomName(existing.topic_id)).emit('block:delete', { topicId: existing.topic_id, id: blockId });
    reply(ack, { ok: true });
  });

  on('disconnect', async () => {
    // Blocks this socket left mid-edit: give the same identity a grace window
    // to reconnect (or hand the lock to their other open tab) before the draft
    // is force-published. A wifi blip must not broadcast withheld content.
    if (socket.data.editing) {
      for (const blockId of socket.data.editing) {
        const lock = editLocks.get(blockId);
        if (!lock || lock.socketId !== socket.id) continue; // a newer session already took over
        if (lock.grace) clearTimeout(lock.grace);
        lock.grace = setTimeout(() => {
          const cur = editLocks.get(blockId);
          if (!cur || cur.socketId !== socket.id) return;   // re-claimed meanwhile
          const heir = ownerSocket(cur.ownerId, socket.id);
          if (heir) {                                        // same person, another tab/session
            cur.socketId = heir.id; cur.grace = null; cur.at = Date.now();
            (heir.data.editing || (heir.data.editing = new Set())).add(blockId);
            return;
          }
          releaseAndPublish(blockId);                        // truly gone → publish the draft
        }, EDIT_GRACE_MS);
        if (lock.grace.unref) lock.grace.unref();
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
// First signal: graceful shutdown. Second signal: the operator means NOW.
const onSignal = (code) => () => {
  if (closing) { console.error('Second signal — exiting immediately.'); process.exit(code); }
  shutdown(0);
};
process.on('SIGINT', onSignal(130));
process.on('SIGTERM', onSignal(143));

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
// blocks live writers, so this is cheap. Durability notes: writes are synchronous,
// so even a hard `kill -9` loses nothing (the WAL replays on next open); the only
// loss window is power loss / OS crash under `synchronous = NORMAL` (~the last
// few transactions). For backups use GET /api/backup (VACUUM INTO — always a
// consistent snapshot); do NOT `cp` the live .db, which can race a checkpoint
// and capture a torn copy.
const checkpointTimer = setInterval(() => {
  if (closing) return;
  try { db.pragma('wal_checkpoint(PASSIVE)'); } catch (_) { /* ignore */ }
}, 15000);
checkpointTimer.unref(); // never keep the process alive just to checkpoint
