// Builds main.js, then runs every offline harness and the randomized oracle.
// Usage: npm test            (after npm install)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const main = path.join(root, 'main.js');
const off = path.join(here, 'offline');
const run = (args, cwd = off) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });

const build = run(['build.mjs'], root);
if (build.status !== 0) { console.error(build.stdout + build.stderr); process.exit(1); }

let failed = 0;
for (const h of ['S-3.0.0', 'M-3.0.0', 'V-2.8.0', 'F1-2.8.0', 'F2-2.8.0', 'F4-2.8.0']) {
  const r = run([h + '-harness.js', main]);
  const last = (r.stdout || '').trim().split('\n').pop();
  const ok = r.status === 0 && !/FAILED/.test(last);
  if (!ok) { failed++; console.log((r.stdout || '').split('\n').filter((l) => l.startsWith('FAIL')).join('\n') + (r.stderr || '')); }
  console.log((ok ? 'pass ' : 'FAIL ') + h + '  ' + last);
}
for (const seed of [1, 2]) {
  const r = run(['F4-oracle-2.5.0.js', main, 'main-2.2.0.js', '2500', String(seed)]);
  const line = (r.stdout || '').split('\n').filter((l) => /mismatch/i.test(l)).pop() || (r.stderr || 'no result');
  const ok = r.status === 0 && /\b0 mismatches/.test(line);
  if (!ok) failed++;
  console.log((ok ? 'pass ' : 'FAIL ') + 'oracle seed ' + seed + '  ' + line.slice(0, 80));
}
process.exit(failed ? 1 : 0);
