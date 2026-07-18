// test-minimal-dist.mjs — garde le pipeline du dist EMBARQUÉ.
//
// Politique : le CONTENU de dist-minimal/ appartient à la personne qui compile
// (fourinarow par défaut, ou toute sélection de modules via
// make-minimal-dist.mjs). check-dist.mjs ne modifie JAMAIS un minimal valide ;
// il ne génère que si absent/invalide. Contexte : une AppImage a été livrée
// avec un index embarqué VIDE — app démarrant sans erreur avec 0 jeu.
//
// Usage : node tests/test-minimal-dist.mjs   (dist/ complet requis à la racine)
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, utimesSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const node = process.execPath;
const makeScript  = path.join(root, 'scripts', 'make-minimal-dist.mjs');
const checkScript = path.join(root, 'scripts', 'check-dist.mjs');
const idxPath = path.join(root, 'dist-minimal', 'browser', 'jocly-allgames.js');

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
  console.log('  ✓ ' + msg); passed++;
}
function lireIndex() {
  const m = readFileSync(idxPath, 'utf-8').match(/exports\.games\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  return (0, eval)('(' + m[1] + ')');
}
function run(script, args = []) {
  return execFileSync(node, [script, ...args], { stdio: 'pipe' });
}
function runFails(script, args = []) {
  try { execFileSync(node, [script, ...args], { stdio: 'pipe' }); return false; }
  catch { return true; }
}

// ── 1. Génération par défaut (fourinarow) : moteur complet + index cohérent ──
run(makeScript);
for (const f of ['jocly.js', 'jocly.core.js', 'jocly.game.js', 'jocly-allgames.js',
                 'jocly.aiworker.js', 'jocly.embed.html']) {
  assert(existsSync(path.join(root, 'dist-minimal', 'browser', f)),
    `défaut : moteur embarqué browser/${f} présent`);
}
const defGames = lireIndex();
assert(Object.keys(defGames).length > 0, `défaut : index NON VIDE (${Object.keys(defGames).length} jeux)`);
assert(Object.values(defGames).every(g => g.module === 'fourinarow'), 'défaut : modules = fourinarow');

// ── 2. Sélection du compilateur : modules passés en argument ─────────────────
run(makeScript, ['checkers']);
const customGames = lireIndex();
assert(Object.keys(customGames).length > 0 &&
       Object.values(customGames).every(g => g.module === 'checkers'),
  `sélection personnalisée (checkers) : index réduit à ce module (${Object.keys(customGames).length} jeux)`);
assert(existsSync(path.join(root, 'dist-minimal', 'browser', 'games', 'checkers')),
  'sélection personnalisée : fichiers du module copiés');

// ── 3. check-dist NE MODIFIE PAS un minimal valide fourni ────────────────────
// Même avec un dist/ PLUS RÉCENT (l'ancienne règle mtime aurait régénéré en
// fourinarow et écrasé le choix du compilateur).
const avant = readFileSync(idxPath, 'utf-8');
const now = new Date();
utimesSync(path.join(root, 'dist', 'browser', 'jocly.js'), now, now);
run(checkScript);
assert(readFileSync(idxPath, 'utf-8') === avant,
  'check-dist : minimal personnalisé (checkers) NON modifié, même avec dist/ plus récent');

// ── 4. check-dist régénère un minimal INVALIDE (index vide) ─────────────────
writeFileSync(idxPath, '"use strict";exports.games={};\n');
run(checkScript);
assert(Object.keys(lireIndex()).length > 0,
  'check-dist : minimal à index VIDE détecté et régénéré (cause de l\'AppImage à 0 jeu)');

// ── 5. make-minimal échoue bruyamment sur une sélection vide ─────────────────
assert(runFails(makeScript, ['module-inexistant']),
  'make-minimal : échec explicite si la sélection ne garde aucun jeu');
assert(!existsSync(path.join(root, 'dist-minimal', 'browser', 'jocly.js')),
  'make-minimal : pas de minimal invalide laissé sur disque après échec');

// ── Remise en l'état par défaut pour les autres suites/le build ──────────────
run(makeScript);
run(checkScript);
assert(Object.keys(lireIndex()).length > 0, 'état final : minimal par défaut valide restauré');

console.log(`\n${passed} assertions OK — pipeline dist embarqué (sélection du compilateur respectée) validé.`);
