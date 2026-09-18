// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { REPO_URL, resolveBase, resolveSite } from './scripts/site-config.mjs';

const base = resolveBase();

export default defineConfig({
  site: resolveSite(),
  base: base || '/',
  vite: {
    // Astro's prerender bundle imports `cookie` (an Astro dependency, not ours). Bundle it so the
    // build never depends on what a bare `cookie` import resolves to from dist/: with pnpm's strict
    // layout it is not in docs-site/node_modules, and a stray CommonJS `cookie` higher up the
    // filesystem would otherwise break the build. Same reasoning as Astro's own `neotraverse`
    // entry in ALWAYS_NOEXTERNAL (withastro/astro#17508). Vite 8 reads this per environment.
    environments: {
      ssr: { resolve: { noExternal: ['cookie'] } },
      prerender: { resolve: { noExternal: ['cookie'] } },
    },
  },
  integrations: [
    starlight({
      title: 'watukuy',
      description: "Webhooks for APIs that don't have them.",
      social: [{ icon: 'github', label: 'GitHub', href: REPO_URL }],
      customCss: ['./src/styles/custom.css'],
      components: { Head: './src/components/Head.astro' },
      // Every page carries its own `editUrl` (set by scripts/sync-docs.mjs) pointing at the
      // Markdown source in docs/, so no editLink.baseUrl is needed here.
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Introduction', slug: 'index' },
            { label: 'Quickstart', slug: 'quickstart' },
            { label: 'Examples', slug: 'examples' },
            { label: 'Guarantees', slug: 'guarantees' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'How it works', slug: 'how-it-works' },
            { label: 'Cursors', slug: 'cursors' },
            { label: 'Delivery', slug: 'delivery' },
            { label: 'Multi-tenant', slug: 'multi-tenant' },
          ],
        },
        {
          label: 'Run it',
          items: [
            { label: 'Stores', slug: 'stores' },
            { label: 'Serverless', slug: 'serverless' },
            { label: 'NestJS', slug: 'nestjs' },
            { label: 'Observability', slug: 'observability' },
            { label: 'HTTP helper', slug: 'http-helper' },
            { label: 'CLI', slug: 'cli' },
          ],
        },
        {
          label: 'Operate',
          items: [
            { label: 'Runbook', slug: 'runbook' },
            { label: 'Recipes', slug: 'recipes' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'API', slug: 'api' },
            { label: 'Comparison', slug: 'comparison' },
            { label: 'FAQ', slug: 'faq' },
            { label: 'Stability', slug: 'stability' },
            { label: 'Roadmap', slug: 'roadmap' },
          ],
        },
      ],
    }),
  ],
});
