'use strict';

// End-to-end tests: spawn the real server with a throwaway DB and a known
// password, then exercise the HTTP API, auth gating, and the realtime layer.
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
let proc, PORT, DB, base, stderr = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = http.request(base + p, { method, headers }, (res) => {
      let buf = ''; res.on('data', (d) => (buf += d));
      res.on('end', () => { let j; try { j = JSON.parse(buf); } catch (_) { j = buf; } resolve({ status: res.statusCode, body: j, headers: res.headers }); });
    });
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}

async function waitReady(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await req('GET', '/healthz'); if (r.status === 200) return; } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not become ready. stderr:\n' + stderr);
}

function connect(token) {
  return new Promise((resolve) => {
    const s = io(base, { transports: ['websocket'], auth: token ? { token } : {}, reconnection: false });
    const fail = (msg) => { try { s.close(); } catch (_) {} resolve({ ok: false, error: msg }); };
    s.once('connect', () => resolve({ ok: true, socket: s }));
    s.once('connect_error', (e) => fail(e.message));
    setTimeout(() => fail('timeout'), 3000);
  });
}
const once = (socket, ev) => new Promise((resolve) => socket.once(ev, resolve));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  PORT = await freePort();
  base = `http://127.0.0.1:${PORT}`;
  DB = path.join(os.tmpdir(), `chorus-test-${process.pid}-${PORT}.db`);
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), `--port=${PORT}`], {
    env: { ...process.env, CHORUS_DB: DB, CHORUS_USER: USER, CHORUS_PASSWORD: PASSWORD },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr.on('data', (d) => (stderr += d));
  await waitReady();
});

after(() => {
  if (proc) proc.kill('SIGTERM');
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
});

test('health check responds', async () => {
  const r = await req('GET', '/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('sends security headers and hides x-powered-by', async () => {
  const r = await req('GET', '/healthz');
  assert.match(r.headers['content-security-policy'] || '', /default-src 'self'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-powered-by'], undefined);
});

test('reports that auth is required', async () => {
  assert.equal((await req('GET', '/api/auth')).body.required, true);
});

test('REST data endpoints are gated without a token', async () => {
  assert.equal((await req('GET', '/api/topics')).status, 401);
});

test('login rejects wrong username or password', async () => {
  assert.equal((await req('POST', '/api/login', { username: USER, password: 'wrong' })).status, 401);
  assert.equal((await req('POST', '/api/login', { username: 'nobody', password: PASSWORD })).status, 401);
});

test('unknown /api route returns JSON 404', async () => {
  const r = await req('GET', '/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'Not found');
});

test('malformed JSON returns 400', async () => {
  const r = await req('POST', '/api/login', '{bad json');
  assert.equal(r.status, 400);
});

let TOKEN;
test('valid login issues a token that unlocks the REST API', async () => {
  const r = await req('POST', '/api/login', { username: USER, password: PASSWORD });
  assert.equal(r.status, 200);
  TOKEN = r.body.token;
  assert.ok(TOKEN && TOKEN.length >= 32);
  const t = await req('GET', '/api/topics', null, TOKEN);
  assert.equal(t.status, 200);
  assert.ok(Array.isArray(t.body));
});

test('socket handshake requires a valid token', async () => {
  assert.equal((await connect(null)).ok, false);
  assert.equal((await connect('garbage')).ok, false);
  const c = await connect(TOKEN);
  assert.equal(c.ok, true);
  c.socket.close();
});

test('realtime: drafts are withheld, publishes are relayed and persisted', async () => {
  const a = await connect(TOKEN);
  const b = await connect(TOKEN);
  assert.ok(a.ok && b.ok);
  const sa = a.socket, sb = b.socket;

  const topic = await new Promise((resolve) => { sa.once('topic:created', resolve); sa.emit('topic:create', { title: 'Realtime' }); });
  assert.ok(topic && topic.id);

  sa.emit('topic:join', { topicId: topic.id, name: 'alice' });
  sb.emit('topic:join', { topicId: topic.id, name: 'bob' });
  await sleep(200);

  const blockId = 'blk-' + PORT;
  const editEvt = once(sb, 'block:update');
  sa.emit('block:update', { topicId: topic.id, id: blockId, ownerId: 'oa', author: 'alice', content: 'SECRET draft', position: 1 });
  const ev = await editEvt;
  assert.equal(ev.state, 'editing');
  assert.equal(ev.content, undefined, 'in-progress content must NOT be relayed to peers');

  const pubEvt = once(sb, 'block:publish');
  sa.emit('block:publish', { topicId: topic.id, id: blockId, ownerId: 'oa', author: 'alice', content: 'PUBLISHED text', position: 1 });
  const pub = await pubEvt;
  assert.equal(pub.content, 'PUBLISHED text');

  const doc = await req('GET', `/api/topics/${topic.id}/document`, null, TOKEN);
  assert.match(doc.body.markdown, /PUBLISHED text/);

  sa.close(); sb.close();
});

test('rejects a block for a non-existent topic (no orphans)', async () => {
  const c = await connect(TOKEN);
  assert.ok(c.ok);
  c.socket.emit('block:update', { topicId: 999999, id: 'orphan-' + PORT, ownerId: 'o', author: 'x', content: 'hi', position: 1 });
  await sleep(200);
  // server should still be alive and the topic shouldn't exist
  assert.equal((await req('GET', '/api/topics/999999/blocks', null, TOKEN)).status, 404);
  c.socket.close();
});
