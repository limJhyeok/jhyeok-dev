// 로컬 개발 전용 live reload. `npm run dev`(--live-reload)일 때만 index.js가 붙인다.
// content/ · public/ 변경 → SSE로 브라우저에 알림 (CSS는 새로고침 없이 교체, 나머지는 reload).
// api/ 변경은 `node --watch-path=api`가 서버를 재시작하고, 끊겼던 SSE가 다시 붙으면 reload.
import fs from 'fs';
import path from 'path';

const WATCH_DIRS = ['content', 'public'];
const ENDPOINT = '/__live-reload';

const CLIENT_SCRIPT = `<script>
(() => {
  const KEY = '__live_reload_scroll';
  const reload = () => {
    try { sessionStorage.setItem(KEY, JSON.stringify({ hash: location.hash, y: scrollY })); } catch {}
    location.reload();
  };

  // reload 전 스크롤 위치 복원: 글은 비동기로 렌더되고 렌더 끝에 scrollTo(0,0)를 하므로
  // 페이지가 충분히 길어질 때까지 기다렸다가 복원한다.
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(KEY)); sessionStorage.removeItem(KEY); } catch {}
  if (saved && saved.hash === location.hash && saved.y > 0) {
    const started = Date.now();
    const timer = setInterval(() => {
      const isPost = location.hash.startsWith('#/post/');
      const ready = !isPost || document.getElementById('post-detail')?.classList.contains('active');
      if (ready && document.documentElement.scrollHeight >= saved.y + innerHeight) {
        clearInterval(timer);
        setTimeout(() => scrollTo(0, saved.y), 50);
      } else if (Date.now() - started > 5000) {
        clearInterval(timer);
      }
    }, 50);
  }

  let disconnected = false;
  const es = new EventSource('${ENDPOINT}');
  es.onopen = () => { if (disconnected) reload(); }; // 서버 재시작(api/ 수정) 후 재연결
  es.onerror = () => { disconnected = true; };
  es.addEventListener('reload', reload);
  es.addEventListener('css', () => {
    document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
      const url = new URL(link.href);
      if (url.origin !== location.origin) return;
      url.searchParams.set('t', Date.now());
      link.href = url.href;
    });
  });
})();
</script>`;

export function attachLiveReload(app) {
  const clients = new Set();

  app.get(ENDPOINT, (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    res.write('retry: 500\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  // 편집기는 저장 한 번에 이벤트를 여러 개 낸다 → 묶어서 한 번만 보낸다.
  let timer = null;
  let pending = new Set();
  const broadcast = () => {
    const event = [...pending].every(f => f.endsWith('.css')) ? 'css' : 'reload';
    pending = new Set();
    for (const res of clients) res.write(`event: ${event}\ndata: \n\n`);
    console.log(`[live-reload] ${event}`);
  };

  for (const dir of WATCH_DIRS) {
    fs.watch(dir, { recursive: true }, (_, filename) => {
      if (!filename || /(^|[/\\])\.|~$|\.swp$/.test(filename)) return; // 에디터 임시 파일 무시
      pending.add(filename);
      clearTimeout(timer);
      timer = setTimeout(broadcast, 100);
    });
  }

  // index.html에만 클라이언트 스크립트를 주입한다 (배포 HTML은 손대지 않음).
  const sendIndex = (_, res) => {
    const html = fs.readFileSync(path.join('public', 'index.html'), 'utf-8');
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html.replace('</body>', `${CLIENT_SCRIPT}\n</body>`));
  };
  app.get(['/', '/index.html'], sendIndex);

  console.log(`[live-reload] watching ${WATCH_DIRS.join(', ')}/ (api/ → server restart)`);
  return sendIndex;
}
