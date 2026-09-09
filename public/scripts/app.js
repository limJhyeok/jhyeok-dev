// 글 데이터 저장소
let posts = [];
let currentFilter = 'all';
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

marked.use({ renderer });

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



// 글 렌더링
function renderPosts() {
  const postsList = document.getElementById('posts-list');
  
  let filtered = posts;
  if (currentFilter !== 'all') {
    filtered = posts.filter(post => post.category === currentFilter);
  }
  
  if (filtered.length === 0) {
    postsList.innerHTML = '<div class="empty-state"><p>글이 없습니다.</p></div>';
    return;
  }
  
  filtered.sort((a, b) => {
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
  
  postsList.innerHTML = filtered.map(post => `
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
  
  document.querySelectorAll('.post-item').forEach(item => {
    const postId = item.dataset.postId;
    item.addEventListener('click', () => showPostDetail(postId));
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
    const html = marked.parse(content);

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
        showPostDetail(link.dataset.seriesPost);
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
document.addEventListener('DOMContentLoaded', () => {
  document.querySelector('.back-btn').addEventListener('click', showListView);
  loadProfile();

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderPosts();
    });
  });
  
  loadPosts();
});
