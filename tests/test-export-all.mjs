// test-export-all.mjs — export général (scripts/export-all.mjs).
//
// Teste le plan (groupement par module + tri alphabétique des titres), les
// briques HTML pures (échappement, tailles) et un export complet réel sur
// dist-minimal/ — toujours présent dans le dépôt, donc la suite tourne même
// sans dist/ complet. Les archives produites sont celles de
// make-extension.mjs, déjà couvertes par test-extensions.mjs : ici on vérifie
// l'orchestration et les pages du catalogue.
//
// Usage : node tests/test-export-all.mjs
import { existsSync, readFileSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import {
  planExport, escapeHtml, formatSize,
  buildModulesIndexHtml, buildGamesIndexHtml, buildRootIndexHtml, exportAll,
} from '../scripts/export-all.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist-minimal');
const out = path.join('/tmp', 'tabulon-export-all-tests');
rmSync(out, { recursive: true, force: true });

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
  console.log('  ✓ ' + msg); passed++;
}

// ── 1. Plan : groupement et tris ─────────────────────────────────────────────
const plan = planExport({
  zeta:  { title: 'Zeta',        module: 'm2' },
  alpha: { title: 'alpha game',  module: 'm1' },
  beta:  { title: 'Beta',        module: 'm2' },
  gamma: { title: 'Beta',        module: 'm2' },   // même titre → départage par nom
});
assert(plan.modules.join(',') === 'm1,m2', 'modules triés alphabétiquement');
assert(plan.groups[1].games.map(g => g.name).join(',') === 'beta,gamma,zeta',
  'jeux triés par titre (insensible à la casse), départagés par nom');
assert(plan.groups[0].games[0].summary === '', 'summary absent → chaîne vide');

// ── 2. Briques HTML pures ────────────────────────────────────────────────────
assert(escapeHtml(`<a b="c&'d">`) === '&lt;a b=&quot;c&amp;&#39;d&quot;&gt;', 'escapeHtml : 5 caractères');
assert(formatSize(512) === '512 o' && formatSize(2048) === '2.0 Ko'
  && formatSize(3 * 1024 * 1024) === '3.0 Mo', 'formatSize : o / Ko / Mo');
const mh = buildModulesIndexHtml([{ module: 'a&b', gamesCount: 2, size: 1, file: 'a&b.tabulon-ext' }], '2026-01-01');
assert(mh.includes('a&amp;b') && !mh.includes('<script'), 'page modules : échappée, sans script');
assert(mh.includes('href="a&amp;b.tabulon-ext" download'), 'page modules : lien de téléchargement');

// ── 3. Export complet réel sur dist-minimal ──────────────────────────────────
const r = exportAll(dist, out);
assert(r.failures.length === 0, `export dist-minimal sans échec (${r.moduleRows.length} modules, ${r.gameCount} jeux)`);
assert(r.moduleRows.length > 0 && r.gameCount >= r.moduleRows.length,
  'au moins un module et autant de jeux que de modules');
for (const p of ['index.html', 'modules/index.html', 'games/index.html'])
  assert(existsSync(path.join(out, p)), `présent : ${p}`);
assert(r.moduleRows.every(m => existsSync(path.join(out, 'modules', m.file))),
  'toutes les archives de modules présentes');
assert(r.groups.every(g => g.games.every(x => existsSync(path.join(out, 'games', x.file)))),
  'toutes les archives de jeux présentes');
assert(!existsSync(path.join(out, 'games')) ||
  !readFileSync(path.join(out, 'games', 'index.html'), 'utf-8').includes('-staging'),
  'aucun résidu de staging dans la sortie');

// Les pages listent bien tout, dans l'ordre du plan.
const modulesHtml = readFileSync(path.join(out, 'modules', 'index.html'), 'utf-8');
const gamesHtml = readFileSync(path.join(out, 'games', 'index.html'), 'utf-8');
assert(r.moduleRows.every(m => modulesHtml.includes(`href="${m.file}"`)),
  'modules/index.html : un lien par module');
let pos = -1, ordered = true;
for (const g of r.groups) {
  const p = gamesHtml.indexOf(`<h2 id="${g.module}">`);
  if (p <= pos) ordered = false;
  pos = p;
}
assert(ordered, 'games/index.html : sections de modules dans l\u2019ordre alphabétique');
assert(r.groups.every(g => g.games.every(x => gamesHtml.includes(`href="${x.file}"`))),
  'games/index.html : un lien par jeu');
const first = r.groups.find(g => g.games.length > 1);
if (first) {
  const [a, b] = first.games;
  assert(gamesHtml.indexOf(escapeHtml(a.file)) < gamesHtml.indexOf(escapeHtml(b.file)),
    `games/index.html : ordre alphabétique dans ${first.module} (${a.name} avant ${b.name})`);
}
const rootHtml = readFileSync(path.join(out, 'index.html'), 'utf-8');
assert(rootHtml.includes('href="modules/"') && rootHtml.includes('href="games/"'),
  'index.html racine : liens vers modules/ et games/');
assert(buildRootIndexHtml(1, 2).includes('1 extensions de modules'), 'accueil : compteurs');

rmSync(out, { recursive: true, force: true });
console.log(`test-export-all : ${passed} assertions OK`);
