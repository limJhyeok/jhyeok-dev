// 글 데이터 저장소
let posts = [];
let currentFilter = 'all';
let currentSeries = null; // 시리즈 글 목록을 보는 중이면 시리즈 이름
let currentPage = 1;
const PAGE_SIZE = 5;
const API_BASE = '/api';

// 마크다운 설정
marked.setOptions({
  breaks: true,
  gfm: true,
});

const renderer = new marked.Renderer();

let demoCounter = 0;

const originalCode = renderer.code.bind(renderer);
renderer.code = function ({ text, lang }) {
  if (lang === 'html-demo') {
    const id = `demo-${demoCounter++}`;
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const srcDoc = text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `
      <div class="demo-block" data-demo-id="${id}">
        <div class="demo-tabs">
          <button class="demo-tab active" data-target="code">Code</button>
          <button class="demo-tab" data-target="result">Result</button>
        </div>
        <div class="demo-panel demo-panel-code active">
          <pre><code class="language-html">${escaped}</code></pre>
        </div>
        <div class="demo-panel demo-panel-result">
          <iframe sandbox="allow-scripts" data-srcdoc="${srcDoc}"></iframe>
        </div>
      </div>`;
  }
  return originalCode({ text, lang });
};

// bind 를 쓰면 marked 가 주입하는 this.parser 를 잃어버려서 link 렌더링이 깨진다.
const originalLink = renderer.link;
renderer.link = function (token) {
  const html = originalLink.call(this, token);
  // 외부 링크는 새 탭으로. 각주/목차용 #앵커는 현재 탭에서 이동해야 하므로 제외
  return /^https?:\/\//i.test(token.href || '')
    ? html.replace('<a ', '<a target="_blank" rel="noopener noreferrer" ')
    : html;
};

marked.use({ renderer });

// marked 는 수식 안의 `_` 두 개를 강조(<em>)로 해석해버려서
// `\text{Intra}_{p05} - \text{Inter}_{p95}` 같은 식이 깨진다.
// 파싱 전에 수식 구간을 플레이스홀더로 빼두고, 파싱 후 원문 그대로 복원한다.
// 코드블록/인라인 코드 안의 `$` 는 수식이 아니므로 건드리지 않는다.
const CODE_OR_MATH = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|(\$\$[\s\S]+?\$\$|\$(?![\s$])(?:[^$\n]*[^\s$])?\$)/g;

function escapeMathHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseMarkdownWithMath(markdown) {
  const math = [];
  const masked = markdown.replace(CODE_OR_MATH, (matched, code, expr) =>
    code ? matched : `@@MATH${math.push(expr) - 1}@@`
  );
  return marked
    .parse(masked)
    .replace(/@@MATH(\d+)@@/g, (_, i) => escapeMathHtml(math[i]));
}

const POSTS_CACHE_KEY = 'posts_cache_v2';

function getCachedPosts() {
  try {
    const raw = localStorage.getItem(POSTS_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw).data;
  } catch {
    return null;
  }
}

function setCachedPosts(data) {
  try {
    localStorage.setItem(POSTS_CACHE_KEY, JSON.stringify({ data, ts: Date.now() }));
  } catch {
    // localStorage unavailable (e.g. private browsing) — silently skip caching
  }
}

function showSkeleton() {
  const card = `
    <div class="skeleton-card">
      <div class="skeleton-line" style="width:60%;height:1.25rem;margin-bottom:0.5rem;"></div>
      <div class="skeleton-line" style="width:25%;height:0.875rem;margin-bottom:1rem;"></div>
      <div class="skeleton-line" style="width:100%;height:0.9rem;margin-bottom:0.5rem;"></div>
      <div class="skeleton-line" style="width:80%;height:0.9rem;"></div>
    </div>`;
  document.getElementById('posts-list').innerHTML =
    '<div class="loading-spinner"></div>' + card.repeat(3);
}

async function loadPosts() {
  const cached = getCachedPosts();
  if (cached) {
    posts = cached;
    renderPosts();
  } else {
    showSkeleton();
  }

  try {
    const response = await fetch(`${API_BASE}/posts`);
    const data = await response.json();
    posts = data.map(post => ({
      id: post.id,
      title: post.title,
      date: post.date,
      category: post.category,
      tags: post.tags || [],
      excerpt: post.excerpt || '',
      series: post.series || null,
      seriesOrder: post.seriesOrder ?? null,
    }));
    setCachedPosts(posts);
    renderPosts();
  } catch (err) {
    console.error('Failed to load posts:', err);
    if (!cached) {
      document.getElementById('posts-list').innerHTML =
        '<div class="empty-state"><p>글을 불러오지 못했습니다. 잠시 후 새로고침 해주세요.</p></div>';
    }
  }
}



// ---- 해시 라우팅 ----
// #/            전체 목록 1페이지      #/2       전체 목록 2페이지
// #/dev         카테고리 목록 1페이지   #/ai/3    카테고리 목록 3페이지
// #/series      시리즈 목록            #/series/<이름>/2  시리즈 글 2페이지
// #/post/<id>   글 상세
// 그 외(본문 각주의 #appendix 같은 인-페이지 앵커)는 라우트가 아니므로 건드리지 않는다.
const POST_ROUTE_PREFIX = 'post/';
// 첫 세그먼트로 예약된 이름 — 같은 이름의 카테고리는 만들 수 없다
const SERIES_ROUTE = 'series';

function parseRoute() {
  const hash = location.hash;
  if (hash === '' || hash === '#') return { view: 'list', filter: 'all', page: 1 };
  if (!hash.startsWith('#/')) return null;

  const raw = decodeURIComponent(hash.slice(2));
  if (raw.startsWith(POST_ROUTE_PREFIX)) {
    return { view: 'post', id: raw.slice(POST_ROUTE_PREFIX.length) };
  }

  // 숫자만인 세그먼트는 페이지 번호, 아니면 카테고리 (카테고리명과 겹치지 않는다)
  const [first = '', second = '', third = ''] = raw.split('/');
  const isPageNum = seg => /^\d+$/.test(seg);

  if (first === SERIES_ROUTE) {
    // 이름이 없으면(#/series) 시리즈 목록, 있으면 그 시리즈의 글 목록
    const name = isPageNum(second) ? '' : second;
    const pageSeg = name ? third : '';
    return { view: 'series', series: name || null, page: isPageNum(pageSeg) ? Number(pageSeg) : 1 };
  }

  const filter = isPageNum(first) ? 'all' : first || 'all';
  const pageSeg = isPageNum(first) ? first : second;
  return { view: 'list', filter, page: isPageNum(pageSeg) ? Number(pageSeg) : 1 };
}

function routeToHash(route) {
  if (route.view === 'post') return `#/${POST_ROUTE_PREFIX}${encodeURIComponent(route.id)}`;

  if (route.view === 'series') {
    const name = route.series ? encodeURIComponent(route.series) : '';
    const seriesPage = (route.page ?? 1) > 1 && name ? String(route.page) : '';
    return `#/${[SERIES_ROUTE, name, seriesPage].filter(Boolean).join('/')}`;
  }

  const filter = route.filter === 'all' ? '' : encodeURIComponent(route.filter);
  const page = (route.page ?? 1) > 1 ? String(route.page) : '';
  return `#/${[filter, page].filter(Boolean).join('/')}`;
}

// 클릭은 해시만 바꾸고, 실제 렌더링은 applyRoute 한 곳에서만 한다
function navigate(route) {
  const hash = routeToHash(route);
  if (location.hash === hash) {
    applyRoute(); // 같은 해시면 hashchange 가 안 뜨므로 직접 호출
    return;
  }
  location.hash = hash;
}

let renderedHash = null;

function applyRoute() {
  const route = parseRoute();
  if (route === null) return; // 인-페이지 앵커 — 화면 전환 없음

  if (route.view === 'list') {
    currentSeries = null;
    setFilter(route.filter);
    // 범위 밖 페이지(#/dev/9 같은 링크)는 마지막 페이지로 보정한다
    currentPage = Math.min(Math.max(1, route.page), totalPages());
    route.page = currentPage;
  }

  if (route.view === 'series') {
    // 없는 시리즈를 가리키는 주소는 빈 목록 대신 시리즈 목록으로 되돌린다
    const known = route.series && posts.some(p => p.series === route.series);
    route.series = known ? route.series : null;
    currentSeries = route.series;
    setFilter(SERIES_ROUTE);
    currentPage = route.series ? Math.min(Math.max(1, route.page), totalPages()) : 1;
    route.page = currentPage;
  }

  const hash = routeToHash(route);
  // 보정된 주소를 히스토리에 새로 쌓지 않고 조용히 정정 (hashchange 도 안 뜬다).
  // 단, 해시 없는 첫 화면(/)까지 /#/ 로 바꾸지는 않는다.
  const atDefaultRoute = hash === '#/' && (location.hash === '' || location.hash === '#');
  if (hash !== location.hash && !atDefaultRoute) {
    history.replaceState(null, '', hash);
  }
  if (hash === renderedHash) return; // 각주에서 뒤로 온 경우 등 불필요한 재렌더 방지
  renderedHash = hash;

  if (route.view === 'post') {
    showPostDetail(route.id);
  } else if (route.view === 'series' && !route.series) {
    renderSeriesIndex();
    showListView();
  } else {
    renderPosts();
    showListView(); // 글 상세를 보던 중이면 목록으로 되돌려야 필터 결과가 보인다
  }
}

function filteredPosts() {
  if (currentSeries) {
    return posts
      .filter(post => post.series === currentSeries)
      .sort((a, b) => (a.seriesOrder ?? 0) - (b.seriesOrder ?? 0));
  }
  return currentFilter === 'all' ? posts : posts.filter(post => post.category === currentFilter);
}

// 목록으로 돌아가는 라우트 — 시리즈를 보던 중이면 그 시리즈로 돌아간다
function listRoute(page = currentPage) {
  return currentSeries
    ? { view: 'series', series: currentSeries, page }
    : { view: 'list', filter: currentFilter, page };
}

function totalPages() {
  return Math.max(1, Math.ceil(filteredPosts().length / PAGE_SIZE));
}

// currentFilter 상태와 버튼 active 클래스만 담당 (렌더링과 분리)
function setFilter(filter) {
  const buttons = [...document.querySelectorAll('.filter-btn')];
  const known = buttons.some(b => b.dataset.filter === filter);
  currentFilter = known ? filter : 'all';
  buttons.forEach(b => b.classList.toggle('active', b.dataset.filter === currentFilter));

  // 모바일 한 줄 헤더에서는 활성 버튼이 가로 스크롤 밖에 있을 수 있어 끌어온다
  buttons
    .find(b => b.classList.contains('active'))
    ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

// 7페이지까지는 번호를 전부, 그 이상은 1 … 4 5 6 … 10 형태로 축약
const ELLIPSIS = '…';

function pageWindow(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages = new Set([1, total, current - 1, current, current + 1]);
  // 현재 페이지가 양 끝에 붙어 있을 때도 보이는 번호 개수를 유지한다
  if (current <= 3) [2, 3, 4].forEach(n => pages.add(n));
  if (current >= total - 2) [total - 3, total - 2, total - 1].forEach(n => pages.add(n));

  const sorted = [...pages].filter(n => n >= 1 && n <= total).sort((a, b) => a - b);
  return sorted.flatMap((n, i) => (i > 0 && n - sorted[i - 1] > 1 ? [ELLIPSIS, n] : [n]));
}

// 한 페이지에 다 들어가면(글 5개 이하) 페이지 UI 자체를 그리지 않는다
function renderPagination(total) {
  const nav = document.getElementById('pagination');
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) {
    nav.innerHTML = '';
    return;
  }

  const btn = (label, page, { disabled = false, active = false } = {}) =>
    disabled
      ? `<span class="page-btn disabled" aria-hidden="true">${label}</span>`
      : `<button class="page-btn${active ? ' active' : ''}" data-page="${page}"` +
        `${active ? ' aria-current="page"' : ''}>${label}</button>`;

  nav.innerHTML =
    btn('←', currentPage - 1, { disabled: currentPage === 1 }) +
    pageWindow(currentPage, pages)
      .map(n => (n === ELLIPSIS
        ? '<span class="page-ellipsis">…</span>'
        : btn(n, n, { active: n === currentPage })))
      .join('') +
    btn('→', currentPage + 1, { disabled: currentPage === pages });

  nav.querySelectorAll('.page-btn[data-page]').forEach(el => {
    el.addEventListener('click', () => navigate(listRoute(Number(el.dataset.page))));
  });
}

// 글 렌더링
function renderPosts() {
  const postsList = document.getElementById('posts-list');
  const filtered = filteredPosts();

  if (filtered.length === 0) {
    postsList.innerHTML = '<div class="empty-state"><p>글이 없습니다.</p></div>';
    renderPagination(0);
    return;
  }
  
  // 시리즈 목록은 filteredPosts() 가 이미 편 순서로 정렬해 뒀다 — 날짜순으로 뒤집지 않는다
  if (!currentSeries) filtered.sort((a, b) => {
    const byDate = new Date(b.date) - new Date(a.date);
    if (byDate !== 0) return byDate;
    // 같은 날짜: 같은 시리즈끼리 모으고, 시리즈 안에서는 편 순서대로
    const bySeries = (a.series || '').localeCompare(b.series || '');
    if (bySeries !== 0) return bySeries;
    return (a.seriesOrder ?? 0) - (b.seriesOrder ?? 0);
  });

  // 필터와 무관하게 시리즈 전체 편수를 세어 배지에 표시
  const seriesTotals = posts.reduce((acc, p) => {
    if (p.series) acc[p.series] = (acc[p.series] || 0) + 1;
    return acc;
  }, {});
  
  const seriesHead = currentSeries ? `
    <div class="series-head">
      <button class="series-back">← 시리즈 목록</button>
      <div class="series-head-title">
        <h2 class="series-head-name">${currentSeries}</h2>
        <span class="series-head-count">${filtered.length}편</span>
      </div>
    </div>
  ` : '';

  const pageStart = (currentPage - 1) * PAGE_SIZE;
  postsList.innerHTML = seriesHead + filtered.slice(pageStart, pageStart + PAGE_SIZE).map(post => `
    <div class="post-item" data-post-id="${post.id}">
      ${post.series ? `
        <div class="post-item-series">
          <span class="series-badge-name">${post.series} 시리즈</span>
          <span class="series-badge-count">${post.seriesOrder} / ${seriesTotals[post.series]}</span>
        </div>
      ` : ''}
      <div class="post-item-header">
        <div>
          <h2 class="post-item-title">${post.title}</h2>
          <p class="post-item-date">${new Date(post.date).toLocaleDateString('ko-KR')}</p>
        </div>
        <span class="post-item-category">${post.category}</span>
      </div>
      <p class="post-item-excerpt">${post.excerpt}</p>
      ${post.tags.length > 0 ? `
        <div class="post-item-tags">
          ${post.tags.map(tag => `<span class="post-tag">#${tag}</span>`).join('')}
        </div>
      ` : ''}
    </div>
  `).join('');

  renderPagination(filtered.length);

  postsList.querySelector('.series-back')
    ?.addEventListener('click', () => navigate({ view: 'series', series: null }));

  document.querySelectorAll('.post-item').forEach(item => {
    const postId = item.dataset.postId;
    item.addEventListener('click', () => navigate({ view: 'post', id: postId }));
  });

  document.querySelectorAll('.post-item-excerpt').forEach(el => {
    renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
      ]
    });
  });
}

// 시리즈별 요약 — 편수, 1편, 가장 최근 글 (최근 글이 있는 시리즈가 위로)
function seriesSummaries() {
  const grouped = posts.reduce((acc, post) => {
    if (post.series) (acc[post.series] ||= []).push(post);
    return acc;
  }, {});

  return Object.entries(grouped)
    .map(([name, parts]) => {
      const ordered = [...parts].sort((a, b) => (a.seriesOrder ?? 0) - (b.seriesOrder ?? 0));
      const latest = parts.reduce((a, b) => (new Date(b.date) > new Date(a.date) ? b : a));
      return { name, count: parts.length, first: ordered[0], latest };
    })
    .sort((a, b) => new Date(b.latest.date) - new Date(a.latest.date));
}

// 시리즈 목록 화면 (#/series) — 카드를 누르면 그 시리즈의 글만 보여준다
function renderSeriesIndex() {
  const postsList = document.getElementById('posts-list');
  const all = seriesSummaries();

  if (all.length === 0) {
    postsList.innerHTML = '<div class="empty-state"><p>아직 시리즈가 없습니다.</p></div>';
    renderPagination(0);
    return;
  }

  postsList.innerHTML = all.map(s => `
    <div class="series-card" data-series="${s.name}">
      <div class="series-card-head">
        <h2 class="series-card-name">${s.name}</h2>
        <span class="series-card-count">${s.count}편</span>
      </div>
      <p class="series-card-excerpt">${s.first.title}</p>
      <p class="series-card-date">최신 글 ${new Date(s.latest.date).toLocaleDateString('ko-KR')}</p>
    </div>
  `).join('');

  renderPagination(0); // 시리즈 목록은 페이지를 나누지 않는다

  postsList.querySelectorAll('.series-card').forEach(card => {
    card.addEventListener('click', () => navigate({ view: 'series', series: card.dataset.series }));
  });
}

// 시리즈 목차 — posts 데이터에서 자동 생성 (현재 글 강조)
function buildSeriesToc(meta, currentId) {
  if (!meta.series) return '';

  const parts = posts
    .filter(p => p.series === meta.series)
    .sort((a, b) => (a.seriesOrder ?? 0) - (b.seriesOrder ?? 0));

  if (parts.length === 0) return '';

  const items = parts.map(p => {
    const isCurrent = p.id === currentId;
    const title = isCurrent
      ? `<span class="series-toc-title">${p.title}<span class="series-toc-here">현재 글</span></span>`
      : `<a class="series-toc-title" href="#" data-series-post="${p.id}">${p.title}</a>`;
    return `
      <li class="series-toc-item${isCurrent ? ' current' : ''}">
        <span class="series-toc-num">${p.seriesOrder}</span>
        ${title}
      </li>`;
  }).join('');

  const repo = meta.series_repo ? `
    <div class="series-toc-repo">
      원본 예제 코드:
      <a href="${meta.series_repo}" target="_blank" rel="noopener noreferrer">${meta.series_repo.replace(/^https?:\/\/(www\.)?github\.com\//, '')}</a>
    </div>` : '';

  return `
    <nav class="series-toc" aria-label="${meta.series} 시리즈 목차">
      <div class="series-toc-head">
        <span class="series-toc-name">${meta.series} 시리즈</span>
        <span class="series-toc-progress">${meta.series_order} / ${parts.length}</span>
      </div>
      <ol class="series-toc-list">${items}</ol>
      ${repo}
    </nav>`;
}

async function showPostDetail(postId) {
  try {
    // Markdown 원문 가져오기
    const res = await fetch(`${API_BASE}/posts/${postId}`);
    const { meta, content } = await res.json();

    // 목록을 거치지 않고 바로 상세로 들어온 경우에도 목차를 만들 수 있게 보강
    if (posts.length === 0) {
      try {
        const listRes = await fetch(`${API_BASE}/posts`);
        posts = await listRes.json();
      } catch {
        // 목록을 못 가져오면 목차 없이 본문만 렌더링
      }
    }
    

    const modal = document.getElementById('post-detail');
    const contentEl = document.getElementById('post-content');

    demoCounter = 0;
    const html = parseMarkdownWithMath(content);

    contentEl.innerHTML = `
      <h1>${meta.title}</h1>
      <div style="display:flex;justify-content:space-between;margin-bottom:2rem;color:#666;font-size:0.9rem;">
        <span>${new Date(meta.date).toLocaleDateString('ko-KR')} · ${meta.category}</span>
      </div>

      ${buildSeriesToc(meta, postId)}

      <div>
        ${html}
      </div>
    `;
    contentEl.querySelectorAll('.demo-block').forEach(block => {
      block.querySelectorAll('.demo-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          const target = tab.dataset.target;
          block.querySelectorAll('.demo-tab').forEach(t => t.classList.remove('active'));
          block.querySelectorAll('.demo-panel').forEach(p => p.classList.remove('active'));
          tab.classList.add('active');
          block.querySelector(`.demo-panel-${target}`).classList.add('active');

          if (target === 'result') {
            const iframe = block.querySelector('iframe[data-srcdoc]');
            if (iframe) {
              iframe.srcdoc = iframe.dataset.srcdoc;
              iframe.removeAttribute('data-srcdoc');
            }
          }
        });
      });
    });

    contentEl.querySelectorAll('[data-series-post]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        navigate({ view: 'post', id: link.dataset.seriesPost });
      });
    });

    contentEl.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el));
    renderMathInElement(contentEl, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false }
      ]
    });

    document.querySelector('.posts-section').classList.add('hidden');
    modal.classList.add('active');
    window.scrollTo(0, 0);

  } catch (err) {
    console.error('Failed to load post detail:', err);
    renderedHash = null; // 실패한 라우트를 '렌더 완료'로 남겨두면 재시도가 막힌다
  }
}

function showListView() {
  document.getElementById('post-detail').classList.remove('active');
  document.querySelector('.posts-section').classList.remove('hidden');
  window.scrollTo(0, 0);
}

async function loadProfile() {
  try {
    const res = await fetch(`${API_BASE}/profile`);
    const { github, linkedin } = await res.json();
    setupSocialIcon('github-icon', github);
    setupSocialIcon('linkedin-icon', linkedin);
  } catch {
    setupSocialIcon('github-icon', null);
    setupSocialIcon('linkedin-icon', null);
  }
}

function setupSocialIcon(id, url) {
  const btn = document.getElementById(id);
  if (url) {
    btn.addEventListener('click', () => window.open(url, '_blank', 'noopener,noreferrer'));
  } else {
    btn.classList.add('social-icon--unset');
    btn.addEventListener('click', () => showSocialTooltip(btn, '링크 미설정'));
  }
}

function showSocialTooltip(anchor, message) {
  const tooltip = document.getElementById('social-tooltip');
  const rect = anchor.getBoundingClientRect();
  tooltip.textContent = message;
  tooltip.style.left = `${rect.left + rect.width / 2}px`;
  tooltip.style.top  = `${rect.bottom + 6}px`;
  tooltip.classList.add('visible');
  clearTimeout(tooltip._timer);
  tooltip._timer = setTimeout(() => tooltip.classList.remove('visible'), 2000);
}

// 초기화
document.addEventListener('DOMContentLoaded', async () => {
  // history.back() 을 쓰면 시리즈 목차로 글 A → 글 B 를 오간 뒤에
  // '목록으로' 가 글 A 로 가버리므로, 목록 라우트를 새로 쌓는다
  document.querySelector('.back-btn')
    .addEventListener('click', () => navigate(listRoute()));
  loadProfile();

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(btn.dataset.filter === SERIES_ROUTE
        ? { view: 'series', series: null }
        : { view: 'list', filter: btn.dataset.filter });
    });
  });

  window.addEventListener('hashchange', applyRoute);

  // 새로고침/딥링크 복원 — 목록을 그리기 전에 필터부터 확정한다
  const initial = parseRoute();
  if (initial?.view === 'list') setFilter(initial.filter);
  if (initial?.view === 'series') setFilter(SERIES_ROUTE);
  await loadPosts();
  applyRoute();
});
