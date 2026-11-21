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
    page.js         # server HTML: /post/<slug> page (head + body), sitemap, robots
    frontmatter.js  # parseFrontmatter(raw) → { meta, content }
    live-reload.js  # npm run dev only — SSE reload, injected into server-sent HTML
content/
  posts/            # blog post markdown files (YYYY-MM-DD-slug.md)
public/
  index.html        # single HTML shell — two views + #pagination container (also the /post template)
  scripts/app.js    # all frontend logic (router, pagination, markdown, KaTeX)
  styles/main.css   # CSS variables + component styles
```

### Two-view SPA pattern

The frontend toggles between two views:
- **List view**: `.posts-section` visible, `#post-detail` hidden
- **Detail view**: `.posts-section.hidden`, `#post-detail.active`

### Router

Views are addressable so the browser back button works. A post is a **path**;
every list screen is a **hash**:

```
/post/<slug>     post detail        (slug = file name without .md)
/                list, page 1       /#/2                 list, page 2
/#/dev           category, page 1   /#/ai/3              category, page 3
/#/series        series index       /#/series/RAG 평가/2  series posts, page 2
```

Posts need a real path because link-preview bots (KakaoTalk, Slack, …) don't
run JS and search engines don't index fragments: the server can only fill in
per-post `<head>` tags for a URL it actually receives (see *Server-rendered post
pages*). List screens don't need that, so they stay hash routes. The old
`#/post/<id>.md` form is gone and deliberately not redirected — it now parses
as an unknown category `post` and falls back to the full list.

A numeric segment is a page number, anything else is a category — they never
collide. Page 1 is omitted from the URL. `series` is a **reserved first
segment**: a category with that name would be swallowed by the series route.

Rules to keep intact when touching `app.js`:

- **Clicks only change the URL, via `navigate()`.** All rendering happens in
  `applyRoute()`. Never call `showPostDetail()` / `renderPosts()` directly from a
  click handler — the history entry would be skipped.
- **`pushState` + `popstate`, not `location.hash` + `hashchange`.** Moving
  between `/post/x` and `/#/dev` changes the path, which `location.hash =` can't
  do (it would produce `/post/x#/dev`). `pushState` fires no event, so
  `navigate()` calls `applyRoute()` itself; back/forward and in-page anchor jumps
  arrive as `popstate`.
- **On a post, the hash is an in-page anchor, never a route.** Post bodies
  contain anchors (`](#appendix)`). `parseRoute()` decides a post route from the
  pathname alone, and `currentUrl()` ignores the hash for posts, so following or
  returning from an anchor neither leaves the post nor strips the anchor. On list
  screens a hash that doesn't start with `#/` makes `parseRoute()` return `null`.
- `applyRoute()` skips re-rendering when the URL is unchanged (`renderedUrl`),
  so returning from an in-page anchor doesn't re-fetch the post.
- Out-of-range pages are clamped to the last page and the URL is corrected with
  `history.replaceState` — never `pushState`/`location.hash =`, which would add
  an entry.
- **Post links are real `<a href="/post/<slug>">`** — list items, series TOC and
  cross-post links in bodies — so crawlers can follow them. One document-level
  click listener turns plain left-clicks on them into `navigate()`; modified
  clicks (Ctrl/Cmd/Shift, middle button) and `target`ed links are left to the
  browser. Don't add per-element click handlers for post links.
- `document.title` is set on every view change (`SITE_TITLE` for lists, the post
  title for posts) — the server sends a post's title in `<title>`, so without
  this it would stick after navigating back to the list.
- `← 목록으로` navigates to the list route rather than `history.back()`: after
  hopping between posts via the series TOC, `back()` lands on another post.
  `listRoute()` builds that route, so a reader who came from a series returns to
  the series and not to the category list.

### Server-rendered post pages

`GET /post/:slug` (`api/lib/page.js`) reads `public/index.html` as a template and
returns it with:

- **`<head>`**: post `<title>`, `description` (`summary`, else `makeExcerpt()`;
  `\$` unescaped to `$`), `canonical`, `og:type=article`, `og:title`,
  `og:description`, `og:url`, `article:published_time`, `article:tag`. The
  template's site-wide `description` / `og:type|title|description` tags are
  removed first (`OVERRIDDEN_META`) — a duplicate property is read differently by
  each bot. Adding a site-wide meta tag to `index.html` that should vary per post
  means adding it to that regex too. No `og:image` yet: there is no default
  image.
- **Body**: the detail view already open (`.posts-section.hidden`,
  `#post-detail.active`) with the post rendered by server-side `marked`, marked
  `data-ssr`. This is a fallback for crawlers that render JS poorly (Naver) —
  it deliberately does **not** replicate the client's `marked` overrides, KaTeX
  or the series TOC. The client re-renders over it as usual; when it replaces
  `data-ssr` content it keeps the scroll position (or re-scrolls to `#anchor`,
  which the TOC/KaTeX shifted) instead of jumping to the top.

Unknown slug → `404` + `no-store` + `noindex`; the client then falls back to `/`.
A slug ending in `.md` is `301`-redirected to the slug without it. Values going
into the HTML pass through `escapeHtml()` — titles can contain `"`.

`marked` is pinned to the **same version** on the CDN (`index.html`) and in
`package.json` (15.0.12). The unversioned CDN URL silently served 15.x while npm
was on 18.x; keep them in lockstep when upgrading.

`og:url`, `canonical`, `sitemap.xml` and `robots.txt` need absolute URLs: they
use `SITE_URL`, falling back to the request's `x-forwarded-proto` + `host`.
`/sitemap.xml` lists `/` and every post (list screens are fragments, invisible
to crawlers). Both are routes, not static files, because they embed the
absolute URL.

Everything `public/index.html` loads must use **absolute paths** (`/styles/…`,
`/scripts/…`) — relative ones resolve under `/post/` and the `*` fallback
answers them with HTML.

### Series

`Series` in the nav is not a category — it is its own route. `/#/series` renders
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
2. Clicking a post → `navigate()` → `/post/<slug>` → `applyRoute()` → `showPostDetail(id)` → `GET /api/posts/:id` → `getPost(id)` returns `{ meta, content }` (already parsed). The route keeps the file-name `id` (`….md`); only the URL drops `.md` (`idToSlug()` / `slugToId()`, on both server and client)
3. Frontend renders markdown via `marked.parse()`, then calls `renderMathInElement()` for KaTeX

`marked` renderer overrides live at the top of `app.js` (`html-demo` code blocks,
external links → `target="_blank"`) together with a `del` tokenizer override:
only `~~text~~` is strikethrough, a lone `~` stays literal, so range notation
like `5초~7초` needs no `\~` escaping. A literal dollar sign (prices) must be
written `\$`: two bare `$` on one line are rendered as inline math.
`parseMarkdownWithMath()` masks `\$` before `marked` (which would strip the
backslash) and restores it as `<span class="literal-dollar">`, which both
`renderMathInElement()` calls skip via `ignoredClasses`. This only applies to
the post body — `summary` is inserted as-is, so a `\$` there shows the backslash. When overriding a renderer method that
renders inline tokens, call the original with `originalFn.call(this, token)` —
binding it to the local `renderer` instance loses the `this.parser` that
`marked.use()` injects, and rendering throws.

The post API routes, `/post/:slug`, `/sitemap.xml` and `/robots.txt` set `Cache-Control` (`s-maxage`, mostly + `stale-while-revalidate`) so Vercel's edge serves repeat reads without invoking the function. 404s are `no-store`. `stale-while-revalidate` also applies to the browser cache, so the first reload after editing a post can still show the old body; `npm run dev` sends `no-store` everywhere to avoid that.

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

To link to another post from a body, write the path: `[제목](/post/2026-10-22-tau-bench)`
— not the file name and not a `#/…` hash. The click listener keeps it in-app.

`category` value must match the `data-filter` attribute in `index.html` nav exactly (case-sensitive) — a post whose category has no matching nav button only ever shows under All. The category also appears in the URL (`/#/dev`); a URL naming an unknown category falls back to the full list instead of rendering an empty page.

### Security decisions made

- CORS: `ALLOWED_ORIGINS` env var (comma-separated) — **set `ALLOWED_ORIGINS` in Vercel before deploying**. An empty value rejects every cross-origin request; same-origin requests (no `Origin` header) always pass.
- There are no write endpoints and no user-supplied input is stored or rendered. The only escaping path is server-side: `escapeHtml()` in `page.js` for frontmatter values written into `/post` HTML (attributes break on a `"` in a title). Client innerHTML is unescaped author content — reintroduce escaping there before inserting anything user-supplied.

### Deployment

`vercel.json` pins `regions: ["icn1"]` (Seoul) — the audience is Korean, and the default US region added 200ms+ per round trip.

Only `/api/*`, `/post/:slug`, `/sitemap.xml` and `/robots.txt` are rewritten to
the Express function; everything else is served from `public/` by Vercel. A new
server-rendered URL needs a rewrite there too — it works under `npm run dev`
(Express serves everything) and 404s on Vercel without one. The function's
`includeFiles` must cover `content/**` **and** `public/index.html` (the `/post`
template); check a `/post/<slug>` URL on a preview deployment after touching it.

### Environment variables

See `.env.example`. All are optional; the app runs without any of them.
- `ALLOWED_ORIGINS` — CORS whitelist (e.g. `https://your-blog.vercel.app`)
- `SITE_URL` — absolute origin for `og:url` / `canonical` / sitemap (no trailing slash). Unset falls back to the request host, which on a preview deployment puts the preview domain into `canonical` — set it for production
- `GITHUB_URL`, `LINKEDIN_URL` — header social icons; unset renders them as disabled
