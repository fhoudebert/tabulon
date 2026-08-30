// tests/test-book-formats.mjs
//
// Chargement et sauvegarde de parties : PJN/PGN (avec ou sans tag [FEN]) et
// solutions JSON. Les fixtures sont des fichiers REELS fournis par
// l'utilisateur, pas des exemples reconstruits : c'est le seul moyen de
// verifier qu'on lit ce que Tabulon ecrit et ce que le monde reel produit.

import { ExtractMoves, BookFen, BookGame, BuildPJN, ParseSolution, ReplayBookMoves, BookLabel,
         BookVariant, FairyGameIndex, BookCommentary, StripBookMoves, VariantFen, FairyVariantAlias, ParseWxfMove, WxfMatches, MoveFormat, ParseSanMove, SanMatches } from '../../app/content/book-format.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const here    = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = (name) => readFileSync(path.join(here, name), 'utf-8');

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

console.log('Test 8 - fichier reel rocaille.pjn (partie standard)');
{
    const txt  = fixture('fixtures/jocly/rocaille.pjn');
    const tags = ParseTags(txt);
    ok(BookGame(tags) === 'rocaille', 'le jeu est declare par le fichier');
    ok(BookFen(tags) === null, 'pas de tag FEN -> position standard');
    const moves = ExtractMoves(txt);
    ok(moves.length === Number(tags.PlyCount),
       `${tags.PlyCount} demi-coups annonces, ${moves.length} extraits`);
    ok(moves[0] === 'Wg3-g6' && moves[12] === 'Ak6-j6', 'premier et dernier coups');
}

console.log('Test 9 - fichier reel es3.pjn (probleme de chu-shogi)');
{
    const txt  = fixture('fixtures/jocly/es3.pjn');
    const tags = ParseTags(txt);
    ok(BookGame(tags) === 'chu-shogi', 'jeu declare');
    ok(BookFen(tags).startsWith('8+lc1l/') && BookFen(tags).endsWith(' 0 1'),
       'la position du probleme est lue en entier');

    const tokens = ExtractMoves(txt);
    // Numerotation ecrite "4 ." (espace avant le point) dans ce fichier.
    ok(!tokens.includes('4') && !tokens.includes('5'),
       'un numero de coup separe du point n\'est pas pris pour un coup');
    ok(!tokens.some(tk => tk.startsWith('.')), 'aucun jeton ne garde un point en tete');

    // Ce fichier colle des coups ("…-k12+Kl11xk12") : le decoupage final est
    // fait par ReplayBookMoves, qui interroge le moteur. Moteur simule ici
    // par la liste des 9 coups attendus, joues dans l'ordre.
    // Les 9 demi-coups de es3-solution.json, en notation. Trois d'entre eux
    // sont colles a leur voisin dans le fichier (signe d'echec suivi
    // immediatement du coup suivant, lui-meme ouvert par un "+" de piece
    // promue) : c'est exactement ce que la resolution doit demeler.
    const expected = ['FLj9-k10+', 'Gk9xk10', 'DKj7-j9=+DK+', 'Gk10xj9', '+Le2-l9+',
                      '+Li12xl9', 'FKi10-k12+', 'Kl11xk12', '+DHe10-k10+'];
    let next = 0;
    const engine = {
        pick: (s) => (s === expected[next] ? { san: s } : null),
        play: () => { next++; },
    };
    const r = await ReplayBookMoves(tokens, engine);
    ok(r.unresolved === null, 'aucun jeton refuse (' + (r.unresolved || '-') + ')');
    ok(r.played === Number(tags.PlyCount),
       `${tags.PlyCount} demi-coups annonces, ${r.played} rejoues`);
}

console.log('Test 10 - resolution des jetons');
{
    // Decorations finales : le moteur ne connait que la forme nue.
    {
        const seen = [];
        const r = await ReplayBookMoves(['Rf1+', 'Kg7'], {
            pick: (s) => (/[+#!?]$/.test(s) ? null : { s }),
            play: (m) => seen.push(m.s),
        });
        ok(r.played === 2 && seen[0] === 'Rf1', 'le + final est retire si besoin');
        ok(r.unresolved === null, 'et la lecture continue');
    }
    // Le plus LONG prefixe gagne : "e4e5" ne doit pas se couper en "e" + "4e5".
    {
        const legal = new Set(['e4', 'e5']);
        const seen = [];
        const r = await ReplayBookMoves(['e4e5'], {
            pick: (s) => (legal.has(s) ? { s } : null),
            play: (m) => seen.push(m.s),
        });
        ok(r.played === 2 && seen.join(' ') === 'e4 e5', 'deux coups colles sont separes');
    }
    // Jeton vraiment inconnu : on s'arrete la, on ne saute pas.
    {
        const r = await ReplayBookMoves(['e4', 'zz9'], { pick: (s) => (s === 'e4' ? { s } : null), play: () => {} });
        ok(r.played === 1 && r.unresolved === 'zz9', 'arret sur le premier coup irresolu, signale');
    }
    ok((await ReplayBookMoves([], { pick: () => null, play: () => {} })).played === 0,
       'liste vide -> 0 coup, pas d\'exception');
}

console.log('Test 11 - solution reelle es3-solution.json');
{
    const sol = ParseSolution(fixture('fixtures/jocly/es3-solution.json'));
    ok(sol !== null, 'reconnue comme sauvegarde Jocly');
    ok(sol.game === 'chu-shogi', 'le jeu vient du fichier, pas de la fiche affichee');
    ok(sol.playedMoves.length === 9, '9 coups, transmis tels quels a joclyMatch.load()');
    ok(typeof sol.initialBoard === 'string' && sol.initialBoard.includes('+lc1l'),
       'la position de depart accompagne les coups');
    // Meme probleme que es3.pjn : les deux fichiers doivent decrire la meme partie.
    ok(sol.initialBoard === BookFen(ParseTags(fixture('fixtures/jocly/es3.pjn'))),
       'la position est identique a celle du PJN correspondant');
    ok(sol.playedMoves.length === Number(ParseTags(fixture('fixtures/jocly/es3.pjn')).PlyCount),
       'et le nombre de coups aussi');
}

console.log('Test 12 - libelle d\'une partie');
{
    const L = (tags, opts) => BookLabel(tags, { pliesLabel: 'coups', ...opts });

    // 1. Les joueurs quand ils sont nommes.
    ok(L({ White: 'Kasparov', Black: 'Topalov', Result: '1-0', PlyCount: '5' })
       === 'Kasparov vs Topalov — 1-0, 5 coups', 'joueurs + resultat + longueur');
    ok(L({ White: 'Alice', Black: 'Bob', Result: '*' }) === 'Alice vs Bob',
       'resultat "*" (partie en cours) omis, comme en PGN');

    // 2. "?" est la valeur PGN pour "inconnu" : elle ne doit JAMAIS s'afficher.
    //    C'est tout le bug -- parse_pjn ecrivait "? vs ?" pour les fichiers de
    //    Tabulon, qui ne posait pas [White]/[Black].
    ok(!L({ White: '?', Black: '?', PlyCount: '9' }, { fileName: 'es3.pjn' }).includes('?'),
       'aucun "?" affiche quand les joueurs sont inconnus');
    ok(L({ White: '?', Black: '?', PlyCount: '9' }, { fileName: 'es3.pjn' }) === 'es3 — 9 coups',
       'repli sur le nom du fichier');
    ok(L({}, {}) === '?', 'rien du tout -> pas de faux libelle');

    // 3. Echelle de repli, du plus parlant au moins parlant.
    ok(L({ Event: 'Puzzle du jour', Date: '2026.8.11' }, { fileName: 'x.pjn' }) === 'Puzzle du jour',
       '[Event] prime sur le nom du fichier');
    ok(L({ JoclyGame: 'chu-shogi', Date: '2026.8.11' }) === '2026.8.11',
       'sans Event ni fichier : la date');
    ok(L({ JoclyGame: 'chu-shogi' }) === 'chu-shogi', 'en dernier ressort : le jeu');
    ok(L({}, { fileName: '/home/moi/parties/es3.pjn' }) === 'es3',
       'chemin et extension retires du nom de fichier');

    // 4. Longueur : [PlyCount] s'il est la, sinon le comptage de l'appelant.
    ok(L({ Event: 'x' }, { plies: 13 }) === 'x — 13 coups', 'longueur fournie par l\'appelant');
    ok(L({ Event: 'x', PlyCount: '9' }, { plies: 13 }) === 'x — 9 coups',
       '[PlyCount] du fichier fait foi quand il est present');

    // 5. Numero d'ordre : seulement s'il y a plusieurs parties dans le fichier.
    ok(L({ Event: 'x' }, { index: 0, count: 1 }) === 'x', 'fichier a une partie : pas de "#1"');
    ok(L({ Event: 'x' }, { index: 2, count: 5 }) === 'x #3', 'fichier a plusieurs parties : numerote');

    // 6. Fichiers reels.
    ok(L(ParseTags(fixture('fixtures/jocly/es3.pjn')), { fileName: 'es3.pjn' }) === 'es3 — 9 coups',
       'es3.pjn : "es3 — 9 coups" au lieu de "? vs ? #1"');
    ok(L(ParseTags(fixture('fixtures/jocly/rocaille.pjn')), { fileName: 'rocaille.pjn' }) === 'rocaille — 13 coups',
       'rocaille.pjn : idem');
}

console.log('Test 13 - tags d\'identification a la sauvegarde');
{
    const d = new Date(2026, 7, 11);
    // Sans metadonnees : rien de nouveau, aucun tag vide ni "?" parasite.
    const nu = BuildPJN('chu-shogi', ['a', 'b'], null, d);
    ok(!/\[(White|Black|Result|Event)\b/.test(nu), 'aucun tag vide quand on ne sait rien');

    const txt = BuildPJN('classic-chess', ['e4', 'e5', 'Nf3'], null, d, {
        event: 'es3', white: 'Humain', black: 'Ordinateur (Facile)', result: '1-0',
    });
    ok(txt.includes('[Event "es3"]'), '[Event] ecrit');
    ok(txt.includes('[White "Humain"]') && txt.includes('[Black "Ordinateur (Facile)"]'), '[White]/[Black] ecrits');
    ok(txt.includes('[Result "1-0"]'), '[Result] ecrit');
    ok(txt.indexOf('[Event') < txt.indexOf('[Date') && txt.indexOf('[White') < txt.indexOf('[Result'),
       'ordre du roster PGN respecte');
    ok(txt.indexOf('[PlyCount') < txt.indexOf('\n\n'), 'tous les tags precedent les coups');
    ok(BuildPJN('x', [], null, d, { white: '   ' }).indexOf('[White') === -1,
       'valeur vide -> tag omis, pas [White ""]');

    // Aller-retour : ce qu'on ecrit se relit en un libelle utile.
    ok(BookLabel(ParseTags(txt), { pliesLabel: 'coups' }) === 'Humain vs Ordinateur (Facile) — 1-0, 3 coups',
       'le fichier ecrit se relit en un libelle complet');
}

console.log('Test 14 - livre reel multi-jeux (all-tests.pgn)');
{
    const txt = fixture('fixtures/jocly/all-tests.pgn');
    // Reproduit le decoupage de parse_pjn : bloc de tags + bloc de coups.
    const blocks = txt.replace(/\r\n?/g, '\n').split('\n\n').map(b => b.trim()).filter(Boolean);
    const matches = [];
    for (let i = 0; i < blocks.length; ) {
        if (!blocks[i].startsWith('[')) { i++; continue; }
        let j = i + 1;
        while (j < blocks.length && !blocks[j].startsWith('[')) j++;
        matches.push({ tags: ParseTags(blocks[i]), text: [blocks[i], ...blocks.slice(i + 1, j)].join('\n\n') });
        i = j;
    }
    ok(matches.length === 12, `12 parties dans le fichier (${matches.length})`);

    // Chaque partie declare SON jeu : douze jeux differents dans un fichier.
    const games = matches.map(m => BookGame(m.tags));
    ok(new Set(games).size === 12, 'douze jeux distincts — un livre n\'est pas forcement mono-jeu');
    ok(games[0] === 'shako-chess' && games[6] === 'shogi', 'jeux lus dans les tags');

    // [PlyCount] du fichier contre les coups reellement extraits : c'est le
    // controle d'integrite que ce tag permet, et il passe sur les 12 blocs
    // malgre des notations tres differentes (SAN, shogi "S-48", drops "B*55",
    // kyotoshogi "+Px11-", promotions "dxc1=Q+").
    const ecarts = matches.filter(m => ExtractMoves(m.text).length !== Number(m.tags.PlyCount));
    ok(ecarts.length === 0,
       'PlyCount == coups extraits pour les 12 parties' +
       (ecarts.length ? ' — ecarts sur ' + ecarts.map(m => BookGame(m.tags)).join(', ') : ''));

    // Position de depart : ces parties partent toutes d'un FEN, y compris des
    // FEN a poche shogi ("[]"), qui ne doivent pas etre tronques.
    ok(matches.every(m => BookFen(m.tags)), 'chaque partie porte sa position de depart');
    ok(BookFen(matches[6].tags).includes('[]'), 'la poche shogi "[]" est preservee dans le FEN');

    // Libelle : le nom du fichier est le meme pour les douze, il ne distingue
    // rien. En multi-parties c'est donc le jeu qui mene.
    const label = (i) => BookLabel(matches[i].tags,
        { index: i, count: matches.length, fileName: 'all-tests.pgn', pliesLabel: 'coups' });
    ok(label(0) === 'shako-chess — 3 coups #1', 'libelle mene par le jeu — ' + label(0));
    ok(label(1) === 'xiangqi — 10 coups #2', 'chaque entree est distinguable — ' + label(1));
    ok(new Set(matches.map((_, i) => label(i))).size === 12, 'les douze libelles sont distincts');
}

console.log('Test 15 - deux nomenclatures, jamais confondues');
{
    // Fairy-Stockfish et Jocly nomment les memes jeux DIFFEREMMENT, et de
    // facon assez voisine pour qu'on s'y trompe. Releve reel sur le catalogue
    // jocly2 : sur les 13 variantes du all-tests.pgn de reference, 5 noms
    // Jocly ne sont PAS le nom de la variante, et 3 ne s'en deduisent meme
    // pas par ajout de "-chess".
    const REEL = {
        shako: 'shako-chess', xiangqi: 'xiangqi', knightmate: 'knightmate-chess',
        shatranj: 'shatranj-chess', antichess: 'losing-chess', makruk: 'makruk',
        wildebeest: 'wildebeest-chess', shogi: 'shogi', minishogi: 'mini-shogi',
        kyotoshogi: 'kyoto-shogi', losalamos: 'los-alamos-chess',
        spartan: 'spartan-chess', courier: 'courier-chess',
    };
    const identiques = Object.entries(REEL).filter(([v, j]) => v === j);
    ok(identiques.length === 3,
       `3 noms identiques des deux cotes sur 13 (${identiques.length}) — d'ou la tentation de croire la conversion triviale`);
    ok(REEL.minishogi !== 'minishogi' && REEL.kyotoshogi !== 'kyotoshogi',
       'mais "minishogi"/"kyotoshogi" ne sont PAS des noms Jocly (mini-shogi, kyoto-shogi)');
    ok(REEL.knightmate !== 'knightmate' && REEL.shatranj !== 'shatranj',
       'ni "knightmate"/"shatranj" (knightmate-chess, shatranj-chess)');
    ok(REEL.antichess === 'losing-chess',
       'et "antichess" devient "losing-chess" : aucune regle mecanique ne relie les deux');

    // La lecture doit distinguer les deux tags. [JoclyGame] est un nom Jocly,
    // [Variant] un nom de moteur : les intervertir ouvre le mauvais jeu.
    const tags = { JoclyGame: 'mini-shogi', Variant: 'minishogi' };
    ok(BookGame(tags) === 'mini-shogi', '[JoclyGame] lit la nomenclature Jocly');
    ok(BookVariant(tags) === 'minishogi', '[Variant] lit la nomenclature Fairy-Stockfish');
    ok(BookVariant({ Variant: 'Shako' }) === 'shako', 'la variante est normalisee en minuscules');
    ok(BookVariant({ JoclyGame: 'shako-chess' }) === null,
       '[JoclyGame] n\'est jamais pris pour une variante');
    ok(BookGame({ Variant: 'shako' }) === null, 'ni l\'inverse');

    // L'index du catalogue fait la conversion, et ne l'invente pas.
    const index = FairyGameIndex({
        'mini-shogi':       { model: { levels: [{ ai: 'fairy-stockfish', variant: 'minishogi' }] } },
        'knightmate-chess': { model: { levels: [{ ai: 'fairy-stockfish', variant: 'knightmate' }] } },
    });
    ok(index.minishogi === 'mini-shogi' && index.knightmate === 'knightmate-chess',
       'le catalogue donne la correspondance exacte, sans table ecrite a la main');
    ok(index['mini-shogi'] === undefined, 'un nom Jocly n\'entre pas dans l\'index des variantes');

    // Ecriture : les deux tags cohabitent, aucune conversion destructive.
    const txt = BuildPJN('mini-shogi', ['P-14'], null, new Date(2026, 0, 1), { variant: 'minishogi' });
    ok(txt.includes('[JoclyGame "mini-shogi"]') && txt.includes('[Variant "minishogi"]'),
       'les deux noms sont ecrits cote a cote');
    ok(BookGame(ParseTags(txt)) === 'mini-shogi' && BookVariant(ParseTags(txt)) === 'minishogi',
       'et se relisent chacun dans sa nomenclature');
    ok(!BuildPJN('x', [], null, new Date(), {}).includes('[Variant'),
       'aucun [Variant] invente quand la partie ne vient pas du moteur');
}

console.log('Test 16 - commentaires d\'une partie');
{
    // Fichier reel : l'etude lichess du Mat de l'Opera.
    const c = BookCommentary(fixture('fixtures/problems/classic-chess/matOpera.pgn'));
    ok(c.length === 4, `1 enonce + 3 coups (${c.length})`);
    ok(c[0].move === null && /Paul Morphy/.test(c[0].comment),
       'le commentaire ecrit avant le premier coup sort en tete, sans coup attache');
    ok(c[1].number === '16.' && c[1].move === 'Qb8+', 'numero et coup separes');
    ok(/sacrifice d'attraction/.test(c[1].comment), 'le commentaire est rattache a SON coup');
    ok(c[2].number === '16...' && c[2].move === 'Nxb8', 'la numerotation "16..." est reconnue');
    ok(c[3].move === 'Rd8#' && c[3].comment === 'Bien joué !', 'dernier coup et son commentaire');

    // Le meme fichier contient { [%csl Gd8,Ge7] } : une annotation machine
    // (cases colorees), a jeter. Elle suit le coup 16. et se collerait a son
    // commentaire si on ne la filtrait pas.
    ok(!c.some(x => /%csl|Gd8/.test(x.comment || '')), 'les commandes [%…] sont retirees');
    ok(!c.some(x => x.comment === ''), 'un commentaire vide apres nettoyage disparait');

    // Fichier d'UltraBullet : une commande [%clk] par demi-coup, et RIEN
    // d'autre. Sans filtrage la fenetre afficherait 7 horodatages.
    const d = BookCommentary(fixture('fixtures/problems/classic-chess/matduberger.pgn'));
    ok(d.length === 7, `7 demi-coups (${d.length})`);
    ok(d.slice(0, 6).every(x => x.comment === null),
       'les commentaires reduits a un [%clk] ne laissent rien derriere eux');
    ok(d[6].move === 'Qxf7#', 'le mat est bien le dernier coup');

    // Coherence avec ExtractMoves : meme partie, meme nombre de coups.
    for (const f of ['fixtures/problems/classic-chess/matOpera.pgn',
                     'fixtures/problems/classic-chess/matduberger.pgn',
                     'fixtures/problems/ultima/matc.pjn']) {
        const txt = fixture(f);
        ok(BookCommentary(txt).filter(x => x.move).length === ExtractMoves(txt).length,
           'meme nombre de coups que ExtractMoves — ' + f.split('/').pop());
    }

    // Robustesse.
    ok(BookCommentary('').length === 0 && BookCommentary(null).length === 0,
       'entree vide -> liste vide, pas d\'exception');
    ok(BookCommentary('[Event "x"]\n\n1. e4 { a } ( 1. d4 { variante } ) 1... e5')
       .every(x => !/variante/.test(x.comment || '')),
       'les variantes (…) sont ecartees, comme dans ExtractMoves');
    const nag = BookCommentary('[E "x"]\n\n1. e4 $1 $18 e5 1-0');
    ok(nag.length === 2 && nag[0].move === 'e4', 'NAG et resultat ne deviennent pas des coups');
    const glue = BookCommentary('[E "x"]\n\n16.Qb8+ {bien} 16...Nxb8');
    ok(glue[0].number === '16.' && glue[0].move === 'Qb8+',
       'numero colle au coup ("16.Qb8+") correctement separe');
    const two = BookCommentary('[E "x"]\n\n1. e4 {un} {deux}');
    ok(two.length === 1 && two[0].comment === 'un deux',
       'deux accolades consecutives se rattachent au meme coup');
}

console.log('Test 17 - retrait des coups (bouton « Essayer »)');
{
    // Le decoupage de parse_pjn, reproduit : un bloc de tags emporte tout ce
    // qui le suit jusqu'au prochain bloc de tags. C'est LUI qui contraint le
    // format du texte produit -- d'ou le corps non vide ecrit par
    // StripBookMoves, sans quoi deux blocs de tags consecutifs se suivraient.
    const split = (txt) => {
        const b = txt.replace(/\r\n?/g, '\n').split('\n\n').map(x => x.trim()).filter(Boolean);
        const out = [];
        for (let i = 0; i < b.length; ) {
            if (!b[i].startsWith('[')) { i++; continue; }
            let j = i + 1;
            while (j < b.length && !b[j].startsWith('[')) j++;
            out.push({ tags: ParseTags(b[i]), text: [b[i], ...b.slice(i + 1, j)].join('\n\n') });
            i = j;
        }
        return out;
    };

    // Fichier a UNE partie.
    {
        const orig = fixture('fixtures/problems/classic-chess/matOpera.pgn');
        const bare = StripBookMoves(orig);
        ok(ExtractMoves(bare).length === 0, 'plus aucun coup — c\'est tout l\'objet du bouton');
        ok(ExtractMoves(orig).length === 3, 'alors que l\'original en portait 3');
        const t0 = ParseTags(bare);
        ok(BookFen(t0) === BookFen(ParseTags(orig)), 'la position de depart est conservee a l\'identique');
        ok(t0.Event && t0.Event.includes('Opéra'), 'et les tags aussi : le titre survit');
        ok(t0.StudyName && t0.ChapterURL,
           'y compris les tags tiers qu\'on ne connait pas — on coupe le texte, on ne le reecrit pas');
        ok(t0.PlyCount === '0', '[PlyCount] est remis a 0 plutot que laisse mensonger');
    }

    // Fichier a PLUSIEURS parties : les trois problemes doivent survivre.
    {
        const orig = fixture('fixtures/problems/chu-shogi/tsumeshogi.pjn');
        const bare = StripBookMoves(orig);
        const a = split(orig), b = split(bare);
        ok(a.length === 3, '3 problemes dans le fichier d\'origine');
        ok(b.length === 3,
           `3 problemes apres retrait (${b.length}) — deux blocs de tags de suite feraient prendre ` +
           'le second pour les coups du premier');
        ok(b.every(m => ExtractMoves(m.text).length === 0), 'aucun coup dans aucune des trois');
        ok(b.every((m, i) => BookFen(m.tags) === BookFen(a[i].tags)), 'chacune garde SA position');
        ok(b[1].tags.Event.includes('George Hodges'), 'et son titre');
    }

    // Robustesse.
    ok(StripBookMoves('') === '' && StripBookMoves(null) === '',
       'entree vide -> chaine vide, pas d\'exception');
    ok(StripBookMoves('1. e4 e5') === '',
       'un corps de coups sans tags devant ne produit rien : il n\'y a pas de position a ouvrir');
    ok(!/1\. e4/.test(StripBookMoves('[Event "x"]\n\n1. e4 { note } e5')),
       'les commentaires partent avec les coups');
}

console.log('Test 18 - PGN de variantes (PyChess, chessvariants)');
{
    // Les exportateurs de variantes ecrivent le nom du jeu en toutes lettres
    // la ou Fairy-Stockfish le colle. Sans alias, le jeu ne se resout pas et
    // le fichier n'ouvre rien.
    ok(FairyVariantAlias('Kyoto Shogi') === 'kyotoshogi', '« Kyoto Shogi » -> kyotoshogi');
    ok(FairyVariantAlias('Grand') === 'grand' && FairyVariantAlias('Capablanca') === 'capablanca',
       'les noms deja colles passent inchanges');
    ok(FairyVariantAlias('Xiangqi') === 'xiangqi', 'et ceux qui coincident aussi');

    // XIANGQI : le plateau est le meme, les LETTRES non. PyChess ecrit le
    // cavalier « n » et l'elephant « b » (convention occidentale), jocly « h »
    // et « e ». Un FEN parfaitement valide etait refuse -- « FEN invalid board
    // spec n » -- pour cette seule raison.
    const py = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';
    const jocly = VariantFen(py, 'xiangqi');
    ok(jocly.startsWith('rheakaehr/'), 'cavaliers et elephants traduits — ' + jocly.split('/')[0]);
    ok(jocly.endsWith(' w - - 0 1'), 'les autres champs sont intacts');
    ok(VariantFen(py, 'classic-chess') === py, 'et rien n\'est touche pour un autre jeu');
    ok(VariantFen(jocly, 'xiangqi').startsWith('rheakaehr/'),
       'la conversion est idempotente : un FEN deja jocly ne bouge pas');

    // Les shogi a reserve : « plateau trait 0 1 » est un SFEN dont le champ de
    // main a ete omis, avec le trait dans la convention du PGN.
    // KYOTO SHOGI : chaque piece a deux faces et se retourne a chaque coup.
    // PyChess donne une lettre par face (T = tokin, G = or), jocly ecrit la
    // face « promue » de la lance et du cavalier. Meme retournement, deux
    // facons de le nommer -- sans la traduction, le FEN se charge a moitie et
    // il ne reste qu'un pion sur le plateau.
    ok(VariantFen('pgkst/5/5/5/TSKGP w 0 1', 'kyoto-shogi') === 'p+nks+l/5/5/5/+LSK+NP b - 1',
       'lettres traduites, main recomposee et trait inverse');
    ok(VariantFen('p+nks+l/5/5/5/+LSK+NP b - 1', 'kyoto-shogi') === 'p+nks+l/5/5/5/+LSK+NP b - 1',
       'et un FEN deja jocly ne bouge pas : la conversion est idempotente');
    ok(VariantFen('board w - - 0 1', 'shogi') === 'board w - - 0 1',
       'un FEN a six champs n\'est pas retouche');
}

console.log('Test 19 - notation WXF du xiangqi');
{
    // Elle est ecrite DU POINT DE VUE DU JOUEUR, et c'est ce qui la rend
    // intraduisible sans connaitre le trait : la colonne 2 des Rouges et la
    // colonne 2 des Noirs sont a l'oppose du plateau.
    ok(MoveFormat(['H2+3', 'C2=5', 'P7+1']) === 'wxf', 'reconnue en demi-largeur');
    ok(MoveFormat(['\uff23\uff12\uff1d\uff15', '\uff28\uff18\uff0b\uff17']) === 'wxf',
       'et en pleine largeur, la forme des archives chinoises');
    // « Ch2 » et « Ae6 » sont du SAN de variante (Capablanca) : reconnus comme
    // tels depuis que le lecteur SAN existe, et surtout PAS comme du WXF.
    ok(MoveFormat(['Ch2', 'Ae6']) === 'san', 'un SAN de variante n\'est pas pris pour du WXF');

    const p = ParseWxfMove('\uff23\uff12\uff1d\uff15');
    ok(p && p.piece === 'C' && p.file === 2 && p.dir === '=' && p.num === 5,
       'les chiffres pleine largeur sont ramenes a l\'ASCII');

    // Les colonnes se comptent depuis la droite du camp au trait : la meme
    // « colonne 2 » designe deux colonnes opposees selon le camp.
    ok(WxfMatches(ParseWxfMove('C2=5'), 'h2', 'e2', 'C', true, 9),
       'Rouge : colonne 2 = la 8e depuis la gauche');
    ok(WxfMatches(ParseWxfMove('C2=5'), 'b7', 'e7', 'c', false, 9),
       'Noir : la meme colonne 2 est la 2e depuis la gauche');
    ok(!WxfMatches(ParseWxfMove('C2=5'), 'h2', 'e2', 'c', false, 9),
       'et la casse de la lettre doit s\'accorder au camp');

    // Le dernier chiffre change de SENS selon la piece.
    ok(WxfMatches(ParseWxfMove('P7+1'), 'c3', 'c4', 'P', true, 9),
       'pion : « +1 » est un nombre de rangees');
    ok(WxfMatches(ParseWxfMove('H2+3'), 'h0', 'g2', 'H', true, 9),
       'cheval : « +3 » est la colonne d\'arrivee');
    ok(!WxfMatches(ParseWxfMove('H2+3'), 'h0', 'g2', 'H', false, 9),
       'et « + » avance dans le sens du camp, pas du plateau');
}

console.log('Test 20 - SAN, la notation des PGN d\'echecs');
{
    // Elle ressemble a la notation « occidentale » du chu shogi sans partager
    // ses regles, et les confondre coute cher : le « + » final est un ECHEC
    // ici, une promotion la-bas. « Qxd8+ » lu comme du chu shogi exige un coup
    // promouvant et n'en trouve aucun.
    ok(MoveFormat(['e4', 'e5', 'Nf3', 'O-O']) === 'san', 'une partie d\'echecs est reconnue');
    ok(MoveFormat(['+Hxe11', 'Tc11', '+Oxc7,b8']) === 'western',
       'et le chu shogi reste occidental');
    ok(ParseSanMove('Qxd8+').promotion === null, 'le « + » final n\'est pas une promotion');

    // Les formes que le lecteur occidental ne connaissait pas.
    ok(ParseSanMove('Nbd2').fromFile === 'b', 'desambiguisation par colonne');
    ok(ParseSanMove('R1a3').fromRank === '1', 'et par rangee');
    ok(ParseSanMove('exf5').piece === '' && ParseSanMove('exf5').fromFile === 'e',
       'une prise de pion commence par sa colonne de depart, pas par une piece');
    ok(ParseSanMove('O-O').castle === 'K' && ParseSanMove('0-0-0').castle === 'Q',
       'les deux roques, dans leurs deux graphies');
    ok(ParseSanMove('e8=Q').promotion === 'Q', 'la promotion nomme la piece obtenue');
    ok(ParseSanMove('N@h5').drop === true, 'et le parachutage du crazyhouse');
    ok(ParseSanMove('Rje1').fromFile === 'j',
       'les colonnes au-dela de « h » : les variantes ont des plateaux plus larges');

    // La resolution compare le SAN a la notation de jocly. La PIECE se lit
    // dans l'abreviation que jocly ecrit, PAS sur le plateau : le FEN du
    // crazyhouse compte deux colonnes de reserve de chaque cote, qui ne
    // portent pas de nom de case et decalent toute lecture du plateau.
    const M = (san, nat) => SanMatches(ParseSanMove(san), nat, null, { game: 'classic-chess' });
    ok(M('Nbd2', 'Nb1-d2') && !M('Nbd2', 'Ng1-d2'), 'la desambiguisation tranche');
    ok(M('exf5', 'e4xf5') && !M('exf5', 'e4-f5'), 'la prise doit correspondre');
    ok(M('e4', 'e2-e4') && !M('e4', 'Ne2-e4'), 'un pion n\'est pas un cavalier');
    ok(M('e8=Q', 'e7-e8=Q+') && !M('e8=Q', 'e7-e8=N'), 'la piece de promotion aussi');
    ok(M('O-O', 'O-O') && !M('O-O', 'O-O-O'), 'les deux roques ne se confondent pas');
    ok(M('N@h5', 'N@h5') && !M('N@h5', 'P@h5'), 'le parachutage nomme sa piece');
}

console.log('Test 21 - commentaires de ligne « ; … »');
{
    // La seconde forme de commentaire autorisee par la specification PGN, et
    // celle que chessops traite explicitement (« if (token === ';') return »).
    // Sans elle, chaque mot du commentaire devient un faux coup, donne a
    // pickMove, et joue comme le coup le plus ressemblant.
    const pgn = '[Event "x"]\n\n; un commentaire de ligne\n1. e4 e5 ; jusqu\'au bout\n2. Nf3 *';
    ok(ExtractMoves(pgn).join(' ') === 'e4 e5 Nf3', 'les deux formes sont ecartees');
    ok(!ExtractMoves(pgn).includes(';'), 'et le point-virgule lui-meme ne reste pas');

    // Le fichier d'exemples de variantes s'ouvre sur « ; variants-examples.pgn ».
    const file = fixture('fixtures/pychess/variants.pgn');
    const blocks = file.replace(/\r\n?/g, '\n').split('\n\n').map(b => b.trim()).filter(Boolean);
    const first = blocks.findIndex(b => b.startsWith('['));
    let j = first + 1;
    while (j < blocks.length && !blocks[j].startsWith('[')) j++;
    const moves = ExtractMoves([blocks[first], ...blocks.slice(first + 1, j)].join('\n\n'));
    ok(!moves.some(m => /^;|examples|Sources|IMPORTANT/.test(m)),
       'aucun mot des commentaires du fichier reel ne passe pour un coup');
    ok(moves[0] === 'f5', 'et le premier coup est bien le premier coup — ' + moves.slice(0, 3).join(' '));
}

console.log('Test 22 - le chancelier, « C » ailleurs et « M » chez jocly');
{
    // La piece qui combine tour et cavalier n'a pas de nom unique :
    // chessvariants et PyChess l'appellent chancellor et l'ecrivent « C »,
    // jocly la nomme marshall et ecrit « M ». Meme piece, meme case, deux
    // lettres — et un FEN parfaitement valide refuse.
    const jocly = 'rnabqkbmnr/pppppppppp/10/10/10/10/PPPPPPPPPP/RNABQKBMNR w KQkq - 0 1';
    const foreign = jocly.replace(/[mM]/g, (c) => (c === 'M' ? 'C' : 'c'));
    ok(VariantFen(foreign, 'capablanca-chess') === jocly,
       'la position de depart de Capablanca fait l\'aller-retour');
    ok(VariantFen(jocly, 'capablanca-chess') === jocly,
       'et un FEN deja jocly ne bouge pas');

    // La conversion est nominative, pas generale : « c » designe le canon au
    // xiangqi et le chameau ailleurs. L'appliquer partout casserait plus
    // qu'elle ne repare.
    ok(VariantFen('1c5c1/9 w - - 0 1', 'xiangqi').includes('1c5c1'),
       'le canon du xiangqi n\'est pas touche');
    ok(VariantFen(foreign, 'classic-chess') === foreign,
       'ni aucun jeu hors de la liste');

    // Le meme desaccord dans les COUPS : « Ch2 » dans le fichier, « Mh1-h2 »
    // chez jocly. Sans l'alias, une partie de Grand Chess s'arrete au premier
    // coup de chancelier.
    ok(SanMatches(ParseSanMove('Ci10'), 'Mi1-i10', null, { game: 'grand-chess' }),
       'le chancelier des fichiers correspond au marshall de jocly');
    ok(!SanMatches(ParseSanMove('Ci10'), 'Qi1-i10', null, { game: 'grand-chess' }),
       'mais l\'alias ne rend pas les pieces interchangeables');
}

console.log('Test 23 - le pion nomme (xiangqi de PyChess, shogi occidentalise)');
{
    // Aux echecs le pion n'est jamais nomme : « e4 ». PyChess ecrit « Pg6 »
    // pour le xiangqi, et le shogi occidentalise « P-4d ». Sans « P » parmi
    // les lettres de piece, ces jetons ne se lisaient pas du tout — et comme
    // la detection exige que TOUS se lisent, une seule poussee de pion faisait
    // retomber la partie entiere sur la resolution floue.
    ok(ParseSanMove('Pg6')?.piece === 'P', '« Pg6 » nomme son pion');
    ok(ParseSanMove('e4')?.piece === '', 'et « e4 » n\'en nomme toujours pas');

    // Deux vraies parties de PyChess, l'une avec des poussees de pion.
    for (const name of ['fixtures/pychess/xiangqi-pychess-1.pgn', 'fixtures/pychess/xiangqi-pychess-2.pgn']) {
        const moves = ExtractMoves(fixture(name));
        ok(moves.length > 30, `${name} : ${moves.length} coups extraits`);
        ok(moves.every(mv => ParseSanMove(mv)), 'tous se lisent');
        ok(MoveFormat(moves) === 'san', 'et la partie est reconnue comme du SAN');
    }
}

console.log('Test 24 - SAN du xiangqi : separateur absent et rangees decalees');
{
    // Deux ecarts entre ce qu'ecrit PyChess et ce qu'ecrit jocly, et aucun
    // n'est visible dans le fichier :
    //   PyChess  Hc3     piece nommee, rangees comptees a partir de 1
    //   jocly    b0c2    ni abreviation ni separateur, rangees a partir de 0
    const M = (san, nat, letter, offset) =>
        SanMatches(ParseSanMove(san), nat, letter ? () => letter : null, { rankOffset: offset });

    ok(M('Hc3', 'b0c2', 'H', 1), 'le cavalier de b1 arrive en c3 — soit « b0c2 » chez jocly');
    ok(!M('Hc3', 'h0g2', 'H', 1), 'et pas n\'importe quel autre cavalier');
    ok(!M('Hc3', 'b0c2', 'H', 0), 'sans le decalage, la case ne correspond plus');
    ok(M('Rxc10', 'c0c9', 'R', 1), 'la prise se resout, bien que jocly ne la marque pas');
    ok(!M('Hc3', 'b0c2', 'C', 1), 'la lettre du plateau identifie la piece — un canon n\'est pas un cavalier');

    // Le decalage n'est pas impose aux echecs, ou jocly et le SAN s'accordent.
    ok(M('Nbd2', 'Nb1-d2', null, 0) && !M('Nbd2', 'Nb1-d2', null, 1),
       'aux echecs le decalage est nul, et l\'appliquer casserait tout');

    // Cinq vraies parties de PyChess, dont une de cent demi-coups.
    for (const name of ['fixtures/pychess/xiangqi-pychess-1.pgn', 'fixtures/pychess/xiangqi-pychess-2.pgn',
                        'fixtures/pychess/xiangqi-ltlswqlc.pgn', 'fixtures/pychess/xiangqi-LULQPutT.pgn',
                        'fixtures/pychess/xiangqi-NrmGxFe1.pgn']) {
        const moves = ExtractMoves(fixture(name));
        ok(moves.length > 20 && moves.every(mv => ParseSanMove(mv)) && MoveFormat(moves) === 'san',
           `${name} : ${moves.length} coups, tous lus, reconnus comme SAN`);
    }
}

console.log('Test 25 - PGN de PyChess : toutes les variantes se LISENT');
{
    // Enumerer les lettres de piece revenait a tenir la liste de toutes les
    // variantes du monde : le shogi a S et G, le tori F et C, le makruk S et
    // M. Chaque oubli faisait retomber une partie entiere sur la resolution
    // floue -- un seul « Sd7 » suffisait. N'importe quelle MAJUSCULE nomme
    // donc une piece ; la casse suffit a la distinguer d'une colonne.
    for (const name of ['fixtures/pychess/shako.pgn', 'fixtures/pychess/makruk.pgn',
                        'fixtures/pychess/shogi.pgn', 'fixtures/pychess/mini.pgn']) {
        const moves = ExtractMoves(fixture(name));
        const unread = moves.filter(mv => !ParseSanMove(mv));
        ok(unread.length === 0,
           `${name} : ${moves.length} coups, tous lus`
           + (unread.length ? ' -- ' + unread.slice(0, 4).join(' ') : ''));
        ok(MoveFormat(moves) === 'san', name + ' : reconnue comme du SAN');
    }
    ok(ParseSanMove('Sd7')?.piece === 'S' && ParseSanMove('Fxe5')?.piece === 'F',
       'argent du shogi et faucon du tori');
    ok(ParseSanMove('exf5')?.piece === '' && ParseSanMove('exf5')?.fromFile === 'e',
       'mais une minuscule reste une colonne, pas une piece');

    // MAKRUK : PyChess nomme les pieces d'apres le thai, jocly reprend les
    // lettres des echecs. Sans traduction, le plateau charge AMPUTE -- sans
    // roi -- et jocly se plante en cherchant les attaquants d'une case qui
    // n'existe pas.
    const thai = 'rnsmksnr/8/pppppppp/8/8/PPPPPPPP/8/RNSKMSNR w - - 0 1';
    ok(VariantFen(thai, 'makruk').split(' ')[0] === 'rnbqkbnr/8/pppppppp/8/8/PPPPPPPP/8/RNBKQBNR',
       'khon et met traduits en fou et dame -- ' + VariantFen(thai, 'makruk').split('/')[0]);
    ok(VariantFen(thai, 'classic-chess') === thai, 'et rien pour un autre jeu');
}

console.log('Test 26 - la promotion du shogi : « =G » nomme un MOUVEMENT');
{
    // PyChess ecrit « =G » pour un pion, une lance, un cavalier OU un argent
    // promus : tous se deplacent comme un or. Son propre convertisseur le dit
    // -- « PyChess PGN forgets the unpromoted version of the piece ». La
    // lettre ne designe donc aucun type, et la comparer au « =+S » de jocly
    // refuserait un coup parfaitement identifie.
    //
    // Ce qui compte est le seul fait de promouvoir, que l'appelant lit dans
    // l'USI de jocly, dont le « + » final est sans ambiguite.
    // Le jeu est desormais indispensable : la table d'alias est par jeu.
    const M = (san, nat, promoted) =>
        SanMatches(ParseSanMove(san), nat, null,
                   promoted === undefined ? { game: 'shogi' } : { promoted, game: 'shogi' });

    ok(M('Rxg8=D', 'Rh8xg8', true), '« =D » accepte un coup qui promeut');
    ok(!M('Rxg8=D', 'Rh8xg8', false), 'et refuse le meme coup sans promotion');
    ok(M('Rxg8', 'Rh8xg8', false) && !M('Rxg8', 'Rh8xg8', true),
       'reciproquement, sans suffixe le coup ne doit pas promouvoir');

    // Aux echecs la lettre designe bien un type, et la sous-promotion doit se
    // distinguer : la comparaison de lettre reste faite quand l'appelant ne
    // repond pas.
    ok(M('e8=Q', 'e7-e8=Q+') && !M('e8=Q', 'e7-e8=N'),
       'une sous-promotion d\'echecs reste distinguee');

    const moves = ExtractMoves(fixture('fixtures/pychess/shogi-promotions.pgn'));
    ok(moves.length === 66, `${moves.length} coups lus`);
    ok(moves.filter(mv => /=/.test(mv)).length === 6, 'dont six promotions');
    ok(moves.filter(mv => /@/.test(mv)).length > 5, 'et des parachutages');
    ok(MoveFormat(moves) === 'san', 'la partie est reconnue comme du SAN');
}

console.log('Test 27 - Capablanca, une vraie partie de PyChess');
{
    // Le prelude de jocly -- les dix dispositions 10x8 -- compte pour un coup,
    // et il est desormais saute quand la position est fournie. Restait la
    // lettre : le fichier ecrit « C » (chancellor), jocly « M » (marshall).
    const moves = ExtractMoves(fixture('fixtures/pychess/capablanca.pgn'));
    ok(moves.length === 91, `${moves.length} demi-coups lus`);
    ok(MoveFormat(moves) === 'san', 'reconnus comme du SAN');
    ok(moves.some(mv => /^C/.test(mv)), 'la partie fait jouer le chancelier');
    ok(SanMatches(ParseSanMove('Cg3'), 'Mh1-g3', null, { game: 'capablanca-chess' }),
       'qui correspond au marshall de jocly');
    ok(moves.some(mv => /^O-O/.test(mv)), 'et elle contient un roque');
}

console.log('Test 28 - une lettre de fichier, plusieurs pieces de jocly');
{
    // PyChess nomme les pieces par leur MOUVEMENT, jocly par leur type. La
    // correspondance n'est donc pas un a un :
    //
    //   E   l'elephant ivre du Sho Shogi, que jocly abrege « DE »
    //   H   le cheval-dragon : un fou promu, « +B »
    //   D   le dragon : une tour promue, « +R »
    //   G   l'or ET toute piece promue qui se deplace comme lui
    //
    // Cette derniere est la plus surprenante, et c'est le convertisseur de
    // PyChess lui-meme qui la documente : « PyChess PGN forgets the
    // unpromoted version of the piece ».
    const M = (san, nat) => SanMatches(ParseSanMove(san), nat, null, { game: 'kotaishi-shogi' });
    ok(M('Ed2', 'DEe1-d2'), 'E designe l\'elephant ivre');
    ok(M('Ha8', '+Bb7-a8'), 'H le fou promu');
    ok(M('Dc3', '+Rc1-c3'), 'D la tour promue');
    ok(M('Gd8', 'Gd7-d8') && M('Gd8', '+Pd7-d8') && M('Gd8', '+Sd7-d8'),
       'G l\'or, mais aussi le pion et l\'argent promus');
    ok(!M('Gd8', 'Sd7-d8'), 'sans pour autant accepter un argent NON promu');
    ok(SanMatches(ParseSanMove('Cg3'), 'Mh1-g3', null, { game: 'capablanca-chess' }),
       'et le chancelier reste le marshall');

    const moves = ExtractMoves(fixture('fixtures/pychess/shoshogi.pgn'));
    ok(moves.length === 108, `${moves.length} demi-coups lus`);
    ok(MoveFormat(moves) === 'san', 'reconnus comme du SAN');
    ok(moves.some(mv => /^E/.test(mv)) && moves.some(mv => /^G/.test(mv)),
       'la partie fait jouer l\'elephant et l\'or');
}

console.log('Test 29 - l\'hoplite du Spartan, que jocly cesse de nommer');
{
    // jocly abrege l'hoplite « H » tant qu'il est sur sa case de depart, et
    // plus rien ensuite : les deux etats sont deux types de pieces, et seul le
    // premier porte une abreviation. PyChess, lui, ecrit « H » du debut a la
    // fin.
    //
    // L'abreviation VIDE est donc une reponse comme une autre, et non le seul
    // signe d'un pion.
    const M = (san, nat) => SanMatches(ParseSanMove(san), nat, null, { game: 'spartan-chess' });
    ok(M('Hxd4', 'Hd5xd4'), 'un hoplite qui n\'a pas bouge');
    ok(M('Hxd4', 'd5xd4'), 'et le meme une fois qu\'il a bouge');
    ok(M('e4', 'e2-e4'), 'le pion, que jocly ne nomme jamais');
    ok(!M('Nf3', 'e2-e4'), 'sans que l\'abreviation vide accepte n\'importe quoi');

    const moves = ExtractMoves(fixture('fixtures/pychess/spartan.pgn'));
    ok(moves.length > 30, `${moves.length} demi-coups lus`);
    ok(MoveFormat(moves) === 'san', 'reconnus comme du SAN');
    ok(moves.some(mv => /^H/.test(mv)), 'la partie fait jouer les hoplites');
}

console.log('Test 30 - le janggi partage les lettres du xiangqi');
{
    // Meme plateau, memes pieces, meme convention : PyChess ecrit le cavalier
    // « n » et l'elephant « b », jocly « h » et « e ». Sans traduction, le FEN
    // est refuse et le fichier n'ouvre rien.
    const py = 'rbna1abnr/4k4/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/4K4/RBNA1ABNR w - - 0 1';
    // « rbna » devient « reha » : b→e et n→h, chacun a sa place.
    ok(VariantFen(py, 'janggi').split('/')[0] === 'reha1aehr',
       'cavaliers et elephants traduits — ' + VariantFen(py, 'janggi').split('/')[0]);
    ok(VariantFen(py, 'janggi').endsWith(' w - - 0 1'), 'et les autres champs sont intacts');
    ok(VariantFen(py, 'classic-chess') === py, 'rien pour un jeu qui n\'est pas concerne');

    const moves = ExtractMoves(fixture('fixtures/pychess/janggi.pgn'));
    ok(moves.length === 40, `${moves.length} demi-coups lus`);
    ok(MoveFormat(moves) === 'san', 'reconnus comme du SAN');
}

console.log('Test 31 - la table d\'alias est ORGANISEE PAR JEU');
{
    // La meme lettre designe des pieces differentes selon la variante, et une
    // entree valable pour l'une est fausse pour l'autre. « H » vaut le
    // cheval-dragon au shogi et l'hoplite au Spartan, que jocly cesse de
    // nommer une fois qu'il a bouge. Une table commune faisait correspondre
    // « Hf6 » a la fois au fou promu et a un pion : deux candidats, donc un
    // refus, et une partie de Sho Shogi bloquee au 65e coup.
    const M = (san, nat, game) => SanMatches(ParseSanMove(san), nat, null, { game });

    ok(M('Hf6', '+Bg5-f6', 'shogi'), 'shogi : H est le cheval-dragon');
    ok(!M('Hf6', 'f7-f6', 'shogi'), 'et surtout PAS un pion');
    ok(M('Hxd4', 'Hd5xd4', 'spartan-chess') && M('Hxd4', 'd5xd4', 'spartan-chess'),
       'Spartan : H est l\'hoplite, nomme ou non');
    ok(!M('Hxd4', 'd5xd4', 'shogi'), 'la meme lettre ne franchit pas les jeux');

    ok(M('Sd7', 'Bc8-d7', 'makruk'), 'makruk : S est le khon, le fou de jocly');
    ok(M('Sxe5', 'd6xe5', 'tori-shogi'), 'tori : S est l\'hirondelle, que jocly ne nomme pas');
    ok(!M('Sd7', 'Bc8-d7', 'shogi'), 'et l\'argent du shogi n\'est ni l\'un ni l\'autre');

    // Les alias valent aussi pour la piece OBTENUE et pour les parachutages.
    ok(M('dxe3=M', 'd4xe3=Q', 'makruk'), 'le met du makruk devient la dame de jocly');
    ok(M('e8=Q', 'e7-e8=Q', 'classic-chess') && !M('e8=Q', 'e7-e8=N', 'classic-chess'),
       'sans confondre les sous-promotions aux echecs');
    // Les parachutages nomment parfois AUTREMENT que les deplacements : au
    // tori, jocly laisse l'hirondelle sans abreviation quand elle se deplace
    // et ecrit « P@e6 » quand on la parachute. Une table distincte, donc --
    // etendre l'alias de deplacement ferait aussi correspondre « Sxe5 » aux
    // coups du faisan, dont l'abreviation est justement « P ».
    ok(M('S@c4', '@c4', 'tori-shogi'), 'un parachutage dont jocly ne nomme pas la piece');
    // jocly nomme desormais l'hirondelle par sa lettre FEN au parachutage
    // (« S@e6 »), au lieu d'un « P » de repli qui la confondait avec le
    // faisan — deux coups legaux portaient le meme nom.
    ok(M('S@e6', 'S@e6', 'tori-shogi'), 'et celui qu\'il nomme par sa lettre FEN');
    ok(!M('S@e6', 'P@e6', 'tori-shogi'), 'le faisan restant distinct');
    ok(!M('Sxe5', 'Pd6xe5', 'tori-shogi'), 'sans confondre les DEPLACEMENTS du faisan');
    ok(!M('N@h5', 'P@h5', 'crazyhouse'), 'ni les parachutages d\'un autre jeu');

    const moves = ExtractMoves(fixture('fixtures/pychess/makruk.pgn'));
    ok(moves.length === 76 && MoveFormat(moves) === 'san',
       `${moves.length} demi-coups de makruk, reconnus comme du SAN`);
}

console.log('Test 32 - Kyoto Shogi : deux faces, et « =X » n\'est pas une promotion');
{
    // Chaque piece a deux faces et se retourne a CHAQUE coup. PyChess note la
    // face obtenue -- ce n'est pas un choix mais une consequence -- tandis que
    // jocly nomme le TYPE qui joue, sa face « promue » portant un « + ».
    //
    // La meme partie dans les deux notations (fixtures/pychess/kyoto.pgn et
    // fixtures/chushogilite/kyoto-jocly.pjn) donne la correspondance :
    //
    //   Ge2=N   +Nd1-e2      l'or est la face promue du cavalier...
    //   Gd4=L   +Le5-d4      ...et aussi celle de la lance
    //   Rxa3=P  +Pa4xa3      la tour, celle du pion
    //   Sc4=B   Sd5-c4+      l'argent devient fou, que jocly ne nomme pas
    const M = (san, nat) => SanMatches(ParseSanMove(san), nat, null, { game: 'kyoto-shogi' });
    ok(M('Ge2=N', '+Nd1-e2'), 'l\'or, face promue du cavalier');
    ok(M('Gd4=L', '+Le5-d4'), 'et aussi de la lance — deux pieces, un meme deplacement');
    ok(M('Rxa3=P', '+Pa4xa3'), 'la tour, face promue du pion');
    ok(M('Sc4=B', 'Sd5-c4+'), 'et l\'argent, que jocly laisse sans « + »');
    // Au parachutage, la FACE posee fait partie de l'identite du coup :
    // jocly la marque d'un « + » final depuis qu'elle figure dans sa
    // notation, sans quoi les deux faces s'ecrivaient pareil.
    ok(M('B@c2+', 'S@c2+'), 'le fou est l\'argent pose sur sa face promue');
    ok(!M('B@c2+', 'S@c2'), 'et non sur l\'autre');

    // Le suffixe ne se compare a rien : jocly ne marque le « + » que vers la
    // face promue, donc la moitie des coups serait refusee.
    ok(M('Pa4=R', 'a5-a4+') && M('Ld2=G', 'Ld4-d2+'),
       'le suffixe de face n\'est pas confronte au « + » de jocly');

    // Les deux fichiers decrivent bien la meme partie.
    const py = ExtractMoves(fixture('fixtures/pychess/kyoto.pgn'));
    const jo = ExtractMoves(fixture('fixtures/chushogilite/kyoto-jocly.pjn'));
    ok(py.length === jo.length && py.length === 28,
       `${py.length} demi-coups de part et d'autre`);
    ok(MoveFormat(py) === 'san' && MoveFormat(jo) === 'natural',
       'l\'un est du SAN, l\'autre la notation de jocly');
}

console.log('Test 33 - Shatranj : deux pieces qui n\'ont des echecs que la lettre');
{
    // PyChess garde « b » et « q », mais l'alfil n'est pas un fou -- il saute
    // de deux cases en diagonale -- et le firz n'est pas une dame : il ne va
    // que d'une case. jocly les nomme d'apres ce qu'elles SONT, elephant et
    // general, d'ou une traduction dans les deux sens.
    const py = 'rnbkqbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBKQBNR w - - 0 1';
    ok(VariantFen(py, 'shatranj-chess').split(' ')[0] === 'rnekgenr/pppppppp/8/8/8/8/PPPPPPPP/RNEKGENR',
       'le FEN traduit — ' + VariantFen(py, 'shatranj-chess').split('/')[0]);
    ok(VariantFen(py, 'classic-chess') === py, 'et rien pour les echecs, ou b et q sont bien fou et dame');

    const M = (san, nat) => SanMatches(ParseSanMove(san), nat, null, { game: 'shatranj-chess' });
    ok(M('Be3', 'Ec1-e3'), 'le fou du fichier est l\'elephant de jocly');
    ok(M('Qd7', 'Ge8-d7'), 'et la dame son general');
    ok(M('Nf3', 'Ng1-f3') && M('e4', 'e2-e4'), 'les autres pieces ne bougent pas');
    ok(!SanMatches(ParseSanMove('Be3'), 'Ec1-e3', null, { game: 'classic-chess' }),
       'la traduction ne franchit pas les jeux');

    const moves = ExtractMoves(fixture('fixtures/pychess/shatranj.pgn'));
    ok(moves.length === 119 && MoveFormat(moves) === 'san',
       `${moves.length} demi-coups, reconnus comme du SAN`);
}

console.log('');
console.log(`RESULTAT book-formats: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
