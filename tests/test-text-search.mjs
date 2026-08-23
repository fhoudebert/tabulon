// tests/test-text-search.mjs — normalisation des filtres de recherche.
//
// « echecs » doit trouver « Échecs », « kotaishi » doit trouver « Kōtaishi ».
// Le filtre comparait auparavant deux `toLowerCase()`, ce qui laissait passer
// la casse et rien d'autre : un titre accentué était introuvable au clavier,
// et rien à l'écran ne disait pourquoi la liste restait vide.
//
// Les cas ci-dessous ne sont pas inventés : ils viennent du catalogue jocly,
// qui contient sept titres non-ASCII — un macron japonais et six apostrophes
// écrites avec un accent aigu.
//
// Usage : npm test  (ou node tests/test-text-search.mjs)
import { Normalize, Matches } from '../app/content/text-search.js';

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };

console.log('Diacritiques');
{
    ok(Matches('Échecs', 'echecs'), '« echecs » trouve « Échecs »');
    ok(Matches('echecs', 'Échecs'), 'et réciproquement : les deux côtés sont normalisés');
    ok(Matches('Échecs', 'ECHECS'), 'la casse ne compte pas non plus');

    // Le cas du catalogue : kotaishi-shogi s'intitule « Shō Shogi ».
    ok(Matches('Shō Shogi', 'sho shogi'), '« sho » trouve « Shō » (macron japonais)');
    ok(Matches('Kōtaishi Shōgi', 'kotaishi'), 'et « kotaishi » trouve « Kōtaishi »');

    ok(Normalize('àéîõüç') === 'aeiouc', 'les accents latins courants tombent');
    ok(Normalize('ǎǧḥṇṣ') === 'aghns', 'y compris ceux des translittérations');
}

console.log('Lettres sans forme décomposée');
{
    // NFD ne sépare rien sur celles-ci : sans table, elles resteraient telles
    // quelles et « oeuf » ne trouverait pas « Œuf ».
    ok(Normalize('Œuf') === 'oeuf', 'œ → oe');
    ok(Normalize('Blåbær') === 'blabaer', 'æ → ae');
    ok(Normalize('Straße') === 'strasse', 'ß → ss');
    ok(Normalize('Ørn') === 'orn', 'ø → o');
    ok(Normalize('Łódź') === 'lodz', 'ł → l, avec ses accents');
}

console.log('Ponctuation typographique');
{
    // Six jeux du catalogue s'appellent « 9 Men´s Morris » — l'apostrophe est
    // un accent aigu U+00B4. Aucun clavier ne le produit spontanément, donc
    // aucune recherche naturelle ne les trouvait.
    ok(Matches('9 Men\u00b4s Morris', "men's morris"),
       'l\'apostrophe tapée trouve l\'accent aigu du catalogue');
    ok(Matches('9 Men\u2019s Morris', "men's"), 'et l\'apostrophe courbe aussi');
    ok(Matches("9 Men's Morris", 'men\u00b4s'), 'dans les deux sens');
    ok(Normalize('a\u2014b') === 'a-b' && Normalize('a\u2013b') === 'a-b',
       'cadratins et demi-cadratins deviennent des traits d\'union');
}

console.log('Ce qui n\'est délibérément PAS replié');
{
    // Recherche par sous-chaîne, pas moteur de recherche : lui prêter plus
    // d'intelligence qu'elle n'en a rendrait ses résultats imprévisibles.
    ok(!Matches('mini-shogi', 'mini shogi'),
       'le trait d\'union n\'est pas assimilé à une espace');
    ok(Matches('mini-shogi', 'shogi') && Matches('mini-shogi', 'mini-'),
       'mais toute sous-chaîne réelle correspond');
}

console.log('Robustesse');
{
    ok(Matches('quoi que ce soit', ''), 'une recherche vide montre tout, elle ne masque pas tout');
    ok(Matches('x', '   ') === false || Matches('x', '   ') === true,
       'une recherche d\'espaces ne lève pas d\'exception');
    ok(Normalize(null) === '' && Normalize(undefined) === '',
       'null et undefined donnent la chaîne vide');
    ok(Normalize(42) === '42', 'un nombre est accepté');
    ok(Matches(null, 'a') === false, 'un champ absent ne correspond à rien');
    ok(Normalize('déjà') === Normalize('de\u0301ja\u0300'),
       'précomposé et décomposé donnent le même résultat');
}

console.log('');
console.log(`RESULTAT text-search: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
