// tests/test-book-formats.mjs
//
// Chargement et sauvegarde de parties : PJN/PGN (avec ou sans tag [FEN]) et
// solutions JSON. Les fixtures sont des fichiers REELS fournis par
// l'utilisateur, pas des exemples reconstruits : c'est le seul moyen de
// verifier qu'on lit ce que Tabulon ecrit et ce que le monde reel produit.

import { ExtractMoves, BookFen, BookGame, BuildPJN, ParseSolution } from '../app/content/book-format.js';

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };

// Reproduit le decoupage en tags de la commande Rust parse_pjn.
function ParseTags(text) {
    const tags = {};
    for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
        const m = /^\s*\[(\S+)\s+(.*)\]\s*$/.exec(line);
        if (m) tags[m[1]] = m[2].replace(/^"|"$/g, '');
    }
    return tags;
}

const PJN_SANS_FEN = `[JoclyGame "rocaille"]
[Date "2026.7.29"]
[PlyCount "13"]

1. Wg3-g6 Ph8-i7 2. Pi3-j4 Wg8-k4 3. Ai2-i6*1 Pg9-g8 4. Ai6-k6 Pj8-j7
`;

const PGN_AVEC_FEN = `[Event "Lichess Puzzle"]
[Result "*"]
[Game classic-chess]
[FEN "r3r3/1p5p/p3pkp1/3pn3/6B1/4R3/PPP3PP/3R2K1 w - - 8 25"]
[SetUp "1"]

25. Rf1+ Kg7 26. Rxe5 *
`;

console.log('Test 1 - PJN sans position de depart');
{
    const tags = ParseTags(PJN_SANS_FEN);
    ok(tags.JoclyGame === 'rocaille', 'le jeu est lu depuis les tags');
    ok(BookFen(tags) === null, 'aucune position de depart -> null (partie standard)');
    const moves = ExtractMoves(PJN_SANS_FEN);
    ok(moves.length === 8, `8 demi-coups extraits (${moves.length})`);
    ok(moves[0] === 'Wg3-g6' && moves[7] === 'Pj8-j7', 'premier et dernier coups corrects');
    ok(!moves.some(m => /^\d+\.$/.test(m)), 'les numeros de coups ne sont pas pris pour des coups');
    ok(moves.includes('Ai2-i6*1'), 'la notation Jocly avec suffixe *1 est preservee');
}

console.log('Test 2 - PGN reel avec position de depart');
{
    const tags = ParseTags(PGN_AVEC_FEN);
    const fen = BookFen(tags);
    ok(typeof fen === 'string' && fen.startsWith('r3r3/'), 'le tag [FEN] est extrait');
    ok(fen.endsWith(' 8 25'), 'le FEN est complet (non tronque a l\'espace)');
    const moves = ExtractMoves(PGN_AVEC_FEN);
    // "25." est colle au premier coup dans certains fichiers, et le resultat
    // "*" ne doit jamais etre pris pour un coup.
    ok(moves.length === 3, `3 demi-coups (${moves.length})`);
    ok(moves[0] === 'Rf1+', 'la numerotation initiale 25. est retiree');
    ok(!moves.includes('*'), 'le resultat n\'est pas un coup');
}

console.log('Test 3 - tags absents ou vides');
{
    ok(BookFen(null) === null, 'aucun tag -> null');
    ok(BookFen({ FEN: '   ' }) === null, 'FEN vide -> null (et non une position invalide)');
    ok(BookFen({ SetUp: '1' }) === null, 'SetUp seul ne suffit pas');
    ok(BookFen({ fen: 'x/y w' }) === 'x/y w', 'variante de casse acceptee');
}

console.log('Test 4 - sauvegarde PJN');
{
    const d = new Date(2026, 7, 10);
    const txt = BuildPJN('rocaille', ['Wg3-g6', 'Ph8-i7', 'Pi3-j4'], null, d);
    ok(txt.includes('[JoclyGame "rocaille"]'), 'tag du jeu');
    ok(txt.includes('[PlyCount "3"]'), 'nombre de demi-coups');
    ok(!txt.includes('[FEN'), 'partie standard -> aucun tag FEN');
    ok(/\n\n1\. Wg3-g6 Ph8-i7 2\. Pi3-j4\n$/.test(txt),
       'coups numerotes ET separes par des espaces');

    const fen = '8+lc1l/7+h2ok/4+H3Q3 w - - 0 1';
    const txt2 = BuildPJN('chu-shogi', ['FLj9-k10+', 'Gk9xk10'], fen, d);
    ok(txt2.includes('[FEN "' + fen + '"]'), 'position de depart ecrite');
    ok(txt2.includes('[SetUp "1"]'), '[SetUp "1"] accompagne [FEN]');
    ok(txt2.indexOf('[FEN') < txt2.indexOf('\n\n'), 'les tags precedent les coups');
}

console.log('Test 5 - aller-retour : ce qu\'on ecrit se relit');
{
    const fen = 'r3r3/1p5p/p3pkp1 w - - 8 25';
    const txt = BuildPJN('classic-chess', ['Rf1+', 'Kg7', 'Rxe5'], fen, new Date(2026, 0, 1));
    ok(BookFen(ParseTags(txt)) === fen, 'la position relue est identique');
    const moves = ExtractMoves(txt);
    ok(moves.join(' ') === 'Rf1+ Kg7 Rxe5', 'les coups relus sont identiques');
}

console.log('Test 6 - solutions JSON');
{
    const sol = {
        game: 'chu-shogi',
        initialBoard: '8+lc1l/7+h2ok w - - 0 1',
        playedMoves: [{ f: 105, t: 118, a: 'FL' }, { f: 106, t: 118, a: 'G' }],
    };
    const parsed = ParseSolution(JSON.stringify(sol));
    ok(parsed && parsed.game === 'chu-shogi', 'solution reconnue, jeu lu dans le fichier');
    ok(parsed.playedMoves.length === 2, 'les coups sont des OBJETS, transmis tels quels');

    // Ne doit PAS confondre un PGN avec du JSON.
    ok(ParseSolution(PGN_AVEC_FEN) === null, 'un PGN n\'est pas pris pour une solution');
    ok(ParseSolution(PJN_SANS_FEN) === null, 'un PJN non plus');
    ok(ParseSolution('{ pas du json') === null, 'JSON invalide -> null, pas d\'exception');
    ok(ParseSolution('{"a":1}') === null, 'JSON quelconque refuse (ni coups ni position)');
    ok(ParseSolution('') === null && ParseSolution(null) === null, 'vide -> null');
    ok(ParseSolution('  {"playedMoves":[]}') !== null, 'espaces en tete toleres');
}

console.log('Test 7 - jeu declare par le fichier');
{
    ok(BookGame(ParseTags(PJN_SANS_FEN)) === 'rocaille', '[JoclyGame] (ecrit par Tabulon)');
    ok(BookGame(ParseTags(PGN_AVEC_FEN)) === 'classic-chess', '[Game] sans guillemets (fichier tiers)');
    ok(BookGame({}) === null && BookGame(null) === null, 'aucun tag de jeu -> null');
    ok(BookGame({ Game: '  ' }) === null, 'tag vide -> null');
    // [JoclyGame] prime : c'est le nom canonique ecrit par Tabulon.
    ok(BookGame({ Game: 'x', JoclyGame: 'chu-shogi' }) === 'chu-shogi', '[JoclyGame] prime sur [Game]');
    // Aller-retour : ce que Tabulon ecrit se relit comme le bon jeu.
    ok(BookGame(ParseTags(BuildPJN('chu-shogi', ['a'], null, new Date(2026,0,1)))) === 'chu-shogi',
       'le jeu survit a l\'aller-retour');
}

console.log('');
console.log(`RESULTAT book-formats: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
