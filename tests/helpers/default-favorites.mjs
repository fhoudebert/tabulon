// Les favoris par défaut du hub (defaultFavorites, app/content/hub.js) que
// connaît le dist de jocly2 chargé : InitGames() retire les autres sans bruit
// (jeu obsolète, ou absent de la branche de jocly2 utilisée). Les tests de la
// page d'accueil comparent à ce nombre plutôt qu'à une constante, qui changeait
// à chaque jeu ajouté ou retiré de jocly2.
import { readFileSync } from 'fs';

export function defaultFavoriteNames() {
  const src = readFileSync(new URL('../../app/content/hub.js', import.meta.url), 'utf-8');
  const body = /const defaultFavorites = \{([\s\S]*?)\};/.exec(src);
  if (!body) throw new Error('defaultFavorites introuvable dans hub.js');
  const code = body[1].replace(/\/\/.*$/gm, '');
  return [...code.matchAll(/'([^']+)'\s*:/g)].map((m) => m[1]);
}

export function expectedFavorites(catalog) {
  return defaultFavoriteNames().filter((name) => name in catalog);
}
