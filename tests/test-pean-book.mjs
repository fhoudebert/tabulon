// test-pean-book.mjs — une partie de Péan écrite en PJN puis rouverte.
//
// Un tour de Péan n'est pas un coup de pièce : c'est une suite d'ordres et de
// combats, et il ne s'énumère pas -- la liste des coups légaux de jocly n'en
// contient qu'une poignée de candidats. Deux conséquences pour « Ouvrir une
// partie » :
//
//   - chaque tour doit s'écrire en UN jeton : ExtractMoves découpe aux blancs,
//     et l'ancienne notation (« O13-O10 U13-U10 ») donnait un jeton par ordre ;
//   - le jeton doit se relire EXACTEMENT : la lecture tolérante de pickMove
//     (GetBestMatchingMove, distance d'édition) aurait joué le candidat le plus
//     ressemblant, en silence. jocly2 laisse le jeu lire sa notation lui-même
//     (Model.Board.ParseMove), et pickMove rend null sur ce qu'il ne lit pas.
//
// Le chemin suivi est celui de play.js (BookReplay) : ExtractMoves, retrait
// des jetons de prélude en tête (« #1 », « -- »), réponse au prélude, choix de
// la notation (MoveFormat), puis ReplayBookMoves avec pickMove.
//
// Usage : node tests/test-pean-book.mjs   (depuis tabulon/, dist/ de jocly2
// avec le jeu « pean » ; sinon le test est sauté)
import { createRequire } from 'module';
import { existsSync } from 'fs';
import { ExtractMoves, MoveFormat, ReplayBookMoves } from '../app/content/book-format.js';
process.chdir(new URL('..', import.meta.url).pathname);
const require = createRequire(import.meta.url);

if (!existsSync('./dist/node/games/pean/pean-model.js')) {
    console.log('SKIP — dist/ sans le jeu « pean » (branche pean de jocly2)');
    process.exit(0);
}
const Jocly = require('../dist/node/jocly.core.js');

let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}

const PRELUDE_MOVE = /^(#\d+|--)$/;

// Le PJN tel que Tabulon l'écrit : un jeton par demi-coup, numérotés par paire.
function pjn(tokens) {
    let body = '';
    tokens.forEach((tok, i) => { body += (i % 2 ? ' ' : (i ? ' ' : '') + (i / 2 + 1) + '. ') + tok; });
    return '[JoclyGame "pean"]\n[PlyCount "' + tokens.length + '"]\n\n' + body + '\n';
}

async function playSome(scenarioIndex, plies) {
    const match = await Jocly.createMatch('pean');
    const config = await match.getConfig();
    const level = Object.assign({}, config.model.levels[0], { maxDuration: 0.3, maxLoops: 10 });
    await match.applyMove({ setup: scenarioIndex });
    await match.applyMove({ skip: 1 });
    for (let i = 0; i < plies; i++) {
        const r = await match.machineSearch({ level, threaded: false });
        if ((await match.applyMove(r.move)).finished) break;
    }
    return match;
}

// BookReplay de play.js, réduit à ce qui touche ce jeu
async function reopen(text) {
    const match = await Jocly.createMatch('pean');
    const moves = ExtractMoves(text);
    const recorded = [];
    while (moves.length && PRELUDE_MOVE.test(moves[0])) recorded.push(moves.shift());
    for (const want of recorded) {
        const possible = await match.getPossibleMoves();
        const names = await match.getMoveString(possible);
        const i = names.indexOf(want);
        if (i < 0) break;
        await match.applyMove(possible[i]);
    }
    const format = MoveFormat(moves);
    const { played, unresolved } = await ReplayBookMoves(moves, {
        pick: (s) => match.pickMove(s).catch(() => null),
        exact: null,
        play: (m) => match.applyMove(m),
    });
    return { match, recorded, format, played, unresolved, total: moves.length };
}

for (const [name, index, plies] of [['bataille libre', 3, 8], ['Platées', 0, 8], ['Laurion', 1, 6]]) {
    console.log('\n' + name);
    const a = await playSome(index, plies);
    const tokens = await a.getMoveString(await a.getPlayedMoves());
    assert(tokens.every(tok => tok && !/\s/.test(tok)), 'un jeton par demi-coup : ' + tokens.slice(2, 4).join(' ') + ' …');
    const back = await reopen(pjn(tokens));
    assert(back.recorded.join(' ') === '#' + index + ' --', 'le prélude est lu en tête : ' + back.recorded.join(' '));
    assert(back.format === 'natural', 'notation propre au jeu (' + back.format + ')');
    assert(!back.unresolved && back.played === back.total,
        `tous les tours relus (${back.played}/${back.total})` + (back.unresolved ? ' — bute sur ' + back.unresolved : ''));
    assert(await back.match.getBoardState() === await a.getBoardState(), 'la même position');
    assert(await back.match.getTurn() === await a.getTurn(), 'le même trait');
}

console.log('\nancienne notation (un jeton par ordre)');
{
    const old = '[JoclyGame "pean"]\n\n1. #2 -- 2. D10-D7 1xD6+ 3. K4-K7 L4-L7\n';
    const back = await reopen(old);
    // « D10-D7 » se lit seul comme un tour d'un ordre ; « 1xD6+ » ne désigne
    // pas ses attaquants : la lecture s'arrête là au lieu de deviner
    assert(back.played === 1 && back.unresolved === '1xD6+',
        'arrêtée au premier jeton illisible, pas devinée (' + back.unresolved + ')');
}

console.log(`\n${passed} assertions OK — parties de Péan relues.`);
process.exit(0);
