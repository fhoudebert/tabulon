// test-pgn-variant.mjs — la balise [Variant] d'un PGN exporté.
//
// CE QUI NE MARCHAIT PAS. L'export écrivait le nom Jocly — « horde-chess » là
// où un lecteur attend « horde » — donc un fichier dont les coups étaient bons
// et que personne ne pouvait ouvrir. Et pour les jeux à prélude (Timurid,
// Capablanca) il ne s'écrivait pas du tout : le jeton « #0 » n'est traduisible
// dans aucune notation, l'export le voyait comme un coup illisible et refusait
// la partie entière.
//
// L'information manquante existait déjà : chaque jeu qui a un niveau Expert
// déclare le nom Fairy-Stockfish correspondant. Sous deux formes, et la
// seconde est celle qui compte ici — un nom PAR ARRANGEMENT, puisque le
// prélude change les règles.
//
// LA COUVERTURE EST PARTIELLE, ET C'EST NORMAL : Capablanca déclare les
// arrangements 0, 1 et 4, pas les autres. Un arrangement sans variante n'est
// pas une panne ; le fichier s'écrit quand même, avec le nom Jocly, et la
// fenêtre le dit. Refuser priverait d'export des parties qui n'ont rien de
// fautif.
//
// Usage : node tests/test-pgn-variant.mjs   (depuis tabulon/)
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(path.join(root, 'app', 'content', 'play.js'), 'utf-8');

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };

// La fonction est prise DANS play.js plutôt que recopiée : une copie ne serait
// d'accord qu'avec elle-même. play.js n'est pas importable sous Node (il touche
// au DOM au chargement), d'où l'extraction par équilibrage d'accolades — le
// même procédé que tests/test-thinking-clock.mjs.
function lift(name) {
    const at = src.indexOf('function ' + name);
    if (at < 0) throw new Error('introuvable : ' + name);
    let depth = 0;
    for (let j = src.indexOf('{', at); j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) {
            // `levels` est une variable de module : on la fournit par une
            // fermeture, ce qui permet de la changer d'un cas à l'autre.
            return (0, eval)('(function (levels) { return (' + src.slice(at, j + 1) + '); })');
        }
    }
    throw new Error('accolades déséquilibrées : ' + name);
}
const make = lift('FairyVariantName');

console.log('Un nom unique : les variantes sans prélude');
{
    // Horde et 3-check sont natives dans Fairy-Stockfish : le nom suffit, et
    // le PGN produit s'ouvre directement ailleurs.
    const horde = make([{ ai: 'fairy-stockfish', variant: 'horde' }]);
    ok(horde([{ f: 1, t: 2 }]) === 'horde', 'horde-chess -> horde');
    const check = make([{ ai: 'fairy-stockfish', variant: '3check' }]);
    ok(check([]) === '3check', 'three-check-chess -> 3check');
    // Patchanka est personnalisée : le nom est juste, mais le fichier ne sera
    // relisible que par qui possède le même variants.ini. Rien dans le format
    // PGN ne permet de transporter des règles.
    const patch = make([{ ai: 'fairy-stockfish', variant: 'patchanka' }]);
    ok(patch([]) === 'patchanka', 'patchanka-chess -> patchanka');
}

console.log('');
console.log('Un nom par arrangement : les variantes à prélude');
{
    // Le prélude change les règles, donc la variante. Rien dans le nom du jeu
    // ne dit laquelle a été jouée : il faut lire la réponse dans les coups.
    const timurid = make([{ ai: 'fairy-stockfish', variants: [
        { setup: 0, variant: 'timurid-xax' },
        { setup: 1, variant: 'timurid-hqh' },
        { setup: 2, variant: 'timurid-xyx' },
    ] }]);
    ok(timurid([{ setup: 1 }, { f: 1, t: 2 }]) === 'timurid-hqh',
       'l’arrangement choisi décide de la variante');
    ok(timurid([{ setup: 0 }]) === 'timurid-xax', 'et un autre choix donne une autre variante');
    // Sans réponse au prélude, on ne peut pas savoir : null plutôt qu'un nom
    // pris au hasard, qui produirait un fichier faux plutôt qu'imparfait.
    ok(timurid([{ f: 1, t: 2 }]) === null, 'sans prélude joué, aucune variante devinée');

    // Couverture partielle, le cas de Capablanca : les arrangements 2 et 3 ne
    // sont pas déclarés.
    const capa = make([{ ai: 'fairy-stockfish', variants: [
        { setup: 0, variant: 'capablanca' },
        { setup: 1, variant: 'gothic' },
        { setup: 4, variant: 'embassy' },
    ] }]);
    ok(capa([{ setup: 4 }]) === 'embassy', 'un arrangement déclaré donne son nom');
    ok(capa([{ setup: 2 }]) === null, 'un arrangement non déclaré rend null, ce qui est la vérité');
}

console.log('');
console.log('Aucun moteur : aucun nom');
{
    const none = make([{ ai: 'uct', label: 'Novice' }]);
    ok(none([{ f: 1, t: 2 }]) === null, 'un jeu sans niveau Expert n’a pas de variante à déclarer');
    ok(make([])([]) === null, 'ni un jeu sans niveaux du tout');
}

console.log('');
console.log('Le jeton de prélude n’entre pas dans les coups');
{
    /*
     * « #0 » n'est traduisible dans aucune notation : c'est lui qui faisait
     * refuser l'export entier. Il est écarté de la boucle — ce que dit ce
     * choix est déjà dans la balise [Variant], donc rien ne se perd.
     */
    ok(/played\[ply\][\s\S]{0,40}setup !== undefined/.test(src),
       'la boucle d’export écarte la réponse au prélude');
    // Écarté ET la position avancée : sans le rollback, la partie rejouée
    // s'arrêterait sur l'étage du prélude.
    ok(/setup !== undefined\)\s*\{[\s\S]{0,120}rollback\(ply \+ 1\)/.test(src),
       'en avançant tout de même d’un demi-coup');
}

console.log('');
console.log('Faute de nom, on écrit quand même — et on le dit');
{
    const hist = readFileSync(path.join(root, 'app', 'content', 'history.js'), 'utf-8');
    ok(/data\.variant \|\| gameName/.test(hist),
       'le nom Jocly sert de repli plutôt que de refuser le fichier');
    ok(/!data\.variant[\s\S]{0,80}NoteInTitle/.test(hist),
       'et la fenêtre le signale, comme pour les autres refus partiels');
    const i18n = readFileSync(path.join(root, 'app', 'content', 'tabulon-i18n.js'), 'utf-8');
    ok(i18n.includes("'history.pgnVariant'"), 'le message existe dans le dictionnaire');
}

console.log('');
console.log(`RESULTAT pgn-variant: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
