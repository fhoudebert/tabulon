// test-kriegspiel-book.mjs — une partie du Jeu de la guerre écrite en PJN puis
// rouverte : l'armée doit repartir du placement enregistré, et chaque tour
// doit être celui qui a été joué.
//
// Le défaut corrigé : la notation mettait des blancs dans un coup
// (« Nord: I@C3,… », « F3-G4 H2-H4 xE7 »). ExtractMoves coupe aux blancs, et
// pickMove (GetBestMatchingMove) cherchait chaque morceau parmi l'échantillon
// de GenerateMoves -- dix placements tirés au hasard : l'armée rouverte ne
// partait pas d'où elle était partie. jocly2 écrit désormais un coup en un
// mot et le relit exactement (Model.Board.ParseMove) ; les fichiers de
// l'ancienne notation se relisent en regroupant les jetons (option `join` de
// ReplayBookMoves, posée par play.js pour ce jeu).
//
// Usage : node tests/test-kriegspiel-book.mjs   (depuis tabulon/, dist/ de
// jocly2 avec le jeu ; sinon le test est sauté)
import { createRequire } from 'module';
import { existsSync } from 'fs';
import { ExtractMoves, MoveFormat, ReplayBookMoves, BuildPJN } from '../app/content/book-format.js';
process.chdir(new URL('..', import.meta.url).pathname);
const require = createRequire(import.meta.url);

const MODEL = './dist/node/games/kriegspiel/jeu-de-la-guerre-model.js';
if (!existsSync(MODEL)) {
    console.log('SKIP — dist/ sans le Jeu de la guerre');
    process.exit(0);
}
const Jocly = require('../dist/node/jocly.core.js');

let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}

const GAME = 'jeu-de-la-guerre';

async function playSome(plies) {
    const match = await Jocly.createMatch(GAME);
    const config = await match.getConfig();
    const level = Object.assign({}, config.model.levels[0], { maxDuration: 0.2, maxLoops: 8 });
    const notation = [];
    for (let i = 0; i < plies; i++) {
        const r = await match.machineSearch({ level, threaded: false });
        notation.push(await match.getMoveString(r.move));
        if ((await match.applyMove(r.move)).finished) break;
    }
    return { match, notation };
}

// la position complète, telle que le moteur externe la lit
const state = (match) => match.game.mBoard.ExportBoardState(match.game);

// BookReplay de play.js, réduit à ce qui touche ce jeu
async function reopen(text, join) {
    const match = await Jocly.createMatch(GAME);
    const moves = ExtractMoves(text);
    const first = [];
    const { played, unresolved } = await ReplayBookMoves(moves, {
        pick: (s) => match.pickMove(s).catch(() => null),
        exact: null,
        join,
        play: async (m) => { if (!first.length) first.push(await match.getMoveString(m)); return match.applyMove(m); },
    });
    return { match, played, unresolved, moves, first: first[0], format: MoveFormat(moves) };
}

// l'ancienne notation, à blancs, telle que les fichiers déjà enregistrés la portent
const oldForm = (s) => s.replace(/^(Nord|Sud):/, '$1: ').replace(/,(?=(r:)?[A-T]\d+-|x[A-T]\d)/g, ' ');

const { match: orig, notation } = await playSome(14);
assert(notation.length >= 6, `partie jouée par l'IA : ${notation.length} demi-coups`);
assert(/^Nord:I@/.test(notation[0]) && /^Sud:I@/.test(notation[1]), 'les deux placements en tête');
assert(notation.every((m) => !/\s/.test(m)), 'un coup = un mot (pas de blanc)');

console.log('Nouvelle notation');
{
    const text = BuildPJN(GAME, notation, null, new Date(2026, 10, 14), {});
    const r = await reopen(text, 8);
    assert(r.moves.length === notation.length, `ExtractMoves : ${r.moves.length} jetons, un par demi-coup`);
    assert(r.format !== 'usi' && r.format !== 'san', `notation laissée à pickMove (format « ${r.format} »)`);
    assert(r.unresolved === null && r.played === notation.length, `tous les coups relus (${r.played})`);
    assert(r.first === notation[0], 'le placement du Nord relu à l\'identique');
    assert(state(r.match) === state(orig), 'même position à la fin (unités, arsenaux, trait)');
}

console.log('Ancienne notation (fichiers déjà enregistrés)');
{
    const old = notation.map(oldForm);
    assert(old[0].startsWith('Nord: I@') && old.slice(2).some((m) => / /.test(m)) || old.length <= 2,
        'conversion : « Nord: … » et tours à blancs');
    const text = BuildPJN(GAME, old, null, new Date(2026, 10, 14), {});
    const r = await reopen(text, 8);
    assert(r.moves.length > notation.length, `ExtractMoves en fait ${r.moves.length} jetons pour ${notation.length} demi-coups`);
    assert(r.unresolved === null && r.played === notation.length, `regroupés, tous relus (${r.played})`);
    assert(r.first === notation[0], 'le placement du Nord retrouvé exactement');
    assert(state(r.match) === state(orig), 'même position à la fin');
    const strict = await reopen(text, 0);
    assert(strict.played === 0 && strict.unresolved === 'Nord:',
        'sans regroupement, la lecture s\'arrête au premier morceau au lieu d\'inventer un placement');
}

console.log(`\ntest-kriegspiel-book: ${passed} assertions OK`);
