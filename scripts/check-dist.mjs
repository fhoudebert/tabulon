// scripts/check-dist.mjs — garde-fou de build/dev.
//
// `dist/` (le build de jocly2 : browser/jocly.js + games/**) n'est PAS
// versionné : sur un clone frais, `tauri build` embarquerait une application
// SANS moteur de jeu — symptôme : liste vide et "ReferenceError: Jocly is
// not defined" au premier lancement (vécu sur un build Windows).
// Ce script fait échouer le build tôt, avec la marche à suivre.
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const missing = [
  ['dist/browser/jocly.js',   'moteur Jocly'],
  ['dist/browser/games',      'ressources des 125 jeux'],
  ['dist/browser/jocly-allgames.js', 'index des jeux'],
].filter(([p]) => !existsSync(path.join(root, p)));

if (missing.length) {
  console.error('\n✗ dist/ absent ou incomplet — le build produirait une application sans jeux.');
  for (const [p, what] of missing) console.error(`    manquant : ${p}  (${what})`);
  console.error(`
  Pour obtenir dist/ (voir README, section "Building Jocly") :
    git clone https://github.com/fhoudebert/jocly2.git
    cd jocly2 && npm install && npm run build
    puis copier jocly2/dist/ à la racine de ce dépôt (tabulon/dist/)
`);
  process.exit(1);
}
console.log('✓ dist/ présent (jocly.js + games) — build possible.');
