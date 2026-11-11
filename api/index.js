import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { getAllPosts, getPost } from './lib/posts.js';

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
const sendDevIndex = process.argv.includes('--live-reload')
  ? (await import('./lib/live-reload.js')).attachLiveReload(app)
  : null;

// posting된 글 불러오기
app.get('/api/posts', async (_, res) => {
  res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  res.json(await getAllPosts());
});

app.get('/api/posts/:id', async (req, res) => {
  res.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  res.json(await getPost(req.params.id));
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

// ============ Static Files (Fallback) ============
app.use(express.static('public'));

// SPA Fallback
app.get('*', (req, res) => {
  if (sendDevIndex) return sendDevIndex(req, res);
  res.sendFile('public/index.html', { root: '.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
