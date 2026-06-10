'use strict';

// Browser end-to-end tests: drive the real frontend in headless Chrome against
// a real server, covering the invariants the server suite can't see — the
// editing UX (draft-on-blur, the Esc checkpoint stack), reconnect re-sync
// (idle and deferred-while-editing), the lock overlay, and multi-tab sync.
//
// Run with: npm run test:browser
// Skips itself when no Chrome/Chromium binary is found (set CHROME_PATH to
// override detection).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) { /* next */ }
  }
  return null;
}
const CHROME = findChrome();
const SKIP = CHROME ? false : 'no Chrome/Chromium found (set CHROME_PATH)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let puppeteer, browser, proc, base, DB;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

before(async () => {
  if (SKIP) return;
  puppeteer = require('puppeteer-core');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  DB = path.join(os.tmpdir(), `chorus-btest-${process.pid}.db`);
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), `--port=${port}`], {
    env: { ...process.env, CHORUS_DB: DB, CHORUS_NO_AUTH: '1', EDIT_GRACE_MS: '1500' },
    stdio: 'ignore',
  });
  const start = Date.now();
  for (;;) {
    const ok = await new Promise((resolve) => {
      http.get(base + '/healthz', (r) => resolve(r.statusCode === 200)).on('error', () => resolve(false));
    });
    if (ok) break;
    if (Date.now() - start > 15000) throw new Error('server did not start');
    await sleep(150);
  }
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});

after(async () => {
  if (browser) await browser.close().catch(() => {});
  if (proc) proc.kill('SIGTERM');
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
});

// ----- helpers -------------------------------------------------------------

// A user = an isolated browser context with its own identity + fast autosave.
async function user(name, ownerId) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page._errors = [];
  page.on('pageerror', (e) => page._errors.push(String(e && e.message)));
  await page.evaluateOnNewDocument((n, o) => {
    localStorage.setItem('chorus:name', n);
    localStorage.setItem('chorus:ownerId', o);
    localStorage.setItem('chorus:autosaveMs', '700');
  }, name, ownerId);
  await page.goto(base, { waitUntil: 'networkidle2' });
  await sleep(300);
  return page;
}

// Poll until an in-page predicate is true; returns whether it became true.
async function until(page, fn, arg, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    let v = false;
    try { v = await page.evaluate(fn, arg); } catch (_) { /* navigation race */ }
    if (v) return true;
    if (Date.now() - start > timeoutMs) return false;
    await sleep(150);
  }
}

const bodyHas = (page, text, t) => until(page, (s) => document.body.textContent.includes(s), text, t);
const bodyLacks = (page, text, t) => until(page, (s) => !document.body.textContent.includes(s), text, t);

async function createTopic(page, title) {
  await page.type('#topicInput', title);
  await page.click('#topicCreate');
  await until(page, (t) => [...document.querySelectorAll('.topic .t-title')].some((x) => x.textContent === t), title);
}
async function openTopic(page, title) {
  const ok = await until(page, (t) => {
    const el = [...document.querySelectorAll('.topic .t-title')].find((x) => x.textContent === t);
    if (!el) return false;
    el.closest('.topic').click();
    return true;
  }, title);
  assert.ok(ok, `topic "${title}" should be in the sidebar`);
  await sleep(350);
}
async function publishBlock(page, text) {
  await page.click('.new-line.bottom');
  await sleep(150);
  await page.keyboard.type(text);
  await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');
  await sleep(200);
  await page.keyboard.press('Escape'); // close the auto-opened next block
  await sleep(200);
}
async function editBlockContaining(page, text) {
  const ok = await until(page, (s) => {
    const el = [...document.querySelectorAll('.src-block')].find((r) => r.textContent.includes(s));
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  }, text);
  assert.ok(ok, `block containing "${text}" should exist`);
  await until(page, () => !!document.querySelector('.src-block textarea'), null, 3000);
}
const noErrors = (page, who) => assert.deepEqual(page._errors, [], `${who} page must have no JS errors`);

// ----- tests ---------------------------------------------------------------

test('publish flows to peers; mid-edit content is withheld behind the overlay', { skip: SKIP }, async () => {
  const alice = await user('alice', 'oa-pub');
  const bob = await user('bob', 'ob-pub');
  await createTopic(alice, 'T-publish');
  await openTopic(alice, 'T-publish');
  await publishBlock(alice, 'hello from alice');
  await openTopic(bob, 'T-publish');
  assert.ok(await bodyHas(bob, 'hello from alice'), 'bob sees the published block');

  await editBlockContaining(alice, 'hello from alice');
  await alice.keyboard.type(' SECRET-WIP');
  await sleep(1200); // > autosave → the draft is persisted (but withheld)
  assert.ok(await until(bob, () => !!document.querySelector('.src-block.modifying')), 'bob sees the lock overlay');
  assert.equal(await bob.evaluate(() => document.body.textContent.includes('SECRET-WIP')), false, 'draft text must not reach bob');

  // bob cannot grab the locked block
  await bob.evaluate(() => { document.querySelector('.src-block').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
  await sleep(300);
  assert.equal(await bob.evaluate(() => !!document.querySelector('.src-block textarea')), false, 'locked block must not open an editor for bob');

  // publish releases the lock and delivers the content
  await alice.focus('.src-block textarea');
  await alice.keyboard.down('Shift'); await alice.keyboard.press('Enter'); await alice.keyboard.up('Shift');
  await alice.keyboard.press('Escape');
  assert.ok(await bodyHas(bob, 'SECRET-WIP'), 'published content reaches bob');
  assert.ok(await until(bob, () => !document.querySelector('.src-block.modifying')), 'overlay clears after publish');
  noErrors(alice, 'alice'); noErrors(bob, 'bob');
  await alice.browserContext().close(); await bob.browserContext().close();
});

test('blur keeps an unpublished draft — it never publishes', { skip: SKIP }, async () => {
  const alice = await user('alice', 'oa-blur');
  const bob = await user('bob', 'ob-blur');
  await createTopic(alice, 'T-blur');
  await openTopic(alice, 'T-blur');
  await publishBlock(alice, 'base text');
  await openTopic(bob, 'T-blur');
  assert.ok(await bodyHas(bob, 'base text'));

  await editBlockContaining(alice, 'base text');
  await alice.keyboard.type(' DRAFT-ONLY');
  await sleep(1000); // autosaved as a draft
  await alice.evaluate(() => document.querySelector('.src-block textarea').blur());
  await sleep(600);

  assert.equal(await alice.evaluate(() => !!document.querySelector('.src-block.draft')), true, 'alice sees her draft marker');
  assert.equal(await bob.evaluate(() => document.body.textContent.includes('DRAFT-ONLY')), false, 'blur must not publish to bob');

  // the draft text survives re-entering the editor
  await editBlockContaining(alice, 'base text');
  const val = await alice.evaluate(() => document.querySelector('.src-block textarea').value);
  assert.match(val, /DRAFT-ONLY/, 'draft content is retained for the author');
  await alice.keyboard.down('Shift'); await alice.keyboard.press('Enter'); await alice.keyboard.up('Shift');
  await alice.keyboard.press('Escape');
  assert.ok(await bodyHas(bob, 'DRAFT-ONLY'), 'explicit publish still works after a draft');
  noErrors(alice, 'alice'); noErrors(bob, 'bob');
  await alice.browserContext().close(); await bob.browserContext().close();
});

test('Esc steps back through auto-save checkpoints, final Esc cancels a new block', { skip: SKIP }, async () => {
  const alice = await user('alice', 'oa-esc');
  await createTopic(alice, 'T-esc');
  await openTopic(alice, 'T-esc');

  await alice.click('.new-line.bottom');
  await sleep(150);
  await alice.keyboard.type('alpha');
  await sleep(1100);                    // checkpoint: "alpha"
  await alice.keyboard.type(' beta');   // unsaved typing on top

  await alice.keyboard.press('Escape'); // drop unsaved → back to last checkpoint
  await sleep(150);
  const v1 = await alice.evaluate(() => document.querySelector('.src-block textarea').value);
  assert.equal(v1, 'alpha', 'first Esc returns to the last checkpoint');

  // keep pressing Esc → walk the stack → cancel (block was new → discarded)
  for (let i = 0; i < 8; i++) { await alice.keyboard.press('Escape'); await sleep(120); }
  assert.equal(await alice.evaluate(() => !!document.querySelector('.src-block textarea')), false, 'edit session ends');
  assert.ok(await bodyLacks(alice, 'alpha'), 'a never-published block is discarded on cancel');
  noErrors(alice, 'alice');
  await alice.browserContext().close();
});

test('reconnect re-syncs changes missed while offline (idle)', { skip: SKIP }, async () => {
  const alice = await user('alice', 'oa-rec');
  const bob = await user('bob', 'ob-rec');
  await createTopic(alice, 'T-rec');
  await openTopic(alice, 'T-rec');
  await publishBlock(alice, 'before the gap');
  await openTopic(bob, 'T-rec');

  await alice.setOfflineMode(true);
  await until(alice, () => !document.querySelector('#connStatus').classList.contains('hidden'), null, 6000);
  await publishBlock(bob, 'MISSED-WHILE-DARK');
  await sleep(400);
  assert.equal(await alice.evaluate(() => document.body.textContent.includes('MISSED-WHILE-DARK')), false);

  await alice.setOfflineMode(false);
  assert.ok(await bodyHas(alice, 'MISSED-WHILE-DARK', 12000), 'reconnect pulls the missed publish');
  assert.ok(await until(alice, () => document.querySelector('#connStatus').classList.contains('hidden')), 'pill hides again');
  noErrors(alice, 'alice'); noErrors(bob, 'bob');
  await alice.browserContext().close(); await bob.browserContext().close();
});

test('reconnect while editing defers the re-sync until the edit ends', { skip: SKIP }, async () => {
  const alice = await user('alice', 'oa-def');
  const bob = await user('bob', 'ob-def');
  await createTopic(alice, 'T-def');
  await openTopic(alice, 'T-def');
  await publishBlock(alice, 'alice block');
  await openTopic(bob, 'T-def');

  await editBlockContaining(alice, 'alice block');
  await alice.keyboard.type(' STILL-TYPING');
  await sleep(1000);                                  // draft persisted
  await alice.setOfflineMode(true); await sleep(800);
  await publishBlock(bob, 'BOB-IN-THE-GAP');
  await alice.setOfflineMode(false); await sleep(2500);

  // mid-edit: textarea intact, missed block not yet pulled in
  const taVal = await alice.evaluate(() => { const ta = document.querySelector('.src-block textarea'); return ta ? ta.value : null; });
  assert.match(String(taVal), /STILL-TYPING/, 'the active draft must survive the reconnect');

  await alice.focus('.src-block textarea');
  await alice.keyboard.down('Shift'); await alice.keyboard.press('Enter'); await alice.keyboard.up('Shift');
  await alice.keyboard.press('Escape');
  assert.ok(await bodyHas(alice, 'BOB-IN-THE-GAP', 12000), 'deferred re-sync lands after publish');
  assert.ok(await bodyHas(bob, 'STILL-TYPING'), 'the draft typed through the outage reaches bob');
  noErrors(alice, 'alice'); noErrors(bob, 'bob');
  await alice.browserContext().close(); await bob.browserContext().close();
});

test('a second tab with the same identity stays in sync', { skip: SKIP }, async () => {
  const tab1 = await user('alice', 'oa-tabs');
  const tab2 = await user('alice', 'oa-tabs'); // same ownerId, separate context = separate socket
  await createTopic(tab1, 'T-tabs');
  await openTopic(tab1, 'T-tabs');
  await until(tab2, () => [...document.querySelectorAll('.topic .t-title')].some((x) => x.textContent === 'T-tabs'));
  await openTopic(tab2, 'T-tabs');

  await publishBlock(tab1, 'typed in tab one');
  assert.ok(await bodyHas(tab2, 'typed in tab one'), 'own-identity publishes must reach the other tab');
  noErrors(tab1, 'tab1'); noErrors(tab2, 'tab2');
  await tab1.browserContext().close(); await tab2.browserContext().close();
});
