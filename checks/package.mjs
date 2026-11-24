// Packaging check (Stage A): run the kit's main.ts twice into two output
// dirs and compare the dossier hash + the whole output tree hash.
// Usage: node checks/package.mjs
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outA = join(repo, 'out-a');
const outB = join(repo, 'out-b');

function treeHash(dir) {
  const h = createHash('sha256');
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const r = rel ? rel + '/' + name : name;
      const st = statSync(p);
      if (st.isDirectory()) walk(p, r);
      else {
        h.update(r + '\n');
        h.update(readFileSync(p));
      }
    }
  };
  walk(dir, '');
  return h.digest('hex');
}

for (const out of [outA, outB]) {
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  const r = spawnSync('node', ['main.ts'], {
    cwd: repo,
    env: { ...process.env, MAKEFUN_OUTPUT_DIR: out },
    encoding: 'utf-8',
  });
  if (r.status !== 0) {
    console.log('packaging run failed for ' + out);
    console.log(r.stdout);
    console.log(r.stderr);
    process.exit(1);
  }
}
const dossierA = readFileSync(join(outA, 'dossier.json'));
const dossierB = readFileSync(join(outB, 'dossier.json'));
const hashA = createHash('sha256').update(dossierA).digest('hex');
const hashB = createHash('sha256').update(dossierB).digest('hex');
const treeA = treeHash(outA);
const treeB = treeHash(outB);
console.log(`dossier A: ${dossierA.length} bytes sha256 ${hashA.slice(0, 16)}…`);
console.log(`dossier B: ${dossierB.length} bytes sha256 ${hashB.slice(0, 16)}…`);
console.log(`tree A: ${treeA.slice(0, 16)}…  tree B: ${treeB.slice(0, 16)}…`);
rmSync(outA, { recursive: true, force: true });
rmSync(outB, { recursive: true, force: true });
if (hashA !== hashB || treeA !== treeB) {
  console.log('PACKAGE: FAIL — runs differ');
  process.exit(1);
}
console.log('PACKAGE: 2x byte-identical');
