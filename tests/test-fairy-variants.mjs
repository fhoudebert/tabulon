// tests/test-fairy-variants.mjs
//
// Lecture d'un variants.ini de Fairy-Stockfish. La fixture est un extrait
// LITTERAL du fichier officiel (src/variants.ini du depot Fairy-Stockfish) :
// les cas qui comptent -- heritage, valeurs contenant des espaces, sections
// sans parent -- sont ceux du vrai fichier, pas des cas reconstruits.

import { ParseVariantsIni, ResolveVariants, ReadVariantsIni, IsVariantsIni, MatchGames }
    from '../app/content/fairy-variants.js';
import { FairyGameIndex } from '../app/content/book-format.js';

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };

// Extrait reel de src/variants.ini (Fairy-Stockfish, licence GPL v3).
const INI = `# Commentaire d'en-tete
### Usage:
# Add "load" and the file path to the SF call

[indiangreat]
pieceToCharTable = PNBRQ..VW.........G..Kpnbrq..vw.........g..k
pawn = p
knight = n
king = k
maxRank = 10
maxFile = 10
startFen = rnbqkgvbnr/ppppwwpppp/4pp4/10/10/10/10/4PP4/PPPPWWPPPP/RNBVGKQBNR w - - 0 1
doubleStep = false
castling = false

# Upside-down
[upsidedown:chess]
startFen = RNBKQBNR/PPPPPPPP/8/8/8/8/pppppppp/rnbkqbnr w - - 0 1

[maharajah]
pawn = p
amazon = m
startFen = rnbqkbnr/pppppppp/8/8/8/8/8/4M3 w kq - 0 1
extinctionValue = loss

[maharajah2:maharajah]
amazon = -
customPiece1 = m:QNAD
startFen = 3mm3/8/8/8/8/8/PPPPPPPP/RNBQKBNR w KQ - 0 1
`;

console.log('Test 1 - decoupage en sections');
{
    const sec = ParseVariantsIni(INI);
    ok(sec.length === 4, `4 sections (${sec.length}) — les commentaires d'en-tete n'en sont pas`);
    ok(sec[0].name === 'indiangreat' && sec[0].parent === null, 'section sans heritage');
    ok(sec[1].name === 'upsidedown' && sec[1].parent === 'chess', 'section "[enfant:parent]"');
    ok(sec[0].keys.maxFile === '10', 'cle numerique lue');
    ok(sec[0].keys.startFen.endsWith('w - - 0 1'),
       'un FEN contient des espaces et ne doit PAS etre coupe au premier');
    ok(sec[1].keys.startFen && !('# Upside-down' in sec[1].keys),
       'les lignes de commentaire ne deviennent pas des cles');
    ok(ParseVariantsIni('').length === 0 && ParseVariantsIni(null).length === 0,
       'entree vide -> aucune section, pas d\'exception');
}

console.log('Test 2 - heritage');
{
    const v = ResolveVariants(ParseVariantsIni(INI));
    const by = Object.fromEntries(v.map(x => [x.name, x]));

    ok(by.maharajah2.keys.extinctionValue === 'loss', 'les cles du parent sont heritees');
    ok(by.maharajah2.keys.startFen.startsWith('3mm3/'), 'l\'enfant garde ses propres cles');
    ok(by.maharajah2.keys.customPiece1 === 'm:QNAD', 'cle presente seulement chez l\'enfant');
    ok(by.maharajah.keys.customPiece1 === undefined, 'l\'heritage ne remonte pas vers le parent');

    // "chess" est une variante NATIVE du moteur : sa definition n'est pas
    // dans le fichier, donc la chaine reste incomplete.
    ok(by.upsidedown.resolved === false, 'heritage d\'une variante native -> chaine incomplete');
    ok(by.upsidedown.files === null && by.upsidedown.ranks === null,
       'taille inconnue plutot qu\'inventee quand le parent manque');
    const withChess = ResolveVariants(ParseVariantsIni(INI), { chess: { maxFile: '8', maxRank: '8' } });
    const up = withChess.find(x => x.name === 'upsidedown');
    ok(up.resolved === true && up.files === 8, 'definition du parent fournie -> chaine complete');
}

console.log('Test 3 - taille du plateau');
{
    const v = ReadVariantsIni(INI);
    const by = Object.fromEntries(v.map(x => [x.name, x]));
    ok(by.indiangreat.files === 10 && by.indiangreat.ranks === 10, 'dimensions declarees');
    // 8x8 est le defaut documente de Fairy-Stockfish, applicable seulement
    // quand toute la chaine d'heritage est connue.
    ok(by.maharajah.files === 8 && by.maharajah2.files === 8,
       'defaut 8x8 applique quand la chaine est complete');
}

console.log('Test 4 - reconnaissance du format');
{
    ok(IsVariantsIni(INI), 'un variants.ini est reconnu');
    ok(!IsVariantsIni('[Event "x"]\n[FEN "8/8"]\n\n1. e4'), 'un PGN n\'est PAS pris pour un ini');
    ok(!IsVariantsIni('{"game":"chess","playedMoves":[]}'), 'un JSON non plus');
    ok(!IsVariantsIni('[section]\ncouleur = bleu\n'), 'un .ini quelconque non plus (aucune cle du format)');
    ok(!IsVariantsIni('') && !IsVariantsIni(null), 'vide -> false, pas d\'exception');
}

console.log('Test 5 - jeux Jocly candidats');
{
    // FairyGameIndex lit le catalogue : chaque jeu qui sait se faire jouer
    // par le moteur declare sa variante dans ses niveaux.
    const configs = {
        'shako-chess':   { model: { levels: [{ ai: 'uct' }, { ai: 'fairy-stockfish', variant: 'shako' }] } },
        'classic-chess': { model: { levels: [{ ai: 'fairy-stockfish', variant: 'chess' }] } },
        'capablanca-chess': { model: { levels: [{ ai: 'fairy-stockfish', variants: [
            { setup: 0, variant: 'capablanca' }, { setup: 1, variant: 'gothic' }] }] } },
        'draughts':      { model: { levels: [{ ai: 'uct' }] } },
    };
    const index = FairyGameIndex(configs);
    // L'index rend { game, setup } : le jeu, et pour un jeu a prelude
    // l'arrangement que la variante designe -- sans quoi un fichier rouvrait
    // le bon jeu au premier arrangement.
    ok(index.shako?.game === 'shako-chess', 'variante native -> jeu Jocly');
    ok(index.shako?.setup === null, 'sans arrangement : ce jeu n\'a pas de prelude');
    ok(index.gothic?.game === 'capablanca-chess', 'jeu a prelude : toutes ses variantes sont indexees');
    ok(index.draughts === undefined, 'un jeu sans niveau Fairy n\'entre pas dans l\'index');
    ok(FairyGameIndex(null) && Object.keys(FairyGameIndex(null)).length === 0,
       'catalogue absent -> index vide, pas d\'exception');

    const geo = { 'chu-shogi': { files: 12, ranks: 12 }, 'shako-chess': { files: 10, ranks: 10 } };
    ok(MatchGames({ name: 'shako', files: 10, ranks: 10 }, index, geo)[0] === 'shako-chess',
       'variante connue : le jeu qui la joue, sans passer par la geometrie');
    ok(MatchGames({ name: 'indiangreat', files: 10, ranks: 10 }, index, geo)[0] === 'shako-chess',
       'variante inconnue : repli sur les plateaux de meme taille');
    ok(MatchGames({ name: 'x', files: 19, ranks: 19 }, index, geo).length === 0,
       'aucune taille compatible -> aucune proposition (plutot qu\'une au hasard)');
    ok(MatchGames({ name: 'x' }, index, geo).length === 0, 'taille inconnue -> aucune proposition');
}

console.log('');
console.log(`RESULTAT fairy-variants: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
