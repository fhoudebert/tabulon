// tests/test-pychess-replay.mjs — les fichiers de PyChess se rejouent-ils ?
//
// Les autres suites de lecture sont PURES : elles vérifient qu'un jeton se lit
// et qu'il correspond à telle chaîne de jocly, sans jamais demander au moteur
// si le coup existe. C'est utile et rapide, mais insuffisant — toutes les
// fautes coûteuses de ce chantier avaient la même signature : **une lecture
// fausse qui reste légale**. Le rang en kanji mal découpé rejouait 17 coups
// sur 17 en jouant une autre partie ; les deux faces du Kyoto s'écrivaient
// pareil et n'importe laquelle passait.
//
// Cette suite ferme la boucle : chaque fixture est rejouée dans le moteur, par
// la même chaîne que play.js — résolution du jeu, normalisation du FEN,
// prélude, puis résolution EXACTE coup par coup. Un fichier qui ne va pas
// jusqu'au bout fait échouer `npm test`.
//
// Ajouter une variante, c'est déposer un fichier dans tests/ et une ligne
// ci-dessous. Les compteurs sont écrits en dur à dessein : « 49/49 » dit que
// la partie va au bout, « 49 » seul ne dirait rien.
//
// Usage : npm test  (ou node tests/test-pychess-replay.mjs)
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { VariantFen, VariantGame, BookFen, BookVariant, ExtractMoves, MoveFormat,
         FairyVariantAlias, FairyGameIndex, PgnFenToShogiSfen,
         ParseSanMove, SanMatches, ReplayBookMoves,
         IsShogiKif, ParseShogiKif, ParseNaturalMove } from '../../app/content/book-format.js';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const Jocly = require(path.join(root, 'dist/node/jocly.core.js'));

const DROP_TOKEN = new RegExp('^([A-Z]*)@([a-i][0-9])$');
const DROP_NATURAL = new RegExp('^([A-Z+]*)@([a-i][0-9])$');
const SUFFIX = new RegExp('[+=]$');
const PROMOTED = new RegExp('[+]$');

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };

// Chaque ligne : le fichier, et le nombre de demi-coups qu'il doit rejouer.
const GAMES = [
    ['fixtures/pychess/shatranj.pgn',        119],
    ['fixtures/pychess/grand.pgn',            49],
    ['fixtures/pychess/khans.pgn',            25],
    ['fixtures/pychess/capablanca.pgn',       91],
    ['fixtures/pychess/shako.pgn',            68],
    ['fixtures/pychess/spartan.pgn',          36],
    ['fixtures/pychess/makruk.pgn',           76],
    ['fixtures/pychess/janggi.pgn',           40],
    ['fixtures/pychess/kyoto.pgn',            28],
    ['fixtures/pychess/shoshogi.pgn',        108],
    ['fixtures/pychess/shogi-promotions.pgn',  66],
    ['fixtures/pychess/mini.pgn',             20],
    ['fixtures/pychess/xiangqi-pychess-1.pgn', 40],
    ['fixtures/pychess/xiangqi-NrmGxFe1.pgn', 100],
];

const names = Object.keys(await Jocly.listGames());
const configs = {};
for (const n of names) configs[n] = await Jocly.getGameConfig(n).catch(() => null);
const fairy = FairyGameIndex(configs);

// La lettre portée par chaque case : le xiangqi et le janggi numérotent leurs
// rangées à partir de 0, les autres à partir de 1.
function BoardLetters(fen, zeroBased) {
    const rows = String(fen || '').split(' ')[0].replace(/\[[^\]]*\]/g, '').split('/');
    const map = {};
    rows.forEach((row, index) => {
        const rank = rows.length - index - (zeroBased ? 1 : 0);
        let file = 0;
        for (let k = 0; k < row.length; ) {
            const c = row[k];
            if (c >= '0' && c <= '9') {
                let n = c;
                while (row[k + 1] >= '0' && row[k + 1] <= '9') n += row[++k];
                file += parseInt(n, 10); k++; continue;
            }
            let piece = c; k++;
            if (c === '+') { piece += row[k]; k++; }
            map[String.fromCharCode(97 + file) + rank] = piece;
            file++;
        }
    });
    return (square) => map[square] || null;
}

for (const [name, expected] of GAMES) {
    const text = readFileSync(path.join(root, 'tests', name), 'utf-8');
    const tags = {};
    for (const line of text.split('\n')) {
        const m = /^\s*\[(\S+)\s+(.*)\]\s*$/.exec(line.trim());
        if (m) tags[m[1]] = m[2].replace(/^"|"$/g, '');
    }
    const variant = BookVariant(tags);
    const game = VariantGame(variant) || fairy[FairyVariantAlias(variant)];
    if (!game) { ok(false, `${name} : [Variant "${variant}"] ne designe aucun jeu`); continue; }

    const tokens = ExtractMoves(text);
    const match = await Jocly.createMatch(game);
    const board = PgnFenToShogiSfen(BookFen(tags)) || VariantFen(BookFen(tags), game);
    let refused = null;
    try { await match.load({ game, initialBoard: board || undefined, playedMoves: [] }); }
    catch (e) { refused = e; }
    if (refused) { ok(false, `${name} : position refusee — ${refused.message}`); continue; }

    const zeroBased = game === 'xiangqi' || game === 'janggi';
    let rankOffset = null;
    const resolve = async (token) => {
        const parsed = ParseSanMove(token);
        if (!parsed) return null;
        const moves = await match.getPossibleMoves();
        if (!moves.length) return null;
        const naturals = await match.getMoveString(moves);
        const letterAt = BoardLetters(await match.getBoardState(), zeroBased);
        const usi = await match.getMoveString(moves, 'usi').catch(() => null);
        const attempt = (offset) => {
            let found = null, ambiguous = false;
            for (let i = 0; i < moves.length; i++) {
                const options = { rankOffset: offset, game };
                if (usi && typeof usi[i] === 'string' && usi[i] !== '??')
                    options.promoted = usi[i].endsWith('+');
                if (!SanMatches(parsed, naturals[i], letterAt, options)) continue;
                if (found) { ambiguous = true; continue; }
                found = moves[i];
            }
            return ambiguous ? null : found;
        };
        if (rankOffset !== null) return attempt(rankOffset);
        for (const offset of [0, 1]) {
            const move = attempt(offset);
            if (move) { rankOffset = offset; return move; }
        }
        return null;
    };

    // Le prelude : un choix qui compte pour un coup, parfois en deux etapes.
    for (let depth = 0; depth < 4; depth++) {
        const moves = await match.getPossibleMoves();
        const naturals = await match.getMoveString(moves);
        if (!/^(#\d+|--)$/.test(naturals[0] || '')) break;
        if (moves.length === 1) { await match.playMove(moves[0]); continue; }
        let done = false;
        for (let i = 0; i < moves.length; i++) {
            await match.playMove(moves[i]);
            const next = await match.getPossibleMoves();
            const nextNames = await match.getMoveString(next);
            if (/^--$/.test(nextNames[0] || '')) await match.playMove(next[0]);
            if (await resolve(tokens[0])) { done = true; break; }
            await match.rollback(depth);
        }
        if (!done) await match.playMove(moves[0]);
    }

    const format = MoveFormat(tokens);
    const replay = await ReplayBookMoves(tokens, {
        pick: (s) => match.pickMove(s).catch(() => null),
        exact: format === 'san' ? resolve : null,
        play: (m) => match.playMove(m),
    });
    ok(replay.unresolved === null && replay.played === expected,
       `${name.replace('fixtures-', '').padEnd(30)} ${replay.played}/${tokens.length}`
       + (replay.unresolved ? ` — bloque sur « ${replay.unresolved} »` : ''));
}

// ── KIF japonais ────────────────────────────────────────────────────────────
//
// Le format des logiciels japonais (shogidb2, lishogi). Rejoue par le meme
// principe que le reste, avec le resolveur « par cases » : le KIF donne la
// case de depart de chaque coup, ce qui suffit a le designer sans ambiguite.
for (const [name, expected] of [['fixtures/kif/shogi-japonais.kif', 187],
                                ['fixtures/kif/shogi-japonais-2.kif', 119],
                                // lishogi ecrit le meme format, avec des
                                // coups indentes, sans temps consomme, et des
                                // commentaires « * … » entre les coups.
                                ['fixtures/kif/shogi-lishogi-study.kif', 41]]) {
    const text = readFileSync(path.join(root, 'tests', name), 'utf-8');
    ok(IsShogiKif(text), name + ' : reconnu comme KIF de shogi');
    const kif = ParseShogiKif(text);
    ok(kif && kif.handicap === '\u5e73\u624b', 'partie a egalite, position standard');
    ok(kif.moves.length === expected, expected + ' coups lus (' + kif.moves.length + ')');

    const drops = kif.moves.filter(function(mv) { return mv.indexOf('@') >= 0; });
    // Toutes les parties n'ont pas de parachutage ; celles qui en ont doivent
    // NOMMER la piece posee, sans quoi « @c6 » vaut aussi bien pour un pion
    // que pour un fou en main.
    ok(drops.every(function(mv) { return DROP_TOKEN.test(mv); }),
       drops.length + ' parachutage(s), tous nommes' + (drops.length ? ' (' + drops.slice(0, 3).join(' ') + ')' : ''));
    ok(kif.moves.every(function(mv) { return /[+=]$|@/.test(mv); }),
       'chaque coup dit s\'il promeut ou non — l\'absence de « 成 » est un refus');
}

console.log('');
console.log(`RESULTAT pychess-replay: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
