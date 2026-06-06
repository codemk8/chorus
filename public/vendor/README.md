# Vendored frontend libraries

These minified libraries are committed here and served from the app's own origin
(`/vendor/…`) instead of a CDN, so Chorus has **no runtime third-party dependency**:
it works offline / air-gapped, keeps the Content-Security-Policy same-origin, and a
CDN outage can't break the app.

| File | Library | Version | Source |
| --- | --- | --- | --- |
| `markdown-it.min.js` | [markdown-it](https://github.com/markdown-it/markdown-it) | 14.1.0 | `https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/dist/markdown-it.min.js` |
| `highlight.min.js` | [highlight.js](https://highlightjs.org/) (common languages) | 11.9.0 | `https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/highlight.min.js` |
| `mermaid.min.js` | [mermaid](https://mermaid.js.org/) | 10.9.1 | `https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js` |

## Updating

Re-download the same paths at the new version and bump the version here:

```bash
curl -sSfL "https://cdn.jsdelivr.net/npm/markdown-it@<v>/dist/markdown-it.min.js"        -o markdown-it.min.js
curl -sSfL "https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@<v>/highlight.min.js"    -o highlight.min.js
curl -sSfL "https://cdn.jsdelivr.net/npm/mermaid@<v>/dist/mermaid.min.js"                 -o mermaid.min.js
```

`mermaid.min.js` is large (~3 MB) — that's the cost of fully self-contained, offline
diagram rendering.
