// Generate shields.io "endpoint" badge JSON files from CI artifacts:
//   node scripts/make-badges.mjs <coverage-summary.json | -> <size-limit.json | -> <outDir>
// Missing inputs produce an honest "unknown" badge so the docs site always builds.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [coveragePath, sizePath, outDir = 'badges'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

function badge(label, message, color) {
  return JSON.stringify({ schemaVersion: 1, label, message, color }, null, 2);
}

let coverage = badge('coverage', 'unknown', 'lightgrey');
if (coveragePath && coveragePath !== '-' && existsSync(coveragePath)) {
  const pct = JSON.parse(readFileSync(coveragePath, 'utf8')).total.lines.pct;
  const color = pct >= 90 ? 'brightgreen' : pct >= 80 ? 'green' : pct >= 70 ? 'yellow' : 'red';
  coverage = badge('coverage', `${pct.toFixed(1)}%`, color);
}
writeFileSync(join(outDir, 'coverage.json'), coverage);

let size = badge('core size', 'unknown', 'lightgrey');
if (sizePath && sizePath !== '-' && existsSync(sizePath)) {
  const entries = JSON.parse(readFileSync(sizePath, 'utf8'));
  const core = entries.find((e) => /core/i.test(e.name)) ?? entries[0];
  if (core) {
    const kb = (core.size / 1024).toFixed(1);
    size = badge('core size', `${kb} kB min+brotli`, core.passed === false ? 'red' : 'brightgreen');
  }
}
writeFileSync(join(outDir, 'size.json'), size);
console.log(`badges written to ${outDir}/ (coverage, size)`);
