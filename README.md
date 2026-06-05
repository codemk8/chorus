# Chorus 🎶

A full-stack, real-time collaborative discussion web app. Spin up shared
**topics**, and co-author a **common Markdown playground** — one shared document
per topic, built from author-owned **blocks** and rendered with inline
[Mermaid](https://mermaid.js.org/) diagrams.

No login. No build step. No submit button. Just a display name and a browser.

## Features

- **No-login identity** — pick a display name on first visit; it's saved to
  `localStorage` and attributes every block you add.
- **Topics** — anyone can create one; they appear instantly in everyone's
  sidebar.
- **Side-by-side source & render** — two panes: a **line-numbered code editor on
  the left**, the **live rendered document on the right** (scroll-synced). The
  left is one continuous document: **click a line (or its number) to edit it
  inline**, press **Enter** for a new line, **Shift+Enter** for a line break, and
  clear a line to delete it. You can only edit lines you own; everyone else's are
  read-only. The right pane is the rendered, attributed result for the whole topic.
- **Continuous render + attribution chip** — the right pane reads as one Markdown
  document. Ownership shows as a colored left bar, with a small author + timestamp
  chip **floated to the top-right** of each block (the text wraps around it, so it
  never breaks onto its own line).
- **EDITING / PUBLISHED state with a "modifying" overlay** — each block has an
  authoritative `state` in the DB. The moment you put your cursor on a block it's
  `editing`, and peers see a spinner overlay — "**_<you> is modifying…_**" — over
  that block (the last-published content stays visible underneath; your in-progress
  text is **never sent to peers**). You compose freely (**Enter = newline** inside
  the block) and **Shift+Enter publishes** (`state → published`), which is when
  everyone else re-renders it. You always see your own live render (with real
  Markdown/Mermaid syntax errors). If you disconnect mid-edit, the server publishes
  your draft so no one is stuck behind the overlay.
- **One shared document, owned by blocks** — the document is ordered paragraphs
  ("blocks"). While editing a line, press **Enter** to start a new line below (and
  jump to it), **Shift+Enter** for a line break within the line. **Enter inside a
  ` ```fence `** stays a normal newline, so multi-line code/Mermaid isn't split.
  You can also click the `＋` at the start (left edge) of any line to insert below;
  an empty topic shows a one-click **＋ Add a line** prompt. Lines left empty are
  dropped automatically.
- **Anyone can edit any block, with a soft lock** — **double-click** any block to
  edit it. While you're editing, that block is locked: others see an overlay
  ("_<you> is cooking…_", with a randomized fun verb) and can't grab it until you
  publish. So there's only ever one editor per block at a time — collision-free in
  practice, without a CRDT — and each block records **`last_modified_by`** (the
  chip + color follow whoever last touched it).
- **Robust live rendering** — incomplete Markdown/Mermaid never breaks the view:
  diagrams are pre-validated, last-good renders are cached to avoid flicker, and
  a **spinner** marks a block (and any half-written diagram) while it's being
  worked on — no error flashes mid-edit.
- **Presence** — a per-topic online-users list plus a live "_X is editing…_"
  indicator and per-block working spinners.
- **Real-time sync via Socket.io** — `topic:created`, `user:join`,
  `users:update`, `block:update`, and `block:delete` events keep every client in
  lockstep. Live events that arrive while a topic is still loading are **buffered
  and replayed** after the initial snapshot (no lost blocks), and updates are
  applied **monotonically by timestamp** so out-of-order delivery can't regress a
  block.
- **Auto-saved drafts** — while you edit, the draft is persisted to the server on
  a periodic cycle (every 5s) and a footnote at the bottom shows the last save time
  and a countdown to the next. A disconnect mid-edit publishes your last saved draft.
- **Persistent** — blocks are stored in SQLite (`better-sqlite3`) with a
  fractional `position` for ordering; the whole document is restored on page load.
- **Clean dark, developer-friendly UI** — topics sidebar + a single shared
  block document.

## How it works (the idea)

Real-time collaborative editors usually reach for a **CRDT or OT** engine to merge
concurrent edits to the same text. Chorus sidesteps that entirely with one rule:

> **A document is an ordered list of blocks, and each block is owned by exactly one
> person. You can only edit your own blocks.**

Because no two people ever edit the same characters, **there's nothing to merge** —
edits can't conflict by construction. That makes the whole sync layer simple:

- **Ownership** is keyed on a stable per-browser `owner_id` (not the display name),
  and **enforced on the server** for every write — you can't edit or delete a block
  you don't own, and renaming yourself keeps your blocks.
- **Ordering** uses a fractional `position` (insert between `a` and `b` at
  `(a+b)/2`), so inserting/deleting a line is a single-row op with **no
  renumbering**.
- **Concurrency** is safe because the server is single-threaded with synchronous
  SQLite writes (no check-then-write race), block ids are client-generated UUIDs,
  and updates apply **monotonically by timestamp**. Events that land mid-load are
  buffered and replayed.
- **Live feel**: while you type, *you* see your own render (with real Markdown/
  Mermaid syntax errors); *others* see "_… is typing_" until you move off the line.

The trade-off: it's collaborative *per block*, not *per character* — great for
discussions, design docs, and shared scratchpads; not a Google-Docs replacement.

## Stack

| Layer     | Tech                                            |
| --------- | ----------------------------------------------- |
| Backend   | Node.js · Express · Socket.io                   |
| Database  | SQLite via `better-sqlite3`                      |
| Frontend  | Vanilla JS in a single HTML file (inline CSS/JS) |
| Markdown  | `markdown-it` + `mermaid.js` (loaded via CDN)    |

## Setup

Requires **Node.js 18+** (`better-sqlite3` compiles a native addon on install,
so a C/C++ toolchain is needed — included with Xcode Command Line Tools on
macOS, `build-essential` on Linux).

```bash
npm install
node server.js
```

Then open **http://localhost:3000** in your browser.

To try the real-time collaboration, open the URL in a second tab or browser,
pick a different display name, and join the same topic.

### Data & persistence

All topics and blocks are stored in a SQLite file — **`chorus.db`, next to
`server.js`** — created automatically on first run. The path is tied to the
file's location, **not** the port or your current directory, so restarting on a
different port keeps all your data. The server prints the exact path on boot
(`Data: …/chorus.db`).

- To use a different file (e.g. for a throwaway/test run), set `CHORUS_DB`:
  ```bash
  CHORUS_DB=/tmp/scratch.db node server.js
  ```
- Writes go to a write-ahead log (`chorus.db-wal`) first; the server folds it
  back into `chorus.db` **every ~15s** and again on a clean `Ctrl+C`, so the main
  file is always current — even a hard `kill -9` loses at most a few seconds.
- To back up, just copy `chorus.db` (kept current by the periodic checkpoint). To
  reset, delete it while the server is **stopped** (deleting it while running
  orphans the live data and you'll get a fresh, empty DB on the next start).

### Host & port options

By default the server binds to `127.0.0.1` (localhost only). Override the host
and port via CLI flags or environment variables:

```bash
# Custom port
node server.js --port=4000          # or: PORT=4000 node server.js

# Listen on all interfaces — needed for LAN access or a tunnel (ngrok, cloudflared, …)
node server.js --host=0.0.0.0       # or: HOST=0.0.0.0 node server.js

# Combine them
node server.js --host=0.0.0.0 --port=4000
```

Both `--flag=value` and `--flag value` forms work.

**Exposing it through a tunnel:** start with `--host=0.0.0.0`, then point your
tunnel at the same port, e.g.:

```bash
node server.js --host=0.0.0.0 --port=3000
ngrok http 3000          # or: cloudflared tunnel --url http://localhost:3000
```

> ⚠️ `--host=0.0.0.0` makes Chorus reachable by anyone who can hit your machine /
> tunnel URL. There's no authentication — only expose it to people you trust.

## HTTP API

Read-only JSON endpoints (all state changes happen over Socket.io):

| Endpoint | Returns |
| --- | --- |
| `GET /api/topics` | All topics: `[{ id, title, created_at }]` |
| `GET /api/topics/:id/blocks` | The topic's blocks in reading order: `[{ id, owner_id, author, content, position, created_at, updated_at }]` |
| `GET /api/topics/:id/document` | The whole document in one shot (see below) |

`GET /api/topics/:id/document` returns the canonical document — topic metadata, the
ordered owned blocks, and the assembled Markdown:

```json
{
  "id": 1,
  "title": "Auth Flow",
  "created_at": "2026-06-04T…",
  "blocks": [
    { "id": "b-…", "owner_id": "u-…", "author": "alice", "content": "# Auth Flow", "position": 1, "updated_at": "…" }
  ],
  "markdown": "# Auth Flow\n\n## Notes from bob\n\n```mermaid\n…\n```"
}
```

The `markdown` field joins the blocks in order — handy for exporting or copying the
whole topic as one Markdown file. Unknown topics return `404`.

## Deploying a public demo

Chorus is a long-lived Node process with **WebSockets + a local SQLite file**, so
it wants a persistent-process host (a container/VM), **not** serverless/edge.

A `Dockerfile` is included. It listens on `0.0.0.0`, reads `PORT` from the host,
and stores the DB at `CHORUS_DB=/data/chorus.db` (mount a volume at `/data` to keep
data across restarts).

```bash
docker build -t chorus .
docker run -p 3000:3000 -v chorus-data:/data chorus
```

Free-ish hosts:

- **Fly.io** — WebSockets + a small persistent volume; low usage is effectively
  free. `fly launch` (Dockerfile detected) → add a volume mounted at `/data`.
- **Render** (free web service) — one click from the repo, but it **sleeps when
  idle** and its free disk is **ephemeral**, so the DB resets on restart/redeploy.
  For a demo that auto-reset is arguably a feature (it clears spam).

> **GitHub Pages can't host it** — Pages is static-only and Chorus needs a live
> server. GitHub hosts the code; the demo runs on one of the above.

**Demo guardrails** (already built in, tunable via env): per-socket rate limits on
all socket events, a 256 KB payload cap, `MAX_TOPICS` (default 300), and
`MAX_BLOCKS_PER_TOPIC` (default 1000). There is still **no authentication or
moderation** — anyone with the URL can post, so treat a public demo as an open,
disposable sandbox.

## Project structure

```
chorus/
├── package.json
├── server.js          # All backend logic: Express + Socket.io + SQLite
├── Dockerfile         # Container image for deploying a demo
├── README.md
├── LICENSE
└── public/
    └── index.html     # Entire frontend: inline CSS + JS
```

## License

MIT
