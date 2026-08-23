// app/content/text-search.js
//
// Normalisation des textes pour la RECHERCHE : « echecs » doit trouver
// « échecs », « kotaishi » doit trouver « Kōtaishi ».
//
// Module PUR — aucun DOM, aucun Tauri — donc testable directement sous Node,
// comme localized-field.js ou css-url-rewrite.js.
//
// Ce qui est replié, et pourquoi ces choix-là :
//
//  - LES DIACRITIQUES, par décomposition Unicode (NFD) puis retrait des
//    marques combinantes. C'est ce qui règle « é » → « e » et « ō » → « o »
//    sans table à tenir : le catalogue porte aujourd'hui « Shō Shogi », et la
//    prochaine translittération japonaise arrivera avec ses propres macrons.
//
//  - LES LETTRES QUI NE SE DÉCOMPOSENT PAS. « ø », « œ », « ß », « ł » n'ont
//    pas de forme décomposée : NFD les laisse tels quels et il faut une table.
//    Elle est courte à dessein — les cas rencontrés dans des noms de jeux
//    européens — et non une romanisation générale, qui serait un autre métier.
//
//  - LA PONCTUATION TYPOGRAPHIQUE, repliée sur l'ASCII. Ce n'est pas de la
//    cosmétique : le catalogue écrit « 9 Men´s Morris » avec un accent aigu
//    U+00B4 en guise d'apostrophe, et il y en a six. Taper « men's morris »
//    au clavier ne les trouvait donc pas, et rien à l'écran ne laissait
//    deviner pourquoi.
//
// Ce qui n'est PAS fait : replier les espaces, ni ignorer les traits d'union à
// l'intérieur d'un mot. « mini-shogi » et « mini shogi » restent deux chaînes
// différentes ; c'est une recherche par sous-chaîne, pas un moteur de
// recherche, et lui prêter plus d'intelligence qu'elle n'en a rendrait ses
// résultats plus difficiles à prévoir.

// Lettres sans décomposition NFD. Minuscules seulement : le repli est appliqué
// après toLowerCase().
const LETTERS = {
    'ø': 'o', 'œ': 'oe', 'æ': 'ae', 'ß': 'ss',
    'ł': 'l', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ŋ': 'n', 'ı': 'i',
};

// Ponctuation : tout ce qui tient lieu d'apostrophe ou de tiret.
const PUNCT = {
    '\u00b4': "'", '\u2018': "'", '\u2019': "'", '\u02bc': "'", '\u0060': "'",
    '\u201c': '"', '\u201d': '"',
    '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2212': '-',
};

/**
 * Forme comparable d'un texte : minuscules, sans diacritiques, ponctuation
 * ramenée à l'ASCII.
 *
 * Tolère null, undefined et les non-chaînes — le catalogue passe parfois un
 * champ absent, et une recherche n'est pas un endroit où lever une exception.
 */
export function Normalize(text) {
    if (text === null || text === undefined) return '';
    let s = String(text).toLowerCase();
    // NFD sépare la lettre de son accent ; \u0300-\u036f est le bloc des
    // marques combinantes que cette séparation produit.
    if (typeof s.normalize === 'function') s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return s.replace(/[^\x00-\x7f]|[`]/g, (c) => LETTERS[c] || PUNCT[c] || c);
}

/**
 * `needle` figure-t-il dans `haystack`, aux accents et à la ponctuation près ?
 *
 * Une aiguille vide correspond à tout : c'est le champ de recherche vidé, qui
 * doit tout réafficher et non tout masquer.
 */
export function Matches(haystack, needle) {
    const n = Normalize(needle);
    return n === '' || Normalize(haystack).includes(n);
}
