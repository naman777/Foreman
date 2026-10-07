// Copies node/shared/types.ts into every package that needs it.
//   node scripts/sync-shared-types.mjs          write the copies
//   node scripts/sync-shared-types.mjs --check  fail if any copy is stale (used in CI)
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = await readFile(`${root}node/shared/types.ts`, 'utf8');
const targets = ['node/coordinator/src/shared.ts', 'node/worker/src/shared.ts', 'dashboard/src/lib/shared.ts'];
const banner = '// GENERATED from node/shared/types.ts by scripts/sync-shared-types.mjs. Do not edit.\n';
const expected = banner + source.replace(/\r\n/g, '\n');
const check = process.argv.includes('--check');
let stale = 0;

for (const target of targets) {
  const current = await readFile(root + target, 'utf8').catch(() => null);
  if (current?.replace(/\r\n/g, '\n') === expected) continue;
  if (check) { console.error(`stale: ${target}`); stale += 1; }
  else { await writeFile(root + target, expected); console.log(`wrote ${target}`); }
}
if (stale) {
  console.error('Run: node scripts/sync-shared-types.mjs');
  process.exitCode = 1;
}
