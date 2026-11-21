// 글 주소(/post/<slug>)용 HTML. public/index.html 을 템플릿으로 써서 <head> 만 글에 맞게 바꾼다.
// 메신저 미리보기 봇은 JS 를 실행하지 않으므로, 글별 title·description·og 태그는 서버가 넣어야 보인다.
import fs from 'fs/promises';
import path from 'path';
import { makeExcerpt } from './posts.js';

const TEMPLATE_PATH = path.join(process.cwd(), 'public', 'index.html');
const SITE_NAME = 'LimJhyeok';

// 템플릿의 사이트 기본값 중 글마다 달라지는 태그. 남겨두면 같은 property 가 두 번 나가고,
// 어느 쪽을 쓰는지는 봇마다 다르다. (prettier 가 여러 줄로 감싸므로 [\s\S]*? 로 맞춘다)
const OVERRIDDEN_META =
  /[ \t]*<meta\s+(?:name|property)="(?:description|og:type|og:title|og:description)"[\s\S]*?\/>\n?/g;

// </head> 앞의 들여쓰기까지 잡아야 새로 넣은 태그의 들여쓰기가 맞는다
const HEAD_END = /\s*<\/head>/;

// URL 의 slug ↔ 파일명 id. 주소에는 .md 를 노출하지 않는다.
export const slugToId = slug => `${slug}.md`;
export const idToSlug = id => id.replace(/\.md$/, '');

export function readTemplate() {
  return fs.readFile(TEMPLATE_PATH, 'utf-8');
}

// 속성값과 텍스트 양쪽에 쓴다. 제목에 " 하나만 있어도 태그가 깨진다.
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function injectHead(template, title, tags) {
  return template
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace(OVERRIDDEN_META, '')
    .replace(HEAD_END, `\n${tags.map(t => `    ${t}`).join('\n')}\n  </head>`);
}

const metaTag = (attr, key, value) =>
  `<meta ${attr}="${key}" content="${escapeHtml(value)}" />`;

export function renderPostPage(template, { meta, content, slug, siteUrl }) {
  const url = `${siteUrl}/post/${encodeURIComponent(slug)}`;
  // summary 의 \$ 는 본문 렌더링용 이스케이프라 미리보기에는 $ 로 보여야 한다
  const description = (meta.summary || makeExcerpt(content)).replace(/\\\$/g, '$');
  const title = meta.title || SITE_NAME;

  const tags = [
    metaTag('name', 'description', description),
    `<link rel="canonical" href="${escapeHtml(url)}" />`,
    metaTag('property', 'og:type', 'article'),
    metaTag('property', 'og:title', title),
    metaTag('property', 'og:description', description),
    metaTag('property', 'og:url', url),
    ...(meta.date ? [metaTag('property', 'article:published_time', meta.date)] : []),
    ...(meta.tags || []).map(tag => metaTag('property', 'article:tag', tag)),
  ];

  return injectHead(template, `${title} - ${SITE_NAME}`, tags);
}

// 없는 글: 클라이언트가 목록으로 되돌리지만, 봇이 이 주소를 색인하지 않도록 noindex 를 단다.
export function renderNotFoundPage(template) {
  return template.replace(HEAD_END, `\n    <meta name="robots" content="noindex" />\n  </head>`);
}

// 글 고유 주소 목록. 목록 화면들은 해시 주소라 크롤러에게는 / 하나로 보이므로 / 만 넣는다.
export function renderSitemap(posts, siteUrl) {
  const urls = [
    { loc: `${siteUrl}/` },
    ...posts.map(p => ({
      loc: `${siteUrl}/post/${encodeURIComponent(idToSlug(p.id))}`,
      lastmod: p.date,
    })),
  ];
  const entries = urls.map(({ loc, lastmod }) =>
    `  <url><loc>${escapeHtml(loc)}</loc>${lastmod ? `<lastmod>${escapeHtml(lastmod)}</lastmod>` : ''}</url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</urlset>
`;
}

// Sitemap 은 절대 URL 이어야 해서 정적 파일이 아니라 요청마다 만든다
export function renderRobots(siteUrl) {
  return `User-agent: *
Allow: /

Sitemap: ${siteUrl}/sitemap.xml
`;
}
