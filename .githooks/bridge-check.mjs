// pre-commit's bridge check, run from stacks/postiz/ghost-bridge/ with no settings (so the bridge starts nothing):
// every module loads (an import of a name another module doesn't export only shows when Node loads it), and the
// map (MAP: docs/bridge-map.md) is current: every module has its "### `<path>`" heading, every file the map names
// exists, every name on its "- Exports:" lines is still exported. Prints "pre-commit: ..." lines and exits 1 if not.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// the bridge: .mjs files here and one folder down (share/, pages/, stats/), never data/
const files = [];
for (const e of readdirSync('.', { withFileTypes: true })) {
  if (e.isFile() && e.name.endsWith('.mjs')) files.push(e.name);
  if (e.isDirectory() && e.name !== 'data') {
    for (const f of readdirSync(e.name)) if (f.endsWith('.mjs')) files.push(`${e.name}/${f}`);
  }
}
files.sort();

const exported = {};
for (const f of files) {
  const mod = await import(pathToFileURL(path.resolve(f)).href).catch((e) => {
    console.error(`pre-commit: bridge ${f}: ${e.message}`);
    process.exit(1);
  });
  exported[f] = Object.keys(mod);
}

let map;
try { map = readFileSync(process.env.MAP, 'utf8'); } catch {
  console.error('pre-commit: bridge-map.md: missing (docs/bridge-map.md)');
  process.exit(1);
}
const listed = {};
let cur = null;
for (const line of map.split('\n')) {
  const h = line.match(/^### `([^`]+\.mjs)`/);
  if (h) { cur = h[1]; listed[cur] = []; continue; }
  if (/^#{1,3} /.test(line)) { cur = null; continue; }
  const x = cur && line.match(/^- Exports: (.*)/);
  if (x) listed[cur].push(...[...x[1].matchAll(/`([\w$]+)`/g)].map((m) => m[1]));
}
const bad = [];
for (const f of files) if (!listed[f]) bad.push(`${f} has no "### \`${f}\`" heading`);
for (const [f, names] of Object.entries(listed)) {
  if (!exported[f]) { bad.push(`names ${f}, which isn't a bridge module`); continue; }
  for (const n of names) if (!exported[f].includes(n)) bad.push(`${f} no longer exports ${n}`);
}
for (const b of bad) console.error(`pre-commit: bridge-map.md: ${b}`);
process.exit(bad.length ? 1 : 0);
