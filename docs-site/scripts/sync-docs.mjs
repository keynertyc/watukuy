#!/usr/bin/env node
/**
 * Build-time copy of the repository's Markdown into Starlight's content collection.
 *
 * Sources (read-only): ../docs/*.md, ../README.md, ../ROADMAP.md, ../examples/README.md.
 * Output: src/content/docs/<slug>.md with Starlight frontmatter (title, description, editUrl),
 * the H1 removed (Starlight renders the title), relative links rewritten to site routes (or to
 * GitHub for files that are not part of the site), and ```mermaid fences turned into
 * <pre class="mermaid"> blocks that src/scripts/mermaid-client.ts renders in the browser.
 *
 * Runs via `predev` / `prebuild`. Honors DOCS_BASE exactly like astro.config.mjs does.
 */

import { statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_URL, resolveBase } from './site-config.mjs';

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(siteDir, '..');
const outDir = path.join(siteDir, 'src', 'content', 'docs');
const base = resolveBase();

const DESCRIPTION_MAX = 160;

/**
 * Canonical routes: repo-relative source file → page slug. Links between docs resolve through
 * this map. `index` is the site root.
 */
const routes = new Map([
  ['README.md', 'index'],
  ['ROADMAP.md', 'roadmap'],
  ['examples/README.md', 'examples'],
]);

/**
 * Pages that are not a 1:1 copy of a docs/ file. `body` receives the source body (H1 removed)
 * and returns the page body; links inside may be written in source form (relative to `source`)
 * because rewriting happens afterwards.
 */
const derivedPages = [
  {
    slug: 'index',
    source: 'README.md',
    title: 'Introduction',
    body: readmeToIntroduction,
  },
  {
    slug: 'quickstart',
    source: 'README.md',
    title: 'Quickstart',
    description:
      'Install watukuy, declare your first poller, and get a typed stream of created, updated, and deleted events in about thirty lines.',
    body: readmeToQuickstart,
  },
  {
    slug: 'cli',
    source: 'docs/runbook.md',
    title: 'CLI',
    description:
      'The watukuy command line: inspect, tick, run, trigger, pause, resume, backfill, replay, reset-cursor, parked, and migrate against a config module that exports the engine.',
    body: runbookToCli,
  },
  { slug: 'examples', source: 'examples/README.md', title: 'Examples' },
  { slug: 'roadmap', source: 'ROADMAP.md' },
];

/** Where the automatic title/description extraction reads poorly. */
const overrides = {
  api: { title: 'API reference' },
  examples: {
    description:
      'Runnable demos, no credentials required: legacy ERP polling, a NestJS app, a Cloudflare Worker tick, multi-tenant partitions, signed webhooks, and a BullMQ sink.',
  },
  stability: {
    description:
      'Semver policy, what counts as public API, supported runtimes, the deprecation policy, the release process, and how to report security issues.',
  },
  faq: {
    description:
      'Frequently asked questions: duplicates, missing deletes, undefined data, slow handlers, multiple instances, shared rate limits, runtimes, and testing.',
  },
};

async function main() {
  const docFiles = (await readdir(path.join(repoDir, 'docs')))
    .filter((file) => file.endsWith('.md'))
    .sort();
  for (const file of docFiles) routes.set(`docs/${file}`, file.slice(0, -3));

  const pages = [
    ...derivedPages,
    ...docFiles.map((file) => ({ slug: file.slice(0, -3), source: `docs/${file}` })),
  ];

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const sources = new Map();
  const read = async (rel) => {
    if (!sources.has(rel)) sources.set(rel, readFile(path.join(repoDir, rel), 'utf8'));
    return sources.get(rel);
  };

  for (const page of pages) {
    const raw = await read(page.source);
    const { title: h1, body } = splitTitle(raw, page.source);
    let content = page.body ? page.body(body) : body;
    content = rewriteLinks(content, page.source);
    content = convertMermaid(content);
    content = content.trim();

    const override = overrides[page.slug] ?? {};
    const title = page.title ?? override.title ?? plainText(h1);
    const description = page.description ?? override.description ?? extractDescription(content);
    const editUrl = `${REPO_URL}/edit/main/${page.source}`;

    const frontmatter = [
      '---',
      `title: ${yaml(title)}`,
      `description: ${yaml(description)}`,
      `editUrl: ${yaml(editUrl)}`,
      '---',
    ].join('\n');

    await writeFile(path.join(outDir, `${page.slug}.md`), `${frontmatter}\n\n${content}\n`);
  }

  console.log(
    `[sync-docs] wrote ${pages.length} pages to ${path.relative(siteDir, outDir)} (base: "${base || '/'}")`,
  );
}

// --- page transforms -------------------------------------------------------------------------

/** README minus the badge lines; the H1 is already gone. */
function readmeToIntroduction(body) {
  return body
    .split('\n')
    .filter((line) => !line.startsWith('[!['))
    .join('\n');
}

/** Install + quickstart + testing sections of the README, in the order a newcomer needs them. */
function readmeToQuickstart(body) {
  const sections = splitSections(body);
  const pick = (heading) => {
    const section = sections.get(heading);
    if (section === undefined) throw new Error(`README.md: section "## ${heading}" not found`);
    return section.trim();
  };
  return [
    '## Install',
    pick('Install and requirements'),
    '## Define a poller and start the engine',
    pick('Quickstart'),
    '## Test it without a network',
    pick('Testing your pollers'),
    '## Next steps',
    [
      '- [How it works](./docs/how-it-works.md): the poll cycle, the commit protocol, kill points, lanes.',
      '- [Cursor strategies](./docs/cursors.md): which strategy fits your API and the timestamp pitfalls.',
      '- [Delivery](./docs/delivery.md): ordering keys, retries, parking, and dedup at the consumer.',
      '- [Stores](./docs/stores.md): SQLite for one node, Postgres for many, Redis for shared budgets.',
      '- [Serverless](./docs/serverless.md): `tick()` from Cloudflare Workers, Lambda, Vercel, or a CronJob.',
      '- [Examples](./examples/README.md): runnable demos, no credentials required.',
    ].join('\n'),
  ].join('\n\n');
}

/** The CLI section of the runbook as its own page. */
function runbookToCli(body) {
  const section = splitSections(body).get('CLI');
  if (section === undefined) throw new Error('docs/runbook.md: section "## CLI" not found');
  const withoutRelated = section.replace(/\n+Related:[^\n]*\s*$/, '');
  return `${withoutRelated.trim()}\n\nRelated: [runbook.md](./runbook.md), [api.md](./api.md#watukuycli), [stores.md](./stores.md#migrations).`;
}

// --- markdown helpers ------------------------------------------------------------------------

/** Split off the first H1. Everything after it is the body. */
function splitTitle(markdown, sourcePath) {
  const lines = markdown.split('\n');
  const index = lines.findIndex((line) => /^# \S/.test(line));
  if (index === -1) throw new Error(`${sourcePath}: no H1 found`);
  return { title: lines[index].slice(2).trim(), body: lines.slice(index + 1).join('\n') };
}

/** Map of `## heading` text → section body (until the next H2), ignoring fenced code. */
function splitSections(body) {
  const sections = new Map();
  let current = null;
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = !inFence && line.match(/^## (.+)$/);
    if (heading) {
      current = heading[1].trim();
      sections.set(current, '');
    } else if (current !== null) {
      sections.set(current, `${sections.get(current)}${line}\n`);
    }
  }
  return sections;
}

/** Rewrite relative Markdown links to site routes, or to GitHub for files outside the site. */
function rewriteLinks(markdown, sourcePath) {
  const sourceDir = path.posix.dirname(sourcePath);
  const linkPattern = /(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g;
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(
        linkPattern,
        (_match, text, url) => `[${text}](${rewriteUrl(url, sourceDir)})`,
      );
    })
    .join('\n');
}

function rewriteUrl(url, sourceDir) {
  if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(url)) return url; // absolute, anchor, or already a route
  const hashIndex = url.indexOf('#');
  const filePart = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : url.slice(hashIndex);
  const resolved = path.posix.normalize(path.posix.join(sourceDir, filePart)).replace(/^\.\//, '');

  const slug = routes.get(resolved);
  if (slug !== undefined) return slug === 'index' ? `${base}/${hash}` : `${base}/${slug}/${hash}`;

  const repoPath = resolved.replace(/\/$/, '');
  const isDirectory = isRepoDirectory(repoPath, filePart.endsWith('/'));
  return `${REPO_URL}/${isDirectory ? 'tree' : 'blob'}/main/${repoPath}${hash}`;
}

/** Whether a repo-relative path is a directory (checked on disk; `fallback` when it does not exist). */
function isRepoDirectory(repoPath, fallback) {
  try {
    return statSync(path.join(repoDir, repoPath)).isDirectory();
  } catch {
    return fallback;
  }
}

/** ```mermaid fences → <pre class="mermaid"> so Expressive Code leaves them alone. */
function convertMermaid(markdown) {
  return markdown.replace(
    /^```mermaid[^\n]*\n([\s\S]*?)\n```[ \t]*$/gm,
    (_match, code) => `<pre class="mermaid">\n${escapeHtml(code)}\n</pre>`,
  );
}

/** First prose paragraph (or leading blockquote), as plain text, trimmed to a sentence boundary. */
function extractDescription(markdown) {
  const collected = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const trimmed = line.trim();
    if (trimmed === '') {
      if (collected.length > 0) break;
      continue;
    }
    const isBlockquote = trimmed.startsWith('>');
    const skip =
      !isBlockquote &&
      (/^(#{1,6}\s|\||[-*+]\s|\d+\.\s|<|\[!\[)/.test(trimmed) ||
        /^\[[^\]]*\]\([^)]*\)$/.test(trimmed));
    if (skip) {
      if (collected.length > 0) break;
      continue;
    }
    collected.push(isBlockquote ? trimmed.replace(/^>\s?/, '') : trimmed);
  }
  return truncate(plainText(collected.join(' ')), DESCRIPTION_MAX);
}

function plainText(markdown) {
  return markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*]+)\*(?=\s|[.,;:]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, max) {
  if (text.length <= max) return text;
  const window = text.slice(0, max);
  const sentenceEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('.\n'));
  if (sentenceEnd > max / 3) return window.slice(0, sentenceEnd + 1);
  const wordEnd = window.lastIndexOf(' ');
  return `${window.slice(0, wordEnd > 0 ? wordEnd : max - 1).trimEnd()}…`;
}

function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** YAML double-quoted scalar (JSON strings are valid YAML). */
function yaml(value) {
  return JSON.stringify(value);
}

main().catch((error) => {
  console.error('[sync-docs] failed:', error);
  process.exitCode = 1;
});
