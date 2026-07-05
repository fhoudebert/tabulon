// app/content/moves.js
import tRpc from './tabulon-rpc.js';
import twu  from './tabulon-winutils.js';
import { listen, emit } from './tauri-bridge.js';
import { initI18n, t } from './tabulon-i18n.js';

const matchId = (function () {
    const m = /\?.*\bid=([0-9]+)/.exec(window.location.href);
    return m && m[1] || 0;
})();

let moves = [];
let timer = null;

function clearTimer() {
    if (timer) { clearTimeout(timer); timer = null; }
}
function showMove(index) {
    clearTimer();
    emit(`play-req:${matchId}:show-move`, { move: moves[index] });
}
function unshowMove() {
    clearTimer();
    timer = setTimeout(() => emit(`play-req:${matchId}:show-move`, { move: null }), 100);
}

function UpdateMoves(data) {
        moves = data.moves;
        const ul = document.querySelector('ul');
        ul.innerHTML = '';
        data.strMoves.forEach((strMove, index) => {
            const li = document.createElement('li');
            li.className = 'possible-move';
            li.textContent = strMove;
            li.addEventListener('click',      () => emit(`play-req:${matchId}:input-move`, { move: moves[index] }));
            li.addEventListener('mouseover',  () => showMove(index));
            li.addEventListener('mouseout',   () => unshowMove());
            ul.appendChild(li);
        });
}

document.addEventListener('DOMContentLoaded', async () => {
    await initI18n();
    await twu.init(t('moves.title', { id: matchId }));

    await listen(`play-rep:${matchId}:get-possible-moves`, ({ payload }) =>
        UpdateMoves({ moves: payload.moves, strMoves: payload.strMoves || payload.moves.map(String) }));
    await listen(`play-event:${matchId}:move-played`, () =>
        emit(`play-req:${matchId}:get-possible-moves`, null));
    await emit(`play-req:${matchId}:get-possible-moves`, null);
    twu.ready();
    document.getElementById('button-close').addEventListener('click', () => tRpc.close());
});
