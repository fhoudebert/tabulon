// app/content/moves.js
import tRpc from './tabulon-rpc.js';
import twu  from './tabulon-winutils.js';

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
    tRpc.call('show_move', matchId, moves[index]);
}
function unshowMove() {
    clearTimer();
    timer = setTimeout(() => tRpc.call('show_move', matchId, null), 100);
}

tRpc.listen({
    updateMoves(data) {
        moves = data.moves;
        const ul = document.querySelector('ul');
        ul.innerHTML = '';
        data.strMoves.forEach((strMove, index) => {
            const li = document.createElement('li');
            li.className = 'possible-move';
            li.textContent = strMove;
            li.addEventListener('click',      () => tRpc.call('input_move', matchId, moves[index]));
            li.addEventListener('mouseover',  () => showMove(index));
            li.addEventListener('mouseout',   () => unshowMove());
            ul.appendChild(li);
        });
    }
});

document.addEventListener('DOMContentLoaded', async () => {
    await twu.init(`Possible moves #${matchId}`);
    twu.ready();
    document.getElementById('button-close').addEventListener('click', () => tRpc.close());
});
