import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { getAllPosts, getPost } from './lib/posts.js';
import { readTemplate, renderPostPage, renderNotFoundPage, slugToId, idToSlug } from './lib/page.js';

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean); // 빈값 제거

app.use(cors({
  origin: (origin, callback) => {
    // same-origin / server-to-server 허용
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Not allowed by CORS'));
  }
}));

app.use(express.json());

// npm run dev 전용: 파일 저장 시 브라우저 자동 새로고침
const liveReload = process.argv.includes('--live-reload')
  ? (await import('./lib/live-reload.js')).attachLiveReload(app)
  : null;

// stale-while-revalidate는 브라우저 캐시에도 적용돼, 개발 중엔 수정한 글 대신 이전 응답이 먼저 뜬다.
const cacheControl = value => (liveReload ? 'no-store' : value);

// og:url · canonical 은 절대 URL 이어야 한다. SITE_URL 이 없으면 요청 host 로 만든다
// (Vercel 은 프록시 뒤라 req.protocol 이 http 로 보이므로 x-forwarded-proto 를 먼저 본다).
function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, '');
  const proto = req.get('x-forwarded-proto')?.split(',')[0] || req.protocol;
  return `${proto}://${req.get('host')}`;
}

// posting된 글 불러오기
app.get('/api/posts', async (_, res) => {
  res.set('Cache-Control', cacheControl('public, s-maxage=60, stale-while-revalidate=300'));
  res.json(await getAllPosts());
});

app.get('/api/posts/:id', async (req, res) => {
  const post = await getPost(req.params.id);
  // 파일명을 바꾸면 옛 주소가 404 가 된다. 그 404 를 edge 에 캐시하면 같은 이름으로 되돌려도 한동안 안 보인다.
  if (!post) return res.set('Cache-Control', 'no-store').status(404).json({ error: 'Post not found' });
  res.set('Cache-Control', cacheControl('public, s-maxage=300, stale-while-revalidate=600'));
  res.json(post);
});

// ============ Profile ============
app.get('/api/profile', (_, res) => {
  res.json({
    github:   process.env.GITHUB_URL   || null,
    linkedin: process.env.LINKEDIN_URL || null,
  });
});

// ============ Health Check ============
app.get('/api/health', (_, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============ Post Page ============
// 글 고유 주소. 본문은 클라이언트가 그리고, 서버는 미리보기·검색용 <head> 만 글에 맞춘다.
app.get('/post/:slug', async (req, res) => {
  const { slug } = req.params;
  // 파일명 그대로(.md)의 주소는 정식 주소로 보낸다
  if (slug.endsWith('.md')) return res.redirect(301, `/post/${encodeURIComponent(idToSlug(slug))}`);

  const [template, post] = await Promise.all([readTemplate(), getPost(slugToId(slug))]);
  let html;
  if (post) {
    res.set('Cache-Control', cacheControl('public, s-maxage=300, stale-while-revalidate=600'));
    html = renderPostPage(template, { ...post, slug, siteUrl: siteUrl(req) });
  } else {
    // /api/posts/:id 와 같은 이유로 404 는 edge 에 캐시하지 않는다
    res.set('Cache-Control', 'no-store').status(404);
    html = renderNotFoundPage(template);
  }
  res.type('html').send(liveReload ? liveReload.injectClient(html) : html);
});

// ============ Static Files (Fallback) ============
app.use(express.static('public'));

// SPA Fallback
app.get('*', (req, res) => {
  if (liveReload) return liveReload.sendIndex(req, res);
  res.sendFile('public/index.html', { root: '.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
