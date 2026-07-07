// scripts/check-dist.mjs — garde-fou de build.
//
// L'app embarque un dist MINIMAL (dist-minimal/, généré depuis un dist/ complet
// par make-minimal-dist.mjs) : le moteur + quelques jeux, pour qu'elle marche
// seule. La ludothèque complète s'ajoute via un dist/ externe posé à côté de
// l'exécutable (voir README « Externalized dist »).
//
// Régénère dist-minimal/ si dist/ complet est présent et plus récent ; échoue
// seulement s'il n'y a NI dist-minimal/ NI dist/ pour le construire.
import { existsSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const full = path.join(root, 'dist', 'browser', 'jocly.js');
const mini = path.join(root, 'dist-minimal', 'browser', 'jocly.js');

if (existsSync(full) && (!existsSync(mini) || statSync(full).mtimeMs > statSync(mini).mtimeMs)) {
  console.log('• Régénération de dist-minimal/ depuis dist/ …');
  execFileSync(process.execPath, [path.join(root, 'scripts', 'make-minimal-dist.mjs')], { stdio: 'inherit' });
}

if (existsSync(mini)) {
  console.log('✓ dist-minimal/ présent — build possible (jeux complets via dist/ externe au runtime).');
  process.exit(0);
}

console.error(`
✗ Aucun dist à embarquer (ni dist-minimal/ ni dist/ pour le générer).

  Obtenir un dist/ complet (voir README, « Building Jocly ») :
    git clone https://github.com/fhoudebert/jocly2.git
    cd jocly2 && npm install && npm run build
    puis copier jocly2/dist/ à la racine de ce dépôt (tabulon/dist/)

  dist-minimal/ (embarqué) sera généré automatiquement au prochain build. La
  ludothèque complète s'ajoute ensuite en posant un dist/ complet à côté de
  l'exécutable — aucun rebuild nécessaire.
`);
process.exit(1);
