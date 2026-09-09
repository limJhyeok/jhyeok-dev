export function parseFrontmatter(content) {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) return { meta: {}, content };

  const frontmatterText = match[1];
  const bodyContent = match[2];

  const meta = {};

  for (const line of frontmatterText.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;

    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();

    if (key === 'tags') {
      meta[key] = value.replace(/[[\]"]/g, '').split(',').map(t => t.trim());
    } else if (key === 'series_order') {
      meta[key] = Number(value);
    } else {
      meta[key] = value.replace(/^"(.*)"$/, '$1');
    }
  }

  return { meta, content: bodyContent };
}