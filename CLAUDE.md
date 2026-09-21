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
  index.html        # single HTML shell — two views + #pagination container
  scripts/app.js    # all frontend logic (hash router, pagination, markdown, KaTeX)
  styles/main.css   # CSS variables + component styles
```

### Two-view SPA pattern

The frontend toggles between two views:
- **List view**: `.posts-section` visible, `#post-detail` hidden
- **Detail view**: `.posts-section.hidden`, `#post-detail.active`

### Hash router

Views are addressable so the browser back button works. Routes:

```
#/               list, page 1      #/2                 list, page 2
#/dev            category, page 1  #/ai/3              category, page 3
#/series         series index      #/series/RAG 평가/2  series posts, page 2
#/post/<id>      post detail
```

A numeric segment is a page number, anything else is a category — they never
collide. Page 1 is omitted from the URL. `series` is a **reserved first
segment**: a category with that name would be swallowed by the series route.

Rules to keep intact when touching `app.js`:

- **Clicks only set `location.hash`.** All rendering happens in `applyRoute()`,
  driven by `hashchange`. Never call `showPostDetail()` / `renderPosts()`
  directly from a click handler — the history entry would be skipped.
- **Only `#/…` is a route.** Post bodies contain in-page anchors (`](#appendix)`).
  `parseRoute()` returns `null` for those so the post stays open; treating them as
  routes kicks the reader back to the list.
- `applyRoute()` skips re-rendering when the route is unchanged (`renderedHash`),
  so returning from an in-page anchor doesn't re-fetch the post.
- Out-of-range pages are clamped to the last page and the URL is corrected with
  `history.replaceState` — never `location.hash =`, which would add an entry.
- `← 목록으로` navigates to the list route rather than `history.back()`: after
  hopping between posts via the series TOC, `back()` lands on another post.
  `listRoute()` builds that route, so a reader who came from a series returns to
  the series and not to the category list.

### Series

`Series` in the nav is not a category — it is its own route. `#/series` renders
`renderSeriesIndex()` (one card per `series:` value, most recently updated
first); a card opens `#/series/<name>`, which renders the normal post list
filtered to that series.

`currentSeries` is the switch: `filteredPosts()` returns the series in
`series_order` order and `renderPosts()` skips its date sort when it is set, so
a series always reads 1 → N. `applyRoute()` clears it on every list route —
leaving it set would silently filter the category views. A URL naming an unknown
series falls back to the index, mirroring how an unknown category falls back to
the full list.

The series name goes into the URL percent-encoded (`#/series/RAG%20평가`); there
is no slug field, so renaming a series in frontmatter changes its URL.

### Pagination

`PAGE_SIZE = 5`. `renderPagination()` draws nothing when everything fits on one
page. Page numbers are listed in full up to 7 pages, then abbreviated to
`1 … 4 5 6 … 10`.

`.pagination` base rules must stay **above** the `@media (width <= 768px)` block
in `main.css` — same specificity means the later rule wins, and putting them after
silently kills the mobile overrides. The `#pagination` element must have no
whitespace inside it in `index.html`, or `.pagination:empty` won't match.

### Mobile header

Under `@media (width <= 768px)` the header is a single row — brand · filters ·
social icons — at ~50px, so a post body isn't pushed off a phone screen by the
sticky header. The filter list (`.nav-menu`) doesn't wrap: it scrolls
horizontally, so adding a category never adds a second row. Keep
`min-width: 0` + `flex: 1 1 auto` on `.nav-menu` and `flex: 0 0 auto` on its
`li` — without them the flex row squeezes the items instead of scrolling.

The fade at both ends is the `background-attachment: local/scroll` trick: the
`local` layers scroll with the content and uncover the `scroll` shadow layers
only while there is more to scroll. They use `var(--light-bg)`, so a background
change needs those gradients updated too.

### Post loading flow

1. `loadPosts()` → `GET /api/posts` → `getAllPosts()` reads `content/posts/*.md`, parses frontmatter, returns metadata + excerpt
2. Clicking a post → `#/post/<id>` → `applyRoute()` → `showPostDetail(id)` → `GET /api/posts/:id` → `getPost(id)` returns `{ meta, content }` (already parsed)
3. Frontend renders markdown via `marked.parse()`, then calls `renderMathInElement()` for KaTeX

`marked` renderer overrides live at the top of `app.js` (`html-demo` code blocks,
external links → `target="_blank"`). When overriding a renderer method that
renders inline tokens, call the original with `originalFn.call(this, token)` —
binding it to the local `renderer` instance loses the `this.parser` that
`marked.use()` injects, and rendering throws.

Both post routes set `Cache-Control` (`s-maxage` + `stale-while-revalidate`) so Vercel's edge serves repeat reads without invoking the function.

### No database

The blog is fully static-content driven — posts come from `content/posts/*.md` and nothing else is persisted. There was previously an Upstash Redis (Vercel KV) view counter; it was removed after the instance was deprovisioned. If you ever reintroduce per-post counters, do **not** block rendering on the fetch: render the post first and fill the number in asynchronously.

### Post frontmatter

```markdown
---
title: "글 제목"
date: 2025-03-01
category: dev        # used for nav filter (All/Project/Dev/AI)
tags: ["tag1", "tag2"]
summary: "Optional. If set, used as excerpt in list view instead of auto-generated."
---
```

`series` / `series_order` / `series_repo` drive both the in-post TOC and the
`#/series` screens; posts sharing a `series` string are one series, and
`series_order` is their reading order.

`category` value must match the `data-filter` attribute in `index.html` nav exactly (case-sensitive) — a post whose category has no matching nav button only ever shows under All. The category also appears in the URL (`#/dev`); a URL naming an unknown category falls back to the full list instead of rendering an empty page.

### Security decisions made

- CORS: `ALLOWED_ORIGINS` env var (comma-separated) — **set `ALLOWED_ORIGINS` in Vercel before deploying**. An empty value rejects every cross-origin request; same-origin requests (no `Origin` header) always pass.
- There are no write endpoints and no user-supplied input is stored or rendered, so there is no HTML-escaping path to maintain. Reintroduce `escapeHtml()` before any innerHTML insertion if that changes.

### Deployment

`vercel.json` pins `regions: ["icn1"]` (Seoul) — the audience is Korean, and the default US region added 200ms+ per round trip.

### Environment variables

See `.env.example`. All are optional; the app runs without any of them.
- `ALLOWED_ORIGINS` — CORS whitelist (e.g. `https://your-blog.vercel.app`)
- `GITHUB_URL`, `LINKEDIN_URL` — header social icons; unset renders them as disabled
