import fs from 'fs/promises';
import path from 'path';
import { parseFrontmatter } from './frontmatter.js';

const POSTS_DIR = path.join(process.cwd(), 'content/posts');
const EXCERPT_LENGTH = 160;

function makeExcerpt(content) {
  const plain = content
    .replace(/```[\s\S]*?```/g, '')          // fenced code blocks
    .replace(/`[^`]+`/g, '')                 // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')    // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → text
    .replace(/^#{1,6}\s+/gm, '')             // headings
    .replace(/(\*\*|__)(.*?)\1/g, '$2')      // bold
    .replace(/(\*|_)(.*?)\1/g, '$2')         // italic
    .replace(/^\s*[-*+]\s+/gm, '')           // unordered list
    .replace(/^\s*\d+\.\s+/gm, '')           // ordered list
    .replace(/\n+/g, ' ')
    .trim();

  return plain.length <= EXCERPT_LENGTH
    ? plain
    : plain.slice(0, EXCERPT_LENGTH) + '...';
}

export async function getAllPosts() {
  const files = await fs.readdir(POSTS_DIR);

  return Promise.all(
    files.filter(f => f.endsWith('.md')).map(async file => {
      const raw = await fs.readFile(path.join(POSTS_DIR, file), 'utf-8');

      const { meta, content } = parseFrontmatter(raw);

      return {
        id: file,
        title: meta.title,
        date: meta.date,
        category: meta.category,
        tags: meta.tags || [],
        excerpt: meta.summary || makeExcerpt(content),
        series: meta.series || null,
        seriesOrder: meta.series_order ?? null,
      };
    })
  );
}

export async function getPost(id) {
  const raw = await fs.readFile(path.join(POSTS_DIR, id), 'utf-8');
  return parseFrontmatter(raw);
}