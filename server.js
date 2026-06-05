'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');

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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  // The whole app (HTML + inline JS/CSS) is one file, so force the browser to
  // revalidate it on every load — a reload can never serve a stale build.
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// REST API — used to restore state on page load
app.get('/api/topics', (req, res) => {
  res.json(q.allTopics.all());
});

// The topic's shared playground — every block, in reading order.
app.get('/api/topics/:id/blocks', (req, res) => {
  const topic = q.topicById.get(req.params.id);
  if (!topic) return res.status(404).json({ error: 'Topic not found' });
  res.json(q.blocksByTopic.all(req.params.id));
});

// The whole document, canonical shape: topic metadata + ordered owned blocks +
// the assembled Markdown (blocks joined in reading order).
app.get('/api/topics/:id/document', (req, res) => {
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

// ---------------------------------------------------------------------------
// Socket.io real-time layer
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 256 * 1024 }); // bound inbound payloads

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

  // A user opens a topic.
  socket.on('topic:join', async ({ topicId, name }) => {
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
  socket.on('topic:create', ({ title }) => {
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
  socket.on('block:update', ({ topicId, id, ownerId, author, content, position }) => {
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
  socket.on('block:publish', ({ topicId, id, ownerId, author, content, position }) => {
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
  socket.on('block:delete', ({ topicId, id }) => {
    const blockId = String(id || '').trim();
    if (!topicId || !blockId) return;
    if (!rateLimit(socket, 'blockDelete', 30, 5000)) return;
    if (removeBlock(blockId)) {
      if (socket.data.editing) socket.data.editing.delete(blockId);
      socket.to(roomName(topicId)).emit('block:delete', { topicId: Number(topicId), id: blockId });
    }
  });

  socket.on('disconnect', async () => {
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
function cliArg(name) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
  }
  return null;
}

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
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.log('Listening on all interfaces — reachable over your LAN / tunnel.');
  }
});

// Flush the WAL into the main DB file and close cleanly on exit.
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch (_) { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

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
