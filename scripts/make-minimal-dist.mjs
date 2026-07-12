// scripts/make-minimal-dist.mjs — construit dist-minimal/ : le moteur Jocly +
// un module de jeux autonome (fourinarow, 5 jeux) + un index RÉDUIT à ces jeux.
//
// C'est ce dist minimal qui est EMBARQUÉ dans le binaire (frontendDist pointe
// sur dist-minimal/). Un dist/ COMPLET posé à côté de l'exécutable le remplace
// au runtime (voir dist_override.rs) : l'app marche seule (quelques jeux) et
// l'utilisateur ajoute la ludothèque complète sans rebuild.
//
// Le CHOIX des modules embarqués appartient à qui compile : fourinarow pour
// une app minimale, mais chessbase, checkers, ou toute sélection est possible.
// check-dist.mjs ne régénère JAMAIS un dist-minimal valide : relancer ce
// script explicitement pour changer la sélection.
//
// Prérequis : un dist/ complet à la racine (build de jocly2). Usage :
//   node scripts/make-minimal-dist.mjs [module …]
//   ex.  node scripts/make-minimal-dist.mjs chessbase checkers
//   (défaut sans argument : fourinarow — ou TABULON_MODULES="a,b" en env)
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src  = path.join(root, 'dist');
const out  = path.join(root, 'dist-minimal');
const KEEP_MODULES = process.argv.slice(2).length ? process.argv.slice(2)
  : (process.env.TABULON_MODULES || 'fourinarow').split(',').map(s => s.trim()).filter(Boolean);

if (!existsSync(path.join(src, 'browser', 'jocly.js'))) {
  console.error('✗ dist/ complet absent — construire jocly2 d\'abord (voir README).');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'browser', 'games'), { recursive: true });

// 1. Copier browser/ SAUF games/, puis seulement les modules retenus
cpSync(path.join(src, 'browser'), path.join(out, 'browser'), {
  recursive: true,
  filter: (s) => {
    const rel = path.relative(path.join(src, 'browser'), s);
    if (rel === 'games' || rel.startsWith('games' + path.sep)) {
      const parts = rel.split(path.sep);
      if (parts.length === 1) return true;
      return KEEP_MODULES.includes(parts[1]);
    }
    return true;
  },
});

// 2. Réduire jocly-allgames.js aux jeux des modules gardés
const idxPath = path.join(out, 'browser', 'jocly-allgames.js');
const raw = readFileSync(idxPath, 'utf-8');
const m = raw.match(/exports\.games\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
if (!m) { console.error('✗ format inattendu de jocly-allgames.js'); process.exit(1); }
const games = (0, eval)('(' + m[1] + ')');
const kept = {};
for (const [name, g] of Object.entries(games))
  if (KEEP_MODULES.includes(g.module)) kept[name] = g;

// Garde-fous : un index vide ou des fichiers de jeu manquants produiraient une
// app embarquée qui démarre SANS ERREUR avec une liste de jeux vide (constaté
// en runtime sur une AppImage) — mieux vaut échouer ici, bruyamment, et ne pas
// laisser traîner un minimal invalide.
if (Object.keys(kept).length === 0) {
  console.error(`✗ index réduit VIDE : aucun jeu des modules [${KEEP_MODULES.join(', ')}] dans dist/browser/jocly-allgames.js — nom de module inconnu ou dist/ incomplet ?`);
  rmSync(out, { recursive: true, force: true });
  process.exit(1);
}
for (const [name, g] of Object.entries(kept)) {
  const model = path.join(out, 'browser', 'games', g.module, name + '-model.js');
  if (!existsSync(model)) {
    console.error(`✗ fichier manquant dans le minimal : ${path.relative(root, model)} — dist/ source incomplet ?`);
    rmSync(out, { recursive: true, force: true });
    process.exit(1);
  }
}
writeFileSync(idxPath, '"use strict";exports.games=' + JSON.stringify(kept) + ';\n');

console.log(`✓ dist-minimal/ créé : moteur + [${KEEP_MODULES.join(', ')}] + index réduit (${Object.keys(kept).length} jeux).`);
console.log('  Embarqué au build ; un dist/ complet à côté de l\'exe le remplace au runtime.');
