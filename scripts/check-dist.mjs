// scripts/check-dist.mjs — garde-fou de build.
//
// L'app embarque un dist MINIMAL (dist-minimal/ : le moteur + une sélection de
// modules de jeux, générée depuis un dist/ complet par make-minimal-dist.mjs).
// La ludothèque complète s'ajoute via un dist/ externe posé à côté de
// l'exécutable (voir README « Externalized dist »).
//
// Le CONTENU de dist-minimal/ appartient à qui compile (fourinarow par défaut,
// mais chessbase, checkers ou toute sélection via make-minimal-dist.mjs) :
// ce script ne MODIFIE JAMAIS un dist-minimal valide. Il ne génère (défaut)
// que s'il est absent ou invalide (index vide, moteur manquant), et échoue
// s'il n'y a ni minimal valide ni dist/ pour en construire un.
import { existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const full = path.join(root, 'dist', 'browser', 'jocly.js');
const mini = path.join(root, 'dist-minimal', 'browser', 'jocly.js');

// Un dist-minimal est VALIDE s'il contient le moteur ET un index non vide.
// (Un minimal invalide embarqué = app qui démarre sans erreur avec 0 jeu,
// constaté en runtime sur une AppImage.) AUCUNE règle de date : un minimal
// valide fourni par la personne qui compile est respecté tel quel, même si
// dist/ est plus récent.
function lireNbJeux() {
  const idx = path.join(root, 'dist-minimal', 'browser', 'jocly-allgames.js');
  const core = path.join(root, 'dist-minimal', 'browser', 'jocly.core.js');
  if (!existsSync(mini) || !existsSync(idx) || !existsSync(core)) return 0;
  const m = readFileSync(idx, 'utf-8').match(/exports\.games\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!m) return 0;
  try { return Object.keys((0, eval)('(' + m[1] + ')')).length; } catch { return 0; }
}

if (lireNbJeux() === 0 && existsSync(full)) {
  console.log('• dist-minimal/ absent ou invalide : génération (défaut) depuis dist/ …');
  execFileSync(process.execPath, [path.join(root, 'scripts', 'make-minimal-dist.mjs')], { stdio: 'inherit' });
}

const n = lireNbJeux();
if (n > 0) {
  console.log(`✓ dist-minimal/ valide (${n} jeux) — non modifié, sera embarqué tel quel.`);
  console.log('  Rappel : rm -rf src-tauri/target pour que le build ré-embarque un minimal changé.');
  process.exit(0);
}

if (existsSync(mini)) {
  console.error('✗ dist-minimal/ présent mais INVALIDE (index vide ou moteur manquant) et pas de dist/ pour le régénérer.');
}
console.error(`
✗ Aucun dist valide à embarquer (ni dist-minimal/ valide ni dist/ pour le générer).

  Obtenir un dist/ complet (voir README, « Building Jocly ») :
    git clone https://github.com/fhoudebert/jocly2.git
    cd jocly2 && npm install && npm run build
    puis copier jocly2/dist/ à la racine de ce dépôt (tabulon/dist/)

  dist-minimal/ (embarqué) sera généré automatiquement au prochain build (ou
  avec votre propre sélection : node scripts/make-minimal-dist.mjs <modules…>).
  La ludothèque complète s'ajoute ensuite en posant un dist/ complet à côté de
  l'exécutable — aucun rebuild nécessaire.
`);
process.exit(1);
