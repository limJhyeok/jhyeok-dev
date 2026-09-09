# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install       # install dependencies
npm run dev       # start local dev server → http://localhost:3000
```

No build step, no test runner. The dev server serves both the API and static frontend.

## Architecture

This is a single-page blog with a Node.js/Express backend deployed on Vercel.

```
api/
  index.js          # Express app — all API routes, CORS
  lib/
    posts.js        # getAllPosts(), getPost(id) — reads content/posts/*.md
    frontmatter.js  # parseFrontmatter(raw) → { meta, content }
content/
  posts/            # blog post markdown files (YYYY-MM-DD-slug.md)
public/
  index.html        # single HTML shell — no routing, just two views
  scripts/app.js    # all frontend logic (view switching, markdown, KaTeX)
  styles/main.css   # CSS variables + component styles
```

### Two-view SPA pattern

There is no client-side router. The frontend toggles between two views:
- **List view**: `.posts-section` visible, `#post-detail` hidden
- **Detail view**: `.posts-section.hidden`, `#post-detail.active`

`showPostDetail(postId)` drives the transition.

### Post loading flow

1. `loadPosts()` → `GET /api/posts` → `getAllPosts()` reads `content/posts/*.md`, parses frontmatter, returns metadata + excerpt
2. Clicking a post → `showPostDetail(id)` → `GET /api/posts/:id` → `getPost(id)` returns `{ meta, content }` (already parsed)
3. Frontend renders markdown via `marked.parse()`, then calls `renderMathInElement()` for KaTeX

Both post routes set `Cache-Control` (`s-maxage` + `stale-while-revalidate`) so Vercel's edge serves repeat reads without invoking the function.

### No database

The blog is fully static-content driven — posts come from `content/posts/*.md` and nothing else is persisted. There was previously an Upstash Redis (Vercel KV) view counter; it was removed after the instance was deprovisioned. If you ever reintroduce per-post counters, do **not** block rendering on the fetch: render the post first and fill the number in asynchronously.

### Post frontmatter

```markdown
---
title: "글 제목"
date: 2025-03-01
category: dev        # used for nav filter (All/Project/Dev/Retro)
tags: ["tag1", "tag2"]
summary: "Optional. If set, used as excerpt in list view instead of auto-generated."
---
```

`category` value must match the `data-filter` attribute in `index.html` nav exactly (case-sensitive).

### Security decisions made

- CORS: `ALLOWED_ORIGINS` env var (comma-separated) — **set `ALLOWED_ORIGINS` in Vercel before deploying**. An empty value rejects every cross-origin request; same-origin requests (no `Origin` header) always pass.
- There are no write endpoints and no user-supplied input is stored or rendered, so there is no HTML-escaping path to maintain. Reintroduce `escapeHtml()` before any innerHTML insertion if that changes.

### Deployment

`vercel.json` pins `regions: ["icn1"]` (Seoul) — the audience is Korean, and the default US region added 200ms+ per round trip.

### Environment variables

See `.env.example`. All are optional; the app runs without any of them.
- `ALLOWED_ORIGINS` — CORS whitelist (e.g. `https://your-blog.vercel.app`)
- `GITHUB_URL`, `LINKEDIN_URL` — header social icons; unset renders them as disabled
