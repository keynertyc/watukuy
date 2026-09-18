// Guards the published entry points: no entry may import another entry (it would drag that
// entry's optional peers into unrelated subpaths), and only `testing-store-contract` may import
// vitest. Runs after `pnpm build` (see `check:pack` and the CI package job).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const entries = Object.values(pkg.exports)
  .map((e) => (typeof e === 'object' && e.default ? e.default : null))
  .filter((p) => p && p.endsWith('.js'))
  .map((p) => p.replace(/^\.\//, ''));
const entryNames = new Set(entries.map((p) => p.replace(/^dist\//, '')));
const allowedVitest = new Set(['dist/testing-store-contract.js']);
const problems = [];
for (const entry of entries) {
  const src = readFileSync(join(process.cwd(), entry), 'utf8');
  for (const m of src.matchAll(/^(?:import|export)[^'"]*from\s*["']([^"']+)["']/gm)) {
    const spec = m[1];
    if (spec.startsWith('./') && entryNames.has(spec.slice(2))) {
      problems.push(`${entry} imports another entry point (${spec})`);
    }
    if (spec === 'vitest' && !allowedVitest.has(entry)) {
      problems.push(`${entry} imports vitest, which is only allowed in testing-store-contract`);
    }
  }
}
if (problems.length > 0) {
  console.error('entry point check failed:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`entry points ok (${entries.length} checked)`);
