// tests/run-tests.mjs — lance toutes les suites d'intégration et résume.
//
// Rangement :
//   tests/                suites generales — fenetres, i18n, extensions, relai…
//   tests/import/         lecture des fichiers de parties : PGN, KIF, PJN, JSON
//   tests/fixtures/       les fichiers eux-memes, par provenance
//     pychess/            exports de pychess.org, quatorze variantes
//     kif/                kifu japonais : shogidb2, lishogi, ChuShogiLite
//     chushogilite/       PGN et PJN de l'applet de chu shogi
//     jocly/              parties ecrites par Tabulon lui-meme
//     problems/           problemes d'exemple, par jeu (voir l'ecran « Charger »)
// Usage : npm test   (ou : node tests/run-tests.mjs)
//
// Prérequis : dist/ de jocly2 copié à la racine (voir README) et jsdom
// installé dans app/ (npm --prefix app install).
import { spawnSync } from 'child_process';
import { readdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root     = path.dirname(testsDir);

for (const [p, msg] of [
    [path.join(root, 'dist/node/jocly.core.js'), 'dist/ manquant — copier le build de jocly2 (voir README, section "Building Jocly")'],
    [path.join(root, 'app/node_modules/jsdom'),  'jsdom manquant — lancer : npm --prefix app install'],
]) if (!existsSync(p)) { console.error('✗ ' + msg); process.exit(1); }

// Les suites sont regroupees par theme : « import/ » pour la lecture des
// fichiers de parties, la racine pour le reste. La recherche est donc
// RECURSIVE -- ajouter un dossier ne demande rien d'autre que d'y deposer un
// fichier « test-*.mjs ».
//
// `fixtures/` est ecarte : il ne contient que des donnees, et une partie
// enregistree ne s'execute pas.
function findSuites(dir, prefix) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
        if (entry.isDirectory()) {
            if (entry.name === 'fixtures' || entry.name === 'node_modules') continue;
            found.push(...findSuites(path.join(dir, entry.name), prefix + entry.name + '/'));
        } else if (/^test-.*\.mjs$/.test(entry.name)) {
            found.push(prefix + entry.name);
        }
    }
    return found;
}
const suites = findSuites(testsDir, '');
let failed = 0;
console.log(`Lancement de ${suites.length} suites…\n`);
for (const suite of suites) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(testsDir, suite)], { encoding: 'utf-8' });
    const ok = r.status === 0;
    const last = (r.stdout || '').trim().split('\n').pop() || '';
    console.log(`${ok ? '✓' : '✗'} ${suite}  (${Date.now() - t0} ms)  ${last}`);
    if (!ok) {
        failed++;
        console.log((r.stdout || '').split('\n').filter(l => l.includes('✗')).join('\n'));
        console.log((r.stderr || '').split('\n').slice(-8).join('\n'));
    }
}
console.log(failed ? `\n${failed}/${suites.length} suite(s) en échec` : '\nToutes les suites passent.');
process.exit(failed ? 1 : 0);
