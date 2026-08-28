'use strict';

// End-to-end tests: spawn the real server with a throwaway DB and a known
// password, then exercise the HTTP API, auth gating, and the realtime layer —
// including the server-enforced invariants: editing locks, draft withholding,
// and acknowledged (never silently dropped) writes.
// Run with: npm test   (node --test)

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { io } = require('socket.io-client');

const PASSWORD = 'test-pass-123';
const USER = 'admin';
const SERVER = path.join(__dirname, '..', 'server.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

function reqTo(baseUrl, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = http.request(baseUrl + p, { method, headers }, (res) => {
      let buf = ''; res.on('data', (d) => (buf += d));
      res.on('end', () => { let j; try { j = JSON.parse(buf); } catch (_) { j = buf; } resolve({ status: res.statusCode, body: j, headers: res.headers }); });
    });
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}

// Spawn a chorus server on a free port with a throwaway DB. Returns helpers
// bound to that instance; always srv.stop() in a finally / after().
async function spawnServer(extraEnv) {
  const port = await freePort();
  const db = path.join(os.tmpdir(), `chorus-test-${process.pid}-${port}.db`);
  let stderr = '';
  const proc = spawn(process.execPath, [SERVER, `--port=${port}`], {
    env: { ...process.env, CHORUS_DB: db, CHORUS_USER: USER, CHORUS_PASSWORD: PASSWORD, ...(extraEnv || {}) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr.on('data', (d) => (stderr += d));
  const baseUrl = `http://127.0.0.1:${port}`;
  const start = Date.now();
  for (;;) {
    try { const r = await reqTo(baseUrl, 'GET', '/healthz'); if (r.status === 200) break; } catch (_) { /* not up yet */ }
    if (Date.now() - start > 15000) throw new Error('server did not become ready. stderr:\n' + stderr);
    await sleep(120);
  }
  return {
    base: baseUrl,
    req: (method, p, body, token) => reqTo(baseUrl, method, p, body, token),
    async login() {
      const r = await reqTo(baseUrl, 'POST', '/api/login', { username: USER, password: PASSWORD });
      assert.equal(r.status, 200, 'login should succeed');
      return r.body.token;
    },
    connect(token, ident) {
      return new Promise((resolve) => {
        const s = io(baseUrl, { transports: ['websocket'], auth: Object.assign({}, token ? { token } : {}, ident || {}), reconnection: false });
        const fail = (msg) => { try { s.close(); } catch (_) {} resolve({ ok: false, error: msg }); };
        s.once('connect', () => resolve({ ok: true, socket: s }));
        s.once('connect_error', (e) => fail(e.message));
        setTimeout(() => fail('timeout'), 4000);
      });
    },
    stop() {
      proc.kill('SIGTERM');
      for (const f of [db, db + '-wal', db + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
    },
  };
}

// Promise wrappers around the socket protocol.
const emitAck = (s, ev, payload) => new Promise((resolve) => s.emit(ev, payload, resolve));
const once = (socket, ev, timeoutMs = 5000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timed out waiting for '${ev}'`)), timeoutMs);
  socket.once(ev, (msg) => { clearTimeout(t); resolve(msg); });
});
// Resolves true if the event arrives within windowMs, false otherwise (for
// asserting an event does NOT fire — bounded, never hangs).
const arrives = (socket, ev, windowMs) => new Promise((resolve) => {
  const t = setTimeout(() => { socket.off(ev, h); resolve(false); }, windowMs);
  const h = () => { clearTimeout(t); resolve(true); };
  socket.once(ev, h);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Create a topic and join n identified sockets to it. Identities are oa/ob/oc…
async function topicWith(srv, token, n) {
  const idents = [{ ownerId: 'oa', name: 'alice' }, { ownerId: 'ob', name: 'bob' }, { ownerId: 'oc', name: 'cara' }].slice(0, n);
  const sockets = [];
  for (const ident of idents) {
    const c = await srv.connect(token, ident);
    assert.ok(c.ok, `socket for ${ident.name} should connect`);
    sockets.push(c.socket);
  }
  const topic = await new Promise((resolve) => { sockets[0].once('topic:created', resolve); sockets[0].emit('topic:create', { title: 'T-' + Math.random().toString(36).slice(2) }); });
  assert.ok(topic && topic.id, 'topic should be created');
  for (let i = 0; i < sockets.length; i++) {
    sockets[i].emit('topic:join', { topicId: topic.id, name: idents[i].name, ownerId: idents[i].ownerId });
  }
  // join is fire-and-forget; the users:update broadcast confirms room membership
  await once(sockets[n - 1], 'users:update');
  return { topic, sockets };
}

// ---------------------------------------------------------------------------
// Main shared server (default limits)
// ---------------------------------------------------------------------------
let srv, TOKEN;
before(async () => { srv = await spawnServer(); });
after(() => srv && srv.stop());

test('health check responds', async () => {
  const r = await srv.req('GET', '/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('sends security headers and hides x-powered-by', async () => {
  const r = await srv.req('GET', '/healthz');
  assert.match(r.headers['content-security-policy'] || '', /default-src 'self'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-powered-by'], undefined);
});

test('topic deep link /t/<id> serves the app shell', async () => {
  const r = await srv.req('GET', '/t/123');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'] || '', /text\/html/);
  assert.match(String(r.body), /Chorus/);
  // Non-numeric ids fall through to the normal 404, not the shell.
  assert.equal((await srv.req('GET', '/t/evil')).status, 404);
});

test('reports that auth is required', async () => {
  assert.equal((await srv.req('GET', '/api/auth')).body.required, true);
});

test('REST data endpoints are gated without a token', async () => {
  assert.equal((await srv.req('GET', '/api/topics')).status, 401);
});

test('login rejects wrong username or password', async () => {
  assert.equal((await srv.req('POST', '/api/login', { username: USER, password: 'wrong' })).status, 401);
  assert.equal((await srv.req('POST', '/api/login', { username: 'nobody', password: PASSWORD })).status, 401);
});

test('unknown /api route returns JSON 404', async () => {
  const r = await srv.req('GET', '/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'Not found');
});

test('malformed JSON returns 400', async () => {
  const r = await srv.req('POST', '/api/login', '{bad json');
  assert.equal(r.status, 400);
});

test('valid login issues a token that unlocks the REST API', async () => {
  TOKEN = await srv.login();
  assert.ok(TOKEN && TOKEN.length >= 32);
  const t = await srv.req('GET', '/api/topics', null, TOKEN);
  assert.equal(t.status, 200);
  assert.ok(Array.isArray(t.body));
});

test('socket handshake requires a valid token', async () => {
  assert.equal((await srv.connect(null)).ok, false);
  assert.equal((await srv.connect('garbage')).ok, false);
  const c = await srv.connect(TOKEN);
  assert.equal(c.ok, true);
  c.socket.close();
});

test('realtime: drafts are withheld, publishes are relayed and persisted', async () => {
  const { topic, sockets: [sa, sb] } = await topicWith(srv, TOKEN, 2);
  const blockId = 'blk-rt-' + topic.id;

  const editEvt = once(sb, 'block:update');
  const upAck = await emitAck(sa, 'block:update', { topicId: topic.id, id: blockId, content: 'SECRET draft', position: 1 });
  assert.equal(upAck.ok, true, 'update should be acknowledged');
  const ev = await editEvt;
  assert.equal(ev.state, 'editing');
  assert.equal(ev.content, undefined, 'in-progress content must NOT be relayed to peers');
  assert.equal(ev.editor_id, 'oa', 'editing notice carries the real editor identity');

  const pubEvt = once(sb, 'block:publish');
  const pubAck = await emitAck(sa, 'block:publish', { topicId: topic.id, id: blockId, content: 'PUBLISHED text', position: 1 });
  assert.equal(pubAck.ok, true);
  const pub = await pubEvt;
  assert.equal(pub.content, 'PUBLISHED text');

  const doc = await srv.req('GET', `/api/topics/${topic.id}/document`, null, TOKEN);
  assert.match(doc.body.markdown, /PUBLISHED text/);

  sa.close(); sb.close();
});

test('a block mid-edit is locked: writes and deletes from others are rejected', async () => {
  const { topic, sockets: [sa, sb] } = await topicWith(srv, TOKEN, 2);
  const blockId = 'blk-lock-' + topic.id;

  assert.equal((await emitAck(sa, 'block:update', { topicId: topic.id, id: blockId, content: 'alice draft', position: 1 })).ok, true);

  const up = await emitAck(sb, 'block:update', { topicId: topic.id, id: blockId, content: 'bob stomps', position: 1 });
  assert.deepEqual({ ok: up.ok, error: up.error }, { ok: false, error: 'locked' }, 'foreign update must be rejected');
  assert.equal(up.by, 'alice', 'rejection names the lock holder');
  const pub = await emitAck(sb, 'block:publish', { topicId: topic.id, id: blockId, content: 'bob publishes over it', position: 1 });
  assert.equal(pub.error, 'locked', 'foreign publish must be rejected');
  const del = await emitAck(sb, 'block:delete', { topicId: topic.id, id: blockId });
  assert.equal(del.error, 'locked', 'foreign delete must be rejected');

  // content unchanged on the server
  await emitAck(sa, 'block:publish', { topicId: topic.id, id: blockId, content: 'alice final', position: 1 });
  const rows = (await srv.req('GET', `/api/topics/${topic.id}/blocks`, null, TOKEN)).body;
  assert.equal(rows.find((r) => r.id === blockId).content, 'alice final');

  // lock released after publish → bob may edit now (anyone-may-edit by design)
  const after = await emitAck(sb, 'block:update', { topicId: topic.id, id: blockId, content: 'bob edits freely', position: 1 });
  assert.equal(after.ok, true, 'lock must be released by publish');

  sa.close(); sb.close();
});

test('REST and export withhold mid-edit draft content', async () => {
  const { topic, sockets: [sa] } = await topicWith(srv, TOKEN, 1);
  const blockId = 'blk-mask-' + topic.id;
  await emitAck(sa, 'block:publish', { topicId: topic.id, id: blockId, content: 'visible v1', position: 1 });
  await emitAck(sa, 'block:update', { topicId: topic.id, id: blockId, content: 'WITHHELD v2 secret', position: 1 });

  const rows = (await srv.req('GET', `/api/topics/${topic.id}/blocks`, null, TOKEN)).body;
  const row = rows.find((r) => r.id === blockId);
  assert.equal(row.state, 'editing');
  assert.equal(row.content, '', 'REST must not serve mid-edit content');
  const doc = (await srv.req('GET', `/api/topics/${topic.id}/document`, null, TOKEN)).body;
  assert.doesNotMatch(doc.markdown, /WITHHELD/, 'export must not include mid-edit content');

  await emitAck(sa, 'block:publish', { topicId: topic.id, id: blockId, content: 'visible v2', position: 1 });
  const doc2 = (await srv.req('GET', `/api/topics/${topic.id}/document`, null, TOKEN)).body;
  assert.match(doc2.markdown, /visible v2/, 'published content is served again');
  sa.close();
});

test('rejects a block for a non-existent topic (no orphans) — with an ack', async () => {
  const c = await srv.connect(TOKEN, { ownerId: 'ox', name: 'xena' });
  assert.ok(c.ok);
  const ack = await emitAck(c.socket, 'block:update', { topicId: 999999, id: 'orphan-1', content: 'hi', position: 1 });
  assert.deepEqual({ ok: ack.ok, error: ack.error }, { ok: false, error: 'no-topic' });
  assert.equal((await srv.req('GET', '/api/topics/999999/blocks', null, TOKEN)).status, 404);
  c.socket.close();
});

test('rejects empty-content blocks (no invisible rows)', async () => {
  const { topic, sockets: [sa] } = await topicWith(srv, TOKEN, 1);
  const ack = await emitAck(sa, 'block:update', { topicId: topic.id, id: 'blk-empty-' + topic.id, content: '   ', position: 1 });
  assert.deepEqual({ ok: ack.ok, error: ack.error }, { ok: false, error: 'empty' });
  const rows = (await srv.req('GET', `/api/topics/${topic.id}/blocks`, null, TOKEN)).body;
  assert.equal(rows.length, 0);
  sa.close();
});

test('oversized content is truncated AND the ack says so', async () => {
  const { topic, sockets: [sa] } = await topicWith(srv, TOKEN, 1);
  const blockId = 'blk-big-' + topic.id;
  const big = 'x'.repeat(100001);
  const ack = await emitAck(sa, 'block:publish', { topicId: topic.id, id: blockId, content: big, position: 1 });
  assert.equal(ack.ok, true);
  assert.equal(ack.truncated, true, 'client must learn its content was clipped');
  const rows = (await srv.req('GET', `/api/topics/${topic.id}/blocks`, null, TOKEN)).body;
  assert.equal(rows.find((r) => r.id === blockId).content.length, 100000);
  sa.close();
});

test('identity comes from the handshake — payload spoofing is ignored', async () => {
  const { topic, sockets: [sa, sb] } = await topicWith(srv, TOKEN, 2);
  const blockId = 'blk-spoof-' + topic.id;
  const evt = once(sb, 'block:update');
  // sa (oa/alice) tries to claim it edits as bob
  await emitAck(sa, 'block:update', { topicId: topic.id, id: blockId, ownerId: 'ob', author: 'bob', content: 'spoofed', position: 1 });
  const ev = await evt;
  assert.equal(ev.editor_id, 'oa', 'editor identity must come from the socket, not the payload');
  assert.equal(ev.last_modified_by, 'alice');
  sa.close(); sb.close();
});

// ---------------------------------------------------------------------------
// Separate server: tight block cap → rejected writes must say so
// ---------------------------------------------------------------------------
test('writes at the per-topic block cap are rejected with an ack, never silently dropped', async () => {
  const capped = await spawnServer({ MAX_BLOCKS_PER_TOPIC: '2' });
  try {
    const token = await capped.login();
    const { topic, sockets: [sa] } = await topicWith(capped, token, 1);
    assert.equal((await emitAck(sa, 'block:publish', { topicId: topic.id, id: 'c1', content: 'one', position: 1 })).ok, true);
    assert.equal((await emitAck(sa, 'block:publish', { topicId: topic.id, id: 'c2', content: 'two', position: 2 })).ok, true);
    const third = await emitAck(sa, 'block:publish', { topicId: topic.id, id: 'c3', content: 'three', position: 3 });
    assert.deepEqual({ ok: third.ok, error: third.error }, { ok: false, error: 'cap' });
    const rows = (await capped.req('GET', `/api/topics/${topic.id}/blocks`, null, token)).body;
    assert.equal(rows.length, 2, 'the rejected block must not exist');
    sa.close();
  } finally { capped.stop(); }
});

test('topic cap rejections are acknowledged', async () => {
  const capped = await spawnServer({ MAX_TOPICS: '1' });
  try {
    const token = await capped.login();
    const c = await capped.connect(token, { ownerId: 'oa', name: 'alice' });
    assert.ok(c.ok);
    assert.equal((await emitAck(c.socket, 'topic:create', { title: 'first' })).ok, true);
    const second = await emitAck(c.socket, 'topic:create', { title: 'second' });
    assert.deepEqual({ ok: second.ok, error: second.error }, { ok: false, error: 'cap' });
    c.socket.close();
  } finally { capped.stop(); }
});

test('every publish records a revision: newest first, de-duped, capped at 30', async () => {
  const { topic, sockets: [sa] } = await topicWith(srv, TOKEN, 1);
  const blockId = 'blk-rev-' + topic.id;
  for (const v of ['v1', 'v2', 'v2', 'v3']) { // the duplicate publish must not add an entry
    assert.equal((await emitAck(sa, 'block:publish', { topicId: topic.id, id: blockId, content: v, position: 1 })).ok, true);
  }
  assert.equal((await srv.req('GET', `/api/blocks/${blockId}/revisions`)).status, 401, 'history requires auth');
  const revs = (await srv.req('GET', `/api/blocks/${blockId}/revisions`, null, TOKEN)).body;
  assert.deepEqual(revs.map((r) => r.content), ['v3', 'v2', 'v1'], 'newest first, duplicates skipped');

  for (let i = 0; i < 35; i++) {
    await emitAck(sa, 'block:publish', { topicId: topic.id, id: blockId, content: 'bulk-' + i, position: 1 });
    await sleep(40); // stay under the 30 events/s socket budget
  }
  const pruned = (await srv.req('GET', `/api/blocks/${blockId}/revisions`, null, TOKEN)).body;
  assert.equal(pruned.length, 30, 'history is capped per block');
  assert.equal(pruned[0].content, 'bulk-34', 'the newest versions are the ones kept');
  sa.close();
});

test('topic rename: persisted and broadcast', async () => {
  const { topic, sockets: [sa, sb] } = await topicWith(srv, TOKEN, 2);
  const bcast = once(sb, 'topic:renamed');
  const ack = await emitAck(sa, 'topic:rename', { topicId: topic.id, title: 'Renamed!' });
  assert.equal(ack.ok, true);
  assert.deepEqual(await bcast, { id: topic.id, title: 'Renamed!' });
  const list = (await srv.req('GET', '/api/topics', null, TOKEN)).body;
  assert.equal(list.find((t) => t.id === topic.id).title, 'Renamed!');
  sa.close(); sb.close();
});

test('topic delete: cascades blocks + history, broadcasts, refused while someone else edits', async () => {
  const { topic, sockets: [sa, sb] } = await topicWith(srv, TOKEN, 2);
  const blockId = 'blk-cas-' + topic.id;
  await emitAck(sa, 'block:publish', { topicId: topic.id, id: blockId, content: 'doomed', position: 1 });

  // bob holds an edit in the topic → alice's delete is refused
  await emitAck(sb, 'block:update', { topicId: topic.id, id: blockId, content: 'bob editing', position: 1 });
  const refused = await emitAck(sa, 'topic:delete', { topicId: topic.id });
  assert.deepEqual({ ok: refused.ok, error: refused.error }, { ok: false, error: 'locked' });

  // bob lets go → delete succeeds, cascades, and broadcasts
  await emitAck(sb, 'block:publish', { topicId: topic.id, id: blockId, content: 'bob done', position: 1 });
  const bcast = once(sb, 'topic:deleted');
  assert.equal((await emitAck(sa, 'topic:delete', { topicId: topic.id })).ok, true);
  assert.deepEqual(await bcast, { id: topic.id });
  assert.equal((await srv.req('GET', `/api/topics/${topic.id}/blocks`, null, TOKEN)).status, 404, 'topic is gone');
  assert.equal((await srv.req('GET', `/api/blocks/${blockId}/revisions`, null, TOKEN)).status, 404, 'block history is gone');
  const list = (await srv.req('GET', '/api/topics', null, TOKEN)).body;
  assert.equal(list.some((t) => t.id === topic.id), false, 'sidebar list no longer contains it');
  sa.close(); sb.close();
});

test('backup endpoint: 401 without a token, a real SQLite snapshot with one', async () => {
  assert.equal((await srv.req('GET', '/api/backup')).status, 401);
  const r = await srv.req('GET', '/api/backup', null, TOKEN);
  assert.equal(r.status, 200);
  assert.ok(String(r.body).startsWith('SQLite format 3'), 'download must be a SQLite database file');
});

test('login throttle: locked out after 10 attempts; a success resets the bucket', async () => {
  const t = await spawnServer();
  try {
    for (let i = 0; i < 10; i++) {
      assert.equal((await t.req('POST', '/api/login', { username: USER, password: 'nope' })).status, 401);
    }
    // 11th attempt — even with CORRECT credentials — is throttled
    assert.equal((await t.req('POST', '/api/login', { username: USER, password: PASSWORD })).status, 429);
  } finally { t.stop(); }

  const u = await spawnServer();
  try {
    for (let i = 0; i < 5; i++) await u.req('POST', '/api/login', { username: USER, password: 'nope' });
    assert.equal((await u.req('POST', '/api/login', { username: USER, password: PASSWORD })).status, 200);
    // the success cleared the bucket: 9 more failures stay 401, not 429
    let last;
    for (let i = 0; i < 9; i++) last = await u.req('POST', '/api/login', { username: USER, password: 'nope' });
    assert.equal(last.status, 401, 'an office NAT must not lock itself out after one successful login');
  } finally { u.stop(); }
});

test('concurrent sockets per IP are capped', async () => {
  const capped = await spawnServer({ MAX_SOCKETS_PER_IP: '2' });
  try {
    const token = await capped.login();
    const a = await capped.connect(token, { ownerId: 'o1', name: 'one' });
    const b = await capped.connect(token, { ownerId: 'o2', name: 'two' });
    assert.ok(a.ok && b.ok);
    const c = await capped.connect(token, { ownerId: 'o3', name: 'three' });
    assert.equal(c.ok, false, 'the connection over the cap must be rejected');
    a.socket.close(); b.socket.close();
  } finally { capped.stop(); }
});

// ---------------------------------------------------------------------------
// Separate server: short grace window → disconnect semantics
// ---------------------------------------------------------------------------
test('disconnect force-publishes the draft after the grace window, attributed to its real owner', async () => {
  const fast = await spawnServer({ EDIT_GRACE_MS: '200' });
  try {
    const token = await fast.login();
    const { topic, sockets: [sa, sb] } = await topicWith(fast, token, 2);
    const blockId = 'blk-gone-' + topic.id;
    await emitAck(sa, 'block:update', { topicId: topic.id, id: blockId, content: 'half-typed thought', position: 1 });

    const pubEvt = once(sb, 'block:publish', 5000);
    sa.close(); // alice's tab dies mid-edit
    const pub = await pubEvt;
    assert.equal(pub.id, blockId);
    assert.equal(pub.content, 'half-typed thought', 'departure publishes the last persisted draft');
    assert.equal(pub.editor_id, 'oa', 'force-publish must carry the real owner, never an unfilterable blank');

    const rows = (await fast.req('GET', `/api/topics/${topic.id}/blocks`, null, token)).body;
    assert.equal(rows.find((r) => r.id === blockId).state, 'published');
    sb.close();
  } finally { fast.stop(); }
});

test('a reconnecting editor re-claims the lock within the grace window — no draft leak', async () => {
  const fast = await spawnServer({ EDIT_GRACE_MS: '600' });
  try {
    const token = await fast.login();
    const { topic, sockets: [sa, sb] } = await topicWith(fast, token, 2);
    const blockId = 'blk-blip-' + topic.id;
    await emitAck(sa, 'block:update', { topicId: topic.id, id: blockId, content: 'still typing this', position: 1 });

    sa.close(); // network blip…
    const c2 = await fast.connect(token, { ownerId: 'oa', name: 'alice' }); // …same identity returns
    assert.ok(c2.ok);
    c2.socket.emit('topic:join', { topicId: topic.id, name: 'alice', ownerId: 'oa' });
    const reclaim = await emitAck(c2.socket, 'block:update', { topicId: topic.id, id: blockId, content: 'still typing this!', position: 1 });
    assert.equal(reclaim.ok, true, 'the returning session must be allowed to continue its own edit');

    // The blip must NOT have published the draft to the room.
    assert.equal(await arrives(sb, 'block:publish', 900), false, 'no force-publish after a re-claimed blip');
    const rows = (await fast.req('GET', `/api/topics/${topic.id}/blocks`, null, token)).body;
    assert.equal(rows.find((r) => r.id === blockId).state, 'editing', 'block is still mid-edit');

    c2.socket.close(); sb.close();
  } finally { fast.stop(); }
});
