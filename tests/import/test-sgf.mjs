// tests/import/test-sgf.mjs — lecture des parties de go au format SGF.
//
// Deux moitiés, et la seconde est celle qui compte : lire un SGF sans erreur
// ne prouve rien tant que les coups n'ont pas été soumis au vrai moteur. Les
// coordonnées SGF et celles que le joueur lit se ressemblent assez pour qu'une
// erreur de conversion passe la lecture et donne une partie fausse — « dp »
// est D4, pas D16 ni P4.
//
//   1. la conversion et l'arbre, sur des cas construits ;
//   2. les fixtures de tests/fixtures/sgf/, dont une partie rejouée coup par
//      coup dans un vrai go9 par le même chemin que play.js.
//
// Les trois parties du Kishin Match sont des fixtures À HANDICAP : elles sont
// là précisément parce qu'elles ne se rejouent PAS, et le test vérifie que la
// lecture le dit plutôt que de produire une partie plausible et fausse.
//
// Usage : npm test  (ou node tests/import/test-sgf.mjs)
import { createRequire } from 'module';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { IsSgf, ParseSgf, SgfPoint, ReplayBookMoves } from '../../app/content/book-format.js';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const Jocly = require(path.join(root, 'dist/node/jocly.core.js'));

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };

console.log('Les coordonnées');
// Colonne puis ligne, en lettres depuis le coin HAUT-GAUCHE. Le joueur lit la
// colonne sans le I et la ligne depuis le BAS : les deux systèmes partagent
// leur forme et rien d'autre.
ok(SgfPoint('aa', 19) === 'A19', 'aa est le coin haut-gauche');
ok(SgfPoint('ss', 19) === 'T1', 'ss est le coin bas-droit');
ok(SgfPoint('dp', 19) === 'D4', 'dp est D4 — le point de handicap, pas D16');
ok(SgfPoint('pd', 19) === 'Q16', 'pd est Q16');
// Le I n'existe pas en notation de go : la 9e colonne est J. Une conversion
// qui l'oublie décale toutes les colonnes suivantes d'un cran, ce qui se joue
// sans erreur et donne une autre partie.
ok(SgfPoint('ia', 19) === 'J19', 'la 9e colonne est J, le I étant sauté');
ok(SgfPoint('aa', 9) === 'A9', 'et la numérotation suit la taille du goban');

console.log('');
console.log('Les passes et les points impossibles');
ok(SgfPoint('', 19) === 'pass', 'une valeur vide est une passe');
// « tt » était la passe de FF[3] sur les gobans jusqu'à 19x19. Au-delà c'est
// un point comme un autre, et le lire comme une passe perdrait une pierre.
ok(SgfPoint('tt', 19) === 'pass', 'tt est la passe des vieux fichiers');
// 20e colonne (le I sauté) et 20e ligne depuis le haut, soit U2 sur 21x21.
ok(SgfPoint('tt', 21) === 'U2', 'mais un vrai point sur un goban plus grand');
ok(SgfPoint('zz', 9) === null, 'un point hors du goban est refusé');
ok(SgfPoint('d', 19) === null, 'et une valeur tronquée aussi');

console.log('');
console.log('L\'arbre');
{
    // La ligne principale passe par le PREMIER sous-arbre ; les suivants sont
    // des variantes. Les lire toutes mélangerait des coups que personne n'a
    // enchaînés.
    const tree = ParseSgf('(;GM[1]SZ[9];B[aa](;W[bb];B[cc])(;W[dd]))');
    ok(JSON.stringify(tree.moves) === JSON.stringify(['A9', 'B8', 'C7']),
       'la ligne principale traverse le premier sous-arbre : ' + JSON.stringify(tree.moves));

    // Un « ] » échappé dans un commentaire. Sans la gestion de l'échappement,
    // la propriété se ferme trop tôt et tout ce qui suit se décale.
    const esc = ParseSgf('(;GM[1]SZ[9]C[voir [sic\\] plus bas];B[aa];W[bb])');
    ok(esc && esc.moves.length === 2, 'un crochet échappé ne coupe pas la lecture');

    // AB[..][..] : plusieurs valeurs pour une propriété.
    const setup = ParseSgf('(;GM[1]SZ[19]AB[dp][pd];W[dd])');
    ok(JSON.stringify(setup.setup.black) === JSON.stringify(['D4', 'Q16']),
       'une propriété à valeurs multiples est lue en entier');

    ok(IsSgf('(;GM[1])') === true, 'un SGF est reconnu');
    ok(IsSgf('[Event "x"]\n\n1. e4') === false, 'un PGN ne l\'est pas');
    ok(IsSgf('{"game":"go9"}') === false, 'une sauvegarde JSON non plus');
    // GM[2] est l'othello. Un fichier d'un autre jeu se lirait sans erreur et
    // donnerait des coups absurdes : mieux vaut ne pas le reconnaître.
    ok(ParseSgf('(;GM[2]SZ[8];B[dd])') === null, 'un SGF qui n\'est pas du go est refusé');
}

console.log('');
console.log('Les fixtures');
const dir = path.join(root, 'tests', 'fixtures', 'sgf');
const files = readdirSync(dir).filter(f => /\.sgf$/i.test(f)).sort();
ok(files.length >= 2, `${files.length} fichier(s) : ${files.join(', ')}`);

const parsed = {};
for (const f of files) {
    const sgf = ParseSgf(readFileSync(path.join(dir, f), 'utf-8'));
    parsed[f] = sgf;
    ok(!!sgf, `${f} se lit`);
}

// Les trois parties du match : 19x19, handicap 2, Blanc au premier coup. Elles
// sont ici comme CONTRE-EXEMPLES — la lecture doit rendre de quoi les refuser.
for (const f of files.filter(n => /kishin/.test(n))) {
    const s = parsed[f];
    ok(s.size === 19 && s.handicap === 2, `${f} : goban 19, handicap 2`);
    ok(s.setup.black.length === 2, 'les pierres de handicap sont posées avant le premier coup');
    ok(s.firstPlayer === 'W', 'et c\'est Blanc qui joue le premier coup');
    ok(s.alternates === true, 'l\'alternance, elle, est régulière');
    ok(s.meta.black && s.meta.white && s.meta.result,
       `les joueurs et le résultat sont lus : ${s.meta.black} / ${s.meta.white} — ${s.meta.result}`);
    ok(s.moves.length > 200, `${s.moves.length} coups`);
}

console.log('');
console.log('Rejouée dans un vrai go');
{
    // Le seul contrôle qui prouve la conversion : chaque point est soumis au
    // moteur, qui refuse ce qui n'est pas légal. Une colonne décalée d'un cran
    // se ferait prendre ici et nulle part ailleurs.
    const f = files.find(n => /selfplay/.test(n));
    ok(!!f, 'une partie sans handicap est disponible pour la relecture');
    const sgf = parsed[f];
    ok(sgf.size === 9 && !sgf.handicap && sgf.firstPlayer === 'B',
       'elle part d\'un goban vide, Noir au trait');

    const match = await Jocly.createMatch('go' + sgf.size);

    // Le prélude des règles compte pour un coup tant qu'il n'a pas été
    // répondu : aucun point n'est légal avant. play.js fait la même chose.
    const prelude = await match.getPossibleMoves();
    const preludeNames = await match.getMoveString(prelude);
    if (preludeNames.every(n => /^#\d+$/.test(n))) {
        await match.playMove(prelude[0]);
        ok(true, 'le prélude des règles est répondu avant la relecture');
    }

    // Résolution EXACTE, comme play.js pour un livre SGF : pickMove choisit
    // par distance d'édition et ne peut pas échouer, donc « Q16 » manquant se
    // jouerait en « Q15 » sans le dire.
    const exact = async (token) => {
        const want = String(token).trim().toUpperCase();
        const moves = await match.getPossibleMoves();
        const naturals = await match.getMoveString(moves);
        for (let i = 0; i < moves.length; i++)
            if (String(naturals[i]).trim().toUpperCase() === want) return moves[i];
        return null;
    };
    const { played, unresolved } = await ReplayBookMoves(sgf.moves, {
        exact,
        pick: async () => null,
        play: (m) => match.playMove(m),
    });
    ok(unresolved === null, unresolved
        ? `coup refusé : ${unresolved} après ${played}`
        : `les ${played} coups sont tous légaux, dans l'ordre`);
    ok(played === sgf.moves.length, `${played} coups rejoués sur ${sgf.moves.length}`);

    // Et la position atteinte est bien celle de la partie : le dernier coup
    // lu est le dernier coup joué.
    const record = await match.getPlayedMoves();
    const names = await match.getMoveString(record);
    ok(names[names.length - 1] === sgf.moves[sgf.moves.length - 1],
       `le dernier coup joué est celui du fichier (${sgf.moves[sgf.moves.length - 1]})`);
}

console.log('');
console.log(`RESULTAT sgf: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
