// tests/test-icons.mjs — chaque icône employée est définie.
//
// LE MODE DE PANNE. Les icônes sont une police : une classe `icon-xxx` pose un
// glyphe via `content` dans tabulon.css. Une classe employée mais NON DÉFINIE
// ne produit rien du tout — pas d'erreur, pas de carré blanc, pas de trace en
// console. Le bouton s'affiche simplement sans son icône, et personne ne
// remarque un pictogramme absent sur une barre qui en compte dix.
//
// Deux cas étaient déjà là quand ce fichier a été écrit : l'entrée Affichage
// du hub demandait `icon-picture`, qui n'existe pas, et le bouton « Choisir un
// fichier… » demandait `icon-folder`, qui n'existait pas non plus.
//
// Le point de code, lui, ne se vérifie pas ici : rien ne dit qu'il désigne le
// bon dessin. Il se relève dans la cmap de app/fonts/photon-entypo.ttf, ce que
// les commentaires de icon-box et icon-folder rappellent.
//
// Usage : node tests/test-icons.mjs
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, 'app', 'content');

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };

const css = readFileSync(path.join(dir, 'tabulon.css'), 'utf-8');
const defined = new Set([...css.matchAll(/\.(icon-[a-z0-9-]+)::before/g)].map(m => m[1]));

// HTML et JS : plusieurs icônes sont posées à la construction d'une ligne
// (l'écran d'installation, la liste des jeux), pas dans le balisage.
const used = new Map();
for (const file of readdirSync(dir).filter(f => /\.(html|js)$/.test(f))) {
    const src = readFileSync(path.join(dir, file), 'utf-8');
    for (const m of src.matchAll(/\bicon-[a-z0-9-]+\b/g))
        if (!used.has(m[0])) used.set(m[0], file);
}

console.log(`${defined.size} classes définies, ${used.size} employées`);
ok(defined.size > 20, 'la feuille de style a bien été lue');
ok(used.size > 20, 'les pages ont bien été lues');

const missing = [...used].filter(([name]) => !defined.has(name));
ok(missing.length === 0,
   'chaque icône employée est définie'
   + (missing.length ? ' — ' + missing.map(([n, f]) => `${n} (${f})`).join(', ') : ''));

/*
 * L'écran des préférences porte un ENGRENAGE, plus un œil.
 *
 * L'œil disait « affichage », et c'était juste tant que l'écran ne réglait que
 * les visuels du hub. Il porte maintenant aussi la clé des conversations : une
 * icône qui annonce autre chose que ce qu'on trouve derrière est pire qu'une
 * icône neutre. L'œil reste, lui, sur le bouton « Options d'affichage » d'une
 * fenêtre de jeu, qui n'a pas changé de sujet.
 */
{
    const hub = readFileSync(path.join(dir, 'hub.html'), 'utf-8');
    const play = readFileSync(path.join(dir, 'play.html'), 'utf-8');
    const nav = /id="nav-display"[\s\S]{0,400}?<\/span>\s*<\/span>/.exec(hub);
    ok(!!nav && /icon-cog/.test(nav[0]),
       'l\'entrée Préférences du hub porte l\'engrenage');
    ok(!!nav && !/icon-eye/.test(nav[0]),
       'et plus l\'œil, qui ne décrivait plus que la moitié de l\'écran');
    ok(/id="button-options"[\s\S]{0,200}icon-eye/.test(play),
       'l\'œil reste sur « Options d\'affichage » d\'une fenêtre de jeu');
}

console.log('');
console.log(`RESULTAT icons: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
