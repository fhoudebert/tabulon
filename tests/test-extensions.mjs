// test-extensions.mjs — logique des extensions (.tabulon-ext).
//
// Teste le miroir Node (scripts/make-extension.mjs) de la logique Rust
// (commands/extension_cmds.rs) : collecte STRICTEMENT déclarée par la config,
// exclusion des ressources partagées du module, réécriture d'index, archive,
// et un cycle import/désinstallation simulé sur un dist externe factice.
// Le Rust lui-même n'est pas exécutable ici (pas de cargo) — réserve runtime.
//
// Usage : node tests/test-extensions.mjs   (dist/ complet requis à la racine)
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import {
  collectGameFiles, buildExtension, buildManifest,
  collectModuleGames, listModuleFiles, buildModuleExtension,
  readIndex, addToIndex, removeFromIndex, isSafeRelPath, isSafeName,
} from '../scripts/make-extension.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const tmp = path.join('/tmp', 'tabulon-ext-tests');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
  console.log('  ✓ ' + msg); passed++;
}

// ── 1. Collecte seireigi : exactement le déclaré ─────────────────────────────
const c = collectGameFiles(dist, 'seireigi');
assert(c.module === 'chessbase', 'seireigi : module chessbase (variante shogi du module chessbase)');
const expected = [
  'seireigi-config.js', 'seireigi-model.js', 'seireigi-view.js',
  'res/rules/shogi/seireigi-rules.html', 'res/rules/shogi/seireigi-rules_fr.html',
  'res/rules/shogi/seireigi-credits.html', 'res/rules/shogi/seireigi-description.html',
  'res/rules/shogi/seireigi-thumb.png',
  'res/visuals/seireigi-600x600-3d.jpg', 'res/visuals/seireigi-600x600-2d.jpg',
];
assert(c.files.length === expected.length &&
       expected.every(f => c.files.includes(f)),
  `collecte = STRICTEMENT le déclaré (${expected.length} fichiers : code, rules en+fr, credits, description, thumbnail, visuals)`);
assert(!c.files.some(f => f.includes('sprites') || f.includes('diffusemaps') || f.includes('graphs/')),
  'exclusions : sprites, diffusemaps, graphs (ressources PARTAGÉES du module)');
assert(!c.files.some(f => f.includes('chu-seireigi')),
  'exclusions : aucun fichier de la variante chu-seireigi (pas de glob par nom)');
assert(c.missing.length === 0, 'aucun fichier déclaré manquant dans le dist source');

// ── 2. Gardes noms/chemins ───────────────────────────────────────────────────
assert(isSafeName('3dchess') && isSafeName('chu-seireigi') && !isSafeName('../x') && !isSafeName(''),
  'noms de jeu sûrs (alphanum + tirets), traversée refusée');
assert(isSafeRelPath('res/rules/x.html') && !isSafeRelPath('../evil') &&
       !isSafeRelPath('/abs') && !isSafeRelPath('a/../b') && !isSafeRelPath('a\\b'),
  'chemins relatifs sûrs (pas de .., d\'absolu, ni d\'antislash)');

// ── 3. Index : aller-retour ajout/suppression, format loader-compatible ─────
const idxCopy = path.join(tmp, 'jocly-allgames.js');
cpSync(path.join(dist, 'browser', 'jocly-allgames.js'), idxCopy);
const before = Object.keys(readIndex(idxCopy)).length;
addToIndex(idxCopy, 'test-game', { title: 'Test', summary: 's', thumbnail: 't.png', module: 'chessbase' });
assert(existsSync(idxCopy + '.bak'), 'index : sauvegarde .bak créée avant réécriture');
let games = readIndex(idxCopy);
assert(Object.keys(games).length === before + 1 && games['test-game'].title === 'Test',
  'index : entrée ajoutée, les autres préservées (réécriture JSON strict relisible)');
assert(readFileSync(idxCopy, 'utf-8').startsWith('"use strict";exports.games='),
  'index : format loader-compatible (littéral JS valide)');
removeFromIndex(idxCopy, 'test-game');
assert(Object.keys(readIndex(idxCopy)).length === before, 'index : entrée retirée proprement');

// ── 4. Archive .tabulon-ext : manifeste + fichiers aux chemins du dist ───────
const built = buildExtension(dist, 'seireigi', tmp);
const listing = execFileSync('unzip', ['-Z1', built.out], { encoding: 'utf-8' }).trim().split('\n');
assert(listing.includes('extension.json'), 'archive : manifeste extension.json présent');
assert(expected.every(f => listing.includes(`games/chessbase/${f}`)),
  'archive : tous les fichiers collectés, sous games/<module>/');
const manifest = JSON.parse(
  execFileSync('unzip', ['-p', built.out, 'extension.json'], { encoding: 'utf-8' }));
assert(manifest.formatVersion === 2 && manifest.type === 'game' && manifest.game === 'seireigi' &&
       manifest.module === 'chessbase' && manifest.declaration.title === 'Seireigi' &&
       Array.isArray(manifest.files) && manifest.files.length === expected.length,
  'manifeste jeu : v2 type game (v1 sans type reste accepté à l\'import), déclaration, liste de fichiers');

// ── 5. Cycle import/désinstallation simulé sur un dist externe factice ──────
// Dist cible : module chessbase présent (ressources partagées) mais SANS
// seireigi ; l'import = extraction bornée au manifeste + entrée d'index ;
// la désinstallation retire les fichiers du jeu mais préserve ceux encore
// déclarés par un autre jeu du module.
const target = path.join(tmp, 'dist-cible');
mkdirSync(path.join(target, 'browser', 'games', 'chessbase'), { recursive: true });
cpSync(path.join(dist, 'browser', 'games', 'chessbase', 'chessbase.css'),
       path.join(target, 'browser', 'games', 'chessbase', 'chessbase.css'));
// classic-chess installé (pour le test de préservation croisée)
const cc = collectGameFiles(dist, 'classic-chess');
for (const f of cc.files) {
  const dst = path.join(target, 'browser', 'games', 'chessbase', f);
  mkdirSync(path.dirname(dst), { recursive: true });
  cpSync(path.join(dist, 'browser', 'games', 'chessbase', f), dst);
}
const idx = path.join(target, 'browser', 'jocly-allgames.js');
writeFileSync(idx, '"use strict";exports.games={};\n');   // index vierge du dist cible
addToIndex(idx, 'classic-chess', readIndex(path.join(dist, 'browser', 'jocly-allgames.js'))['classic-chess']);

// import (simulation du Rust : extraction des fichiers du manifeste + index)
execFileSync('unzip', ['-o', '-q', built.out, '-d', path.join(target, 'browser')]);
rmSync(path.join(target, 'browser', 'extension.json'));
addToIndex(idx, manifest.game, manifest.declaration);
games = readIndex(idx);
assert('seireigi' in games && 'classic-chess' in games,
  'import simulé : seireigi ajouté à l\'index du dist cible, classic-chess préservé');
assert(existsSync(path.join(target, 'browser', 'games', 'chessbase', 'seireigi-model.js')),
  'import simulé : fichiers extraits sous games/chessbase/');

// désinstallation (simulation du Rust : fichiers du jeu, préservation croisée)
const sr = collectGameFiles(target, 'seireigi');
const keptElsewhere = new Set(collectGameFiles(target, 'classic-chess').files);
for (const f of sr.files) {
  if (!keptElsewhere.has(f)) rmSync(path.join(target, 'browser', 'games', 'chessbase', f), { force: true });
}
removeFromIndex(idx, 'seireigi');
assert(!('seireigi' in readIndex(idx)), 'désinstallation simulée : entrée d\'index retirée');
assert(!existsSync(path.join(target, 'browser', 'games', 'chessbase', 'seireigi-model.js')),
  'désinstallation simulée : fichiers du jeu supprimés');
assert(existsSync(path.join(target, 'browser', 'games', 'chessbase', 'classic-chess-model.js')) &&
       existsSync(path.join(target, 'browser', 'games', 'chessbase', 'chessbase.css')),
  'désinstallation simulée : autre jeu et ressources partagées du module INTACTS');

// ── 6. Extensions de MODULE (manifeste v2, fusion, socle intact) ─────────────
{
  // Fabrication depuis le dist complet : mêmes fichiers qu'un build gulp
  // mono-module (vérifié à l'analyse), tout le module-spécifique sous
  // games/<module>/.
  const mext = buildModuleExtension(dist, 'margo', tmp);
  const mGames = Object.keys(mext.games);
  assert(mGames.length === 7 && mGames.includes('shibumi-spline') && mGames.includes('margo5'),
    'module margo : 7 jeux dans le manifeste (dont shibumi-* — un module ≠ ses seuls jeux éponymes)');
  const mlist = execFileSync('unzip', ['-Z1', mext.out], { encoding: 'utf-8' }).trim().split('\n');
  assert(mlist.filter(e => !e.endsWith('/')).length === mext.files.length + 1 &&
         mlist.filter(e => !e.endsWith('/') && e !== 'extension.json')
              .every(e => e.startsWith('games/margo/')),
    `module margo : ${mext.files.length} fichiers, TOUS sous le préfixe games/margo/`);
  assert(!mlist.some(e => e.includes('scan/') || e.includes('fairy-stockfish') || e.startsWith('res/')),
    'module : le socle (scan/ — moteur des dames lié à checkers mais maintenu au niveau jocly —, fairy-stockfish, res/ racine) n\'est JAMAIS embarqué');
  const mmanifest = JSON.parse(execFileSync('unzip', ['-p', mext.out, 'extension.json'], { encoding: 'utf-8' }));
  assert(mmanifest.formatVersion === 2 && mmanifest.type === 'module' && !mmanifest.files,
    'manifeste module : v2, type module, pas de liste files (extraction bornée par PRÉFIXE à l\'import)');

  // Import par FUSION sur un dist cible SANS le module (aucune exigence
  // « module présent » : le module est la charge utile), avec un jeu ajouté
  // individuellement qui doit survivre à une ré-importation du module.
  const target2 = path.join(tmp, 'dist-cible-module');
  mkdirSync(path.join(target2, 'browser', 'games'), { recursive: true });
  const idx2 = path.join(target2, 'browser', 'jocly-allgames.js');
  writeFileSync(idx2, '"use strict";exports.games={};\n');
  execFileSync('unzip', ['-o', '-q', mext.out, '-d', path.join(target2, 'browser'), 'games/*']);
  for (const [n, d] of Object.entries(mmanifest.games)) addToIndex(idx2, n, d);
  assert(Object.keys(readIndex(idx2)).length === 7 &&
         existsSync(path.join(target2, 'browser', 'games', 'margo', 'margo5-model.js')),
    'import module simulé : 7 jeux à l\'index, fichiers sous games/margo/, sans précondition de module');
  // jeu « ajouté individuellement » : fichier étranger dans le dossier du module
  writeFileSync(path.join(target2, 'browser', 'games', 'margo', 'jeu-perso-model.js'), '// perso');
  execFileSync('unzip', ['-o', '-q', mext.out, '-d', path.join(target2, 'browser'), 'games/*']);
  assert(existsSync(path.join(target2, 'browser', 'games', 'margo', 'jeu-perso-model.js')),
    'ré-import module = FUSION : un jeu ajouté individuellement dans le module survit');

  // Désinstallation module : dossier entier + entrées d'index, socle intact.
  mkdirSync(path.join(target2, 'browser', 'res'), { recursive: true });
  writeFileSync(path.join(target2, 'browser', 'res', 'socle.txt'), 'socle');
  rmSync(path.join(target2, 'browser', 'games', 'margo'), { recursive: true });
  for (const n of Object.keys(mmanifest.games)) removeFromIndex(idx2, n);
  assert(Object.keys(readIndex(idx2)).length === 0 &&
         !existsSync(path.join(target2, 'browser', 'games', 'margo')) &&
         existsSync(path.join(target2, 'browser', 'res', 'socle.txt')),
    'désinstallation module simulée : dossier et entrées d\'index retirés, socle intact');

  // collectModuleGames refuse un module inconnu
  let threw = false;
  try { collectModuleGames(dist, 'module-inexistant'); } catch { threw = true; }
  assert(threw, 'collectModuleGames : erreur explicite pour un module inconnu');
  assert(listModuleFiles(dist, 'margo').length === mext.files.length,
    'listModuleFiles : parcours récursif cohérent avec l\'archive');
}

// ── 7. Les clés i18n de l'écran existent en fr ET en ─────────────────────────
const i18n = readFileSync(path.join(root, 'app', 'content', 'tabulon-i18n.js'), 'utf-8');
const html = readFileSync(path.join(root, 'app', 'content', 'extensions.html'), 'utf-8');
const keys = [...html.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)].map(m => m[1]);
assert(keys.length > 0 && keys.every(k => (i18n.split(/'fr'/)[0].includes(`'${k}'`) &&
                                           i18n.split(/'fr':\s*\{/)[1]?.includes(`'${k}'`) !== false)),
  `i18n : les ${keys.length} clés data-i18n de extensions.html existent dans le dictionnaire`);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} assertions OK — extensions (.tabulon-ext) validées.`);
