# Chorus 🎶

[![CI](https://github.com/codemk8/chorus/actions/workflows/ci.yml/badge.svg)](https://github.com/codemk8/chorus/actions/workflows/ci.yml)
[![Docker image](https://img.shields.io/badge/ghcr.io-codemk8%2Fchorus-2496ED?logo=docker&logoColor=white)](https://github.com/codemk8/chorus/pkgs/container/chorus)
[![Version](https://img.shields.io/github/v/tag/codemk8/chorus?label=version&sort=semver&color=success)](https://github.com/codemk8/chorus/releases)
[![Node](https://img.shields.io/badge/node-18%2B-3c873a?logo=node.js&logoColor=white)](DEVELOPER.md)
[![License: MIT](https://img.shields.io/github/license/codemk8/chorus?color=blue)](LICENSE)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/primastudio)

Real-time collaborative Markdown discussions. Co-author one shared document per
**topic** from author-owned **blocks**, rendered live with
[Mermaid](https://mermaid.js.org/) diagrams and syntax highlighting — conflict-free
**without a CRDT**, because every block is owned by one person, so edits never collide.

![Chorus in action: Alice and Bob co-author one document side by side — each sees an "… is modifying" overlay while the other writes, then prose, a code block, and a Mermaid diagram render for both on publish; at the end Bob switches to a light theme while Alice stays dark](docs/demo.gif)

> Peers see _"…is modifying"_ while you write, and your block — prose, highlighted
> code, or a Mermaid diagram — renders for everyone the instant you publish
> (Shift+Enter). Each person can even pick their own theme.

## Self-hosting

Chorus is one Node process plus a SQLite file. **Login is on by default**: the server
prints a username (`admin`) and a random password on startup. Set your own with
`CHORUS_USER` / `CHORUS_PASSWORD`, or pass `--no-auth` for an open sandbox.

### With Docker

Pull the published image (built for `amd64` + `arm64` on every release):

```bash
docker run -p 3000:3000 -v chorus-data:/data ghcr.io/codemk8/chorus:latest
```

…or build it yourself:

```bash
docker build -t chorus .
docker run -p 3000:3000 -v chorus-data:/data chorus
```

Open **http://localhost:3000** and sign in with the credentials printed in the logs
(`docker logs <container>`). Set your own with `-e CHORUS_USER=… -e CHORUS_PASSWORD=…`;
the `/data` volume keeps the database across restarts.

### From source

Requires **Node 18+** (`better-sqlite3` builds a native addon, so you need a C/C++
toolchain — Xcode Command Line Tools on macOS, `build-essential` on Linux).

```bash
git clone https://github.com/codemk8/chorus.git
cd chorus
npm install
npm start
```

Open **http://localhost:3000** and sign in with the credentials printed on boot. To
try the real-time collaboration, open the URL in a second browser or tab, sign in,
pick a different display name, and join the same topic.

## Documentation

Features, configuration, the HTTP API, the no-CRDT architecture, production
hardening, and tests all live in **[DEVELOPER.md](DEVELOPER.md)**.

## License

MIT
