// tests/import/test-seirawan.mjs — le S-Chess (Seirawan++) : ecrire et relire.
//
// CE QUI SE JOUE ICI. Le Seirawan++ a deux particularites qu'aucun autre jeu
// du catalogue ne cumule :
//
//   - une ENTREE de piece attachee au coup (« Bb7/E »), et au roque une case
//     a designer (« O-O/He1 »), puisque deux cases s'y liberent ;
//   - un PRELUDE qui choisit la paire de pieces, donc les LETTRES : PyChess
//     ecrit H(awk) et E(lephant) la ou jocly ecrit C(ardinal) et M(arshall),
//     et cette correspondance ne vaut que pour l'arrangement 0.
//
// Les trois epreuves, dans l'ordre ou elles cassent :
//   1. le fichier de PyChess se rejoue coup pour coup, et se REECRIT a
//      l'identique -- c'est l'interoperabilite, pas mon interpretation ;
//   2. une partie jouee ici s'exporte en PGN et se recharge sur les memes
//      coups, dans deux arrangements (les lettres changent, pas le reste) ;
//   3. la meme chose en PJN, ou les coups sont la notation de jocly -- y
//      compris les jetons qu'un jocly anterieur ecrivait.
//
// Usage : node tests/import/test-seirawan.mjs
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { BookFen, BookVariant, ExtractMoves, MoveFormat, FairyVariantAlias, FairyGameIndex,
         ParseSanMove, SanMatches, BuildSanMove, ParseNaturalMove, ReplayBookMoves,
         SChessFen, NormalizeBookFen, NormalizeSChessNatural, BuildPJN } from '../../app/content/book-format.js';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const J = require(path.join(root, 'dist/node/jocly.core.js'));

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };

const GAME = 'seirawan-chess';
const names = Object.keys(await J.listGames());
const cfg = {}; for (const n of names) cfg[n] = await J.getGameConfig(n).catch(() => null);
const idx = FairyGameIndex(cfg);

// Ce que play.js appelle FairyProfile : le nom de variante et les lettres de
// l'arrangement joue, lus dans le manifeste du jeu.
function profile(setup) {
    const level = (cfg[GAME]?.model?.levels || []).find(l => l?.ai === 'fairy-stockfish');
    const v = (level?.variants || []).find(x => x?.setup === setup) || {};
    return { variant: v.pgnVariant || v.variant || null, pieceMap: v.pieceMap || null };
}

// La lettre portee par chaque case (BoardLetters de play.js, sans decalage).
function letters(fen) {
    const rows = String(fen || '').split(' ')[0].split('/');
    const map = {};
    rows.forEach((row, i) => {
        const rank = rows.length - i;
        let file = 0;
        for (let k = 0; k < row.length;) {
            const c = row[k];
            if (c >= '0' && c <= '9') { let n = c; while (row[k+1] >= '0' && row[k+1] <= '9') n += row[++k]; file += +n; k++; continue; }
            let piece = c; k++;
            if (row[k] === '!') k++;          // une piece en attente : « C! »
            map[String.fromCharCode(97 + file) + rank] = piece; file++;
        }
    });
    return (sq) => map[sq] || null;
}

async function started(setup) {
    const m = await J.createMatch(GAME);
    for (let d = 0; d < 4; d++) {
        const list = await m.getPossibleMoves();
        const said = await m.getMoveString(list);
        if (!/^(#\d+|--)$/.test(said[0] || '')) break;
        const want = said.indexOf('#' + setup);
        await m.playMove(list[want >= 0 ? want : 0]);
    }
    return m;
}

// Resolution EXACTE d'un jeton SAN, comme MoveFromSan dans play.js.
async function sanResolve(m, token, pieceMap) {
    const parsed = ParseSanMove(token);
    if (!parsed) return null;
    const mv = await m.getPossibleMoves();
    const nat = await m.getMoveString(mv);
    const at = letters(await m.getBoardState());
    let found = null;
    for (let i = 0; i < mv.length; i++) {
        if (!SanMatches(parsed, nat[i], at, { game: GAME, pieceMap })) continue;
        if (found) return null;             // ambigu : on refuse plutot que deviner
        found = mv[i];
    }
    return found;
}

// Reecriture d'un coup en SAN, comme WesternGame dans play.js.
async function sanWrite(m, index, pieceMap) {
    const mv = await m.getPossibleMoves();
    const nat = await m.getMoveString(mv);
    const at = letters(await m.getBoardState());
    const mine = ParseNaturalMove(nat[index]) || { steps: [] };
    const letter = mine.from ? at(mine.from) : null;
    const rivals = [];
    for (let i = 0; i < mv.length; i++) {
        if (i === index) continue;
        const other = ParseNaturalMove(nat[i]);
        if (!other || other.steps.length !== mine.steps.length) continue;
        if (!other.steps.every((st, k) => st.square === mine.steps[k].square)) continue;
        if (other.from && other.from !== mine.from && at(other.from) === letter) rivals.push(other.from);
    }
    const mapped = pieceMap ? (sq) => { const raw = at(sq); if (!raw) return raw;
        const up = raw.toUpperCase(); return pieceMap[up] || up; } : at;
    return BuildSanMove(nat[index], rivals, GAME, {
        letterAt: mapped, pieceMap,
        capture: mv[index].c !== null && mv[index].c !== undefined,
    });
}

// ── 1. Le fichier de PyChess ────────────────────────────────────────────────
{
    const text = readFileSync(path.join(root, 'tests/fixtures/pychess/seirawan.pgn'), 'utf8');
    const tags = {};
    for (const l of text.split('\n')) { const m = /^\s*\[(\S+)\s+(.*)\]\s*$/.exec(l.trim()); if (m) tags[m[1]] = m[2].replace(/^"|"$/g, ''); }

    const hit = idx[FairyVariantAlias(BookVariant(tags))];
    ok(hit?.game === GAME && hit?.setup === 0,
       '[Variant "Seirawan"] designe ' + hit?.game + ', arrangement ' + hit?.setup);

    // Le [FEN] de PyChess : la poche « [HEhe] » est dans SON alphabet. jocly
    // lit cette forme, mais avec ses lettres a lui.
    const { pieceMap: mapped } = profile(hit.setup);
    const board = NormalizeBookFen(BookFen(tags), GAME, mapped);
    ok(/\[CMcm\]/.test(board), 'le [FEN] de PyChess est traduit dans l\'alphabet de jocly');
    const loaded = await J.createMatch(GAME);
    await loaded.load({ game: GAME, initialBoard: board, playedMoves: [] });
    ok((await loaded.getBoardState()).startsWith('rnbqkbnr/pppppppp'),
       'et jocly l\'ouvre tel quel, sans repasser par le prelude');
    // Sans traduction, « H » et « E » sont le phenix du chu et l'elephant du
    // shako : deux arrangements differents. jocly refuse plutot que d'ouvrir
    // une partie plausible et fausse.
    let refused = null;
    try {
        const trial = await J.createMatch(GAME);
        await trial.load({ game: GAME, initialBoard: BookFen(tags), playedMoves: [] });
    } catch (e) { refused = e; }
    ok(!!refused, 'le meme [FEN] non traduit est refuse, et non ouvert de travers');

    const tokens = ExtractMoves(text);
    ok(MoveFormat(tokens) === 'san', 'les coups sont lus comme du SAN (' + tokens.length + ' jetons)');

    const { pieceMap } = profile(hit.setup);
    const m = await started(hit.setup);
    const written = [];
    const exact = async (tok) => {
        const move = await sanResolve(m, tok, pieceMap);
        if (!move) return null;
        const mv = await m.getPossibleMoves();
        written.push(await sanWrite(m, mv.findIndex(x => x === move), pieceMap));
        return move;
    };
    const r = await ReplayBookMoves(tokens, { pick: () => null, exact, play: (x) => m.playMove(x) });
    ok(r.unresolved === null && r.played === tokens.length,
       'seirawan.pgn rejoue ' + r.played + '/' + tokens.length
       + (r.unresolved ? ' — bloque sur « ' + r.unresolved + ' »' : ''));
    const diff = written.findIndex((w, i) => w !== tokens[i]);
    ok(diff < 0, 'et se reecrit a l\'identique'
       + (diff < 0 ? '' : ' — coup ' + (diff + 1) + ' : ' + written[diff] + ' au lieu de ' + tokens[diff]));
    // Le coup qui porte tout le poids du fichier : le roque avec entree.
    ok(written[6] === 'O-O/He1', 'le roque nomme la piece ET sa case : ' + written[6]);
}

// ── 2. Aller-retour PGN, dans deux arrangements ─────────────────────────────
//
// Une partie fabriquee ici, qui contient tout ce qui peut mal s'ecrire : deux
// entrees ordinaires, un roque avec entree, et un echec donne par une piece
// qui laisse sa case ouverte.
const GAMES = [
    { setup: 0, variant: 'seirawan',
      moves: ['g2-g3', 'b7-b6', 'Ng1-f3', 'Bc8-b7/M', 'Bf1-g2', 'Ng8-f6/C', 'O-O/Ce1', 'Mc8-d6',
              'd2-d3', 'Cg8-h6'] },
    // L'arrangement 4 (chu) : le phenix s'ecrit « H » chez jocly aussi, et le
    // kirin « I ». Aucune correspondance de lettres : c'est le cas ou une
    // table ecrite par jeu se tromperait.
    { setup: 4, variant: 'jocly-seirawan-chu',
      moves: ['g2-g3', 'b7-b6', 'Ng1-f3', 'Bc8-b7/I', 'Bf1-g2', 'Ng8-f6/H', 'O-O/He1', 'Ic8-c6'] },
];
for (const spec of GAMES) {
    const { variant, pieceMap } = profile(spec.setup);
    ok(variant === spec.variant, 'arrangement ' + spec.setup + ' : [Variant "' + variant + '"]');

    const m = await started(spec.setup);
    const tokens = [];
    for (const want of spec.moves) {
        const mv = await m.getPossibleMoves();
        const nat = await m.getMoveString(mv);
        const i = nat.indexOf(want);
        if (i < 0) { ok(false, 'coup introuvable : ' + want); break; }
        tokens.push(await sanWrite(m, i, pieceMap));
        await m.playMove(mv[i]);
    }
    const played = (await m.getPlayedMoves()).length;
    ok(tokens.length === spec.moves.length && tokens.every(Boolean),
       'arrangement ' + spec.setup + ' : ' + tokens.length + ' coups ecrits — ' + tokens.join(' '));

    // Relecture : le fichier produit doit rejouer LA MEME partie. Comparer les
    // coups un a un, et pas seulement leur nombre : un jeton sous-specifie se
    // resout sur un autre coup sans rien dire.
    const back = await started(spec.setup);
    const r = await ReplayBookMoves(tokens, {
        pick: () => null,
        exact: (tok) => sanResolve(back, tok, pieceMap),
        play: (x) => back.playMove(x),
    });
    const same = JSON.stringify(await back.getPlayedMoves()) === JSON.stringify(await m.getPlayedMoves());
    ok(r.unresolved === null && r.played === tokens.length && same,
       'arrangement ' + spec.setup + ' : relu ' + r.played + '/' + tokens.length
       + (same ? ', coups identiques' : ', MAIS une autre partie')
       + (r.unresolved ? ' — bloque sur « ' + r.unresolved + ' »' : ''));
    void played;
}

// ── 3. Aller-retour PJN (la notation de jocly) ──────────────────────────────
{
    const m = await started(0);
    // Une entree qui donne echec, une prise, puis une seconde entree : les
    // trois formes que la notation doit distinguer.
    const seq = ['e2-e4', 'f7-f6', 'Qd1-h5/C+', 'g7-g6', 'Qh5xg6+', 'h7xg6', 'Ng1-f3/M'];
    for (const want of seq) {
        const mv = await m.getPossibleMoves();
        const nat = await m.getMoveString(mv);
        const i = nat.indexOf(want);
        if (i < 0) { ok(false, 'coup introuvable : ' + want + ' parmi ' + nat.join(' ')); break; }
        await m.playMove(mv[i]);
    }
    // Ce que la fenetre Historique ecrit : les coups joues, reponse au prelude
    // comprise (« #0 -- »), dans la notation de jocly.
    const pjnMoves = await m.getMoveString(await m.getPlayedMoves());
    const text = BuildPJN(GAME, pjnMoves, null, new Date(), { event: 'seirawan' });
    const tokens = ExtractMoves(text);
    ok(MoveFormat(tokens) === 'natural', 'un PJN de S-Chess reste en notation naturelle');
    ok(tokens[0] === '#0' && tokens[1] === '--', 'la reponse au prelude est ecrite : ' + tokens.slice(0, 2).join(' '));

    // Relecture, comme play.js : les jetons du prelude d'abord, puis pickMove.
    const back = await J.createMatch(GAME);
    const queue = tokens.slice();
    const recorded = [];
    while (queue.length && /^(#\d+|--)$/.test(queue[0])) recorded.push(queue.shift());
    for (const want of recorded) {
        const mv = await back.getPossibleMoves();
        const nat = await back.getMoveString(mv);
        await back.playMove(mv[Math.max(0, nat.indexOf(want))]);
    }
    const r = await ReplayBookMoves(queue, {
        pick: (s) => back.pickMove(s).catch(() => null),
        exact: null,
        play: (x) => back.playMove(x),
    });
    const same = JSON.stringify(await back.getPlayedMoves()) === JSON.stringify(await m.getPlayedMoves());
    ok(r.unresolved === null && same,
       'PJN relu : ' + r.played + '/' + queue.length + (same ? ', coups identiques' : ', MAIS une autre partie'));

    // Les jetons d'un jocly anterieur, ou l'echec passait AVANT l'entree et
    // ou la piece se « promouvait » en elle-meme.
    ok(NormalizeSChessNatural('Qd1-h5=C+/C') === 'Qd1-h5/C+', 'ancien jeton avec entree, remis en forme');
    ok(NormalizeSChessNatural('O-O=K+/Ce1') === 'O-O/Ce1+', 'ancien roque avec entree, remis en forme');
    ok(NormalizeSChessNatural('Qd1-h5=Q+') === 'Qd1-h5+', 'ancienne promotion factice, retiree');
    ok(NormalizeSChessNatural('e7-e8=Q') === 'e7-e8=Q', 'une VRAIE promotion n\'est pas touchee');
    ok(NormalizeSChessNatural('Nb1-c3/C') === 'Nb1-c3/C', 'un jeton actuel reste tel quel');

    const legacy = await started(0);
    await legacy.playMove((await legacy.getPossibleMoves())[
        (await legacy.getMoveString(await legacy.getPossibleMoves())).indexOf('e2-e4')]);
    await legacy.playMove((await legacy.getPossibleMoves())[
        (await legacy.getMoveString(await legacy.getPossibleMoves())).indexOf('f7-f6')]);
    const picked = await legacy.pickMove(NormalizeSChessNatural('Qd1-h5=C+/C'));
    const names2 = await legacy.getMoveString([picked]);
    ok(names2[0] === 'Qd1-h5/C+', 'et l\'ancien jeton rejoue le bon coup : ' + names2[0]);
}

// ── 4. Une position de MILIEU de partie, traduite et rechargee ──────────────
{
    // Une vraie position avancee, ecrite comme PyChess l'ecrirait : on joue,
    // on exporte, et on remet les lettres de SON alphabet (C -> H, M -> E).
    const src = await started(0);
    for (const want of ['g2-g3', 'b7-b6', 'Ng1-f3', 'Bc8-b7/M', 'Bf1-g2', 'Ng8-f6/C', 'O-O/Ce1']) {
        const mv = await src.getPossibleMoves();
        const nat = await src.getMoveString(mv);
        await src.playMove(mv[nat.indexOf(want)]);
    }
    const jocly = await src.getBoardState();
    const mid = jocly.replace(/\[([A-Za-z]*)\]/, (all, pocket) =>
        '[' + pocket.replace(/[CM]/g, (c) => (c === 'C' ? 'H' : 'E'))
                    .replace(/[cm]/g, (c) => (c === 'c' ? 'h' : 'e')) + ']');
    const board = NormalizeBookFen(mid, GAME, { C: 'H', M: 'E' });
    ok(board === jocly, 'la poche d\'une position avancee retrouve les lettres de jocly');
    const m = await J.createMatch(GAME);
    await m.load({ game: GAME, initialBoard: board, playedMoves: [] });
    const here = (await m.getMoveString(await m.getPossibleMoves())).sort();
    const there = (await src.getMoveString(await src.getPossibleMoves())).sort();
    ok(JSON.stringify(here) === JSON.stringify(there),
       'et la position rechargee offre exactement les memes coups');
    // Les deux pieces des Noirs sont entrees, et c'est a eux de jouer : aucune
    // entree ne doit etre proposee. La poche l'a dit, et elle a traverse.
    ok(!here.some(x => /\//.test(x)), 'un camp sans piece en poche n\'en fait entrer aucune');
    ok(/\[M\]/.test(await m.getBoardState()), 'celle de l\'adversaire attend toujours');

    ok(SChessFen('whatever', 'chess') === undefined, 'les autres jeux ne sont pas concernes');
    ok(NormalizeBookFen('rnbqkbnrc!m!/pppppppp2/10/10/10/10/PPPPPPPP2/RNBQKBNRC!M! w KQkq - 0 2',
        GAME, { C: 'H', M: 'E' }).indexOf('c!m!') > 0,
       'et l\'ancienne forme de jocly passe sans traduction');
}

console.log('');
console.log(`RESULTAT seirawan: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
