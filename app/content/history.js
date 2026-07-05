// app/content/history.js
// Fenetre satellite : historique des coups joues.
// Affiche les coups, permet de naviguer (rollback) dans la partie.
// Communique avec play.html via Tauri events (play-req/play-rep:{matchId}:*).

import tRpc from './tabulon-rpc.js';
import twu  from './tabulon-winutils.js';
import { listen, emit } from './tauri-bridge.js';

const gameName = new URLSearchParams(window.location.search).get('game') || 'classic-chess';
const matchId  = parseInt(new URLSearchParams(window.location.search).get('id') || '0', 10);

let currentIndex = -1;
let moveCount    = 0;
let moveStrings  = [];  // liste de chaines de coups (ex. ["e4", "e5", ...])

function btn(action) {
    return document.querySelector('.toolbar-actions button[data-action=' + action + ']');
}

function UpdateButtons() {
    const dis = (action, enabled) => {
        const b = btn(action);
        if (b) b.classList.toggle('disabled', !enabled);
    };
    const vis = (action, visible) => {
        const b = btn(action);
        if (b) b.style.display = visible ? '' : 'none';
    };
    dis('start',       currentIndex >= 0);
    dis('stepback',    currentIndex >= 0);
    dis('stepforward', currentIndex < moveCount - 1);
    dis('end',         currentIndex < moveCount - 1);
}

function SelectMove(index) {
    document.querySelectorAll('#moves .move').forEach(el => el.classList.remove('active'));
    const el = document.querySelector('#moves .move[data-index="' + index + '"]');
    if (el) { el.classList.add('active'); el.scrollIntoView({ block: 'nearest' }); }
    currentIndex = Math.max(-1, Math.min(index, moveCount - 1));
    UpdateButtons();
}

function UpdateHistory(data) {
    const moves = data.moves || [];
    moveStrings = moves.map(m => typeof m === 'string' ? m : (m.toString ? m.toString() : JSON.stringify(m)));
    moveCount   = moveStrings.length;

    const movesElem = document.getElementById('moves');
    movesElem.innerHTML = '';
    moveStrings.forEach((moveStr, index) => {
        if (index % 2 === 0) {
            const num = document.createElement('span');
            num.className   = 'movenumber';
            num.textContent = (index / 2 + 1) + '.';
            movesElem.appendChild(num);
        }
        const span = document.createElement('span');
        span.className = 'move';
        span.setAttribute('data-index', index);
        span.textContent = moveStr;
        span.addEventListener('click', () => {
            SelectMove(index);
            // Rollback au coup selectionne dans play.html
            emit('play-req:' + matchId + ':rollback-to', { index: index + 1 });
        });
        movesElem.appendChild(span);
    });

    SelectMove(moveCount - 1);
}

function RequestHistory() {
    emit('play-req:' + matchId + ':get-played-moves', null);
}

function SavePJN() {
    const date = new Date();
    const tags = [
        '[JoclyGame "' + gameName + '"]',
        '[Date "' + date.getFullYear() + '.' + (date.getMonth()+1) + '.' + date.getDate() + '"]',
        '[PlyCount "' + moveCount + '"]',
    ];
    const text = tags.join('\n') + '\n\n' + moveStrings.join(' ') + '\n';
    const a = document.createElement('a');
    a.href = 'data:application/octet-stream,' + encodeURIComponent(text);
    a.setAttribute('download', gameName + '.pjn');
    a.click();
}

document.addEventListener('DOMContentLoaded', async () => {
    await twu.init('History #' + matchId);

    // Recevoir la reponse de play.html
    listen('play-rep:' + matchId + ':get-played-moves', ({ payload }) => {
        UpdateHistory(payload);
        twu.ready();
    });

    // Rafraichir quand play.html signale un nouveau coup
    listen('play-event:' + matchId + ':move-played', () => RequestHistory());

    btn('start')?.addEventListener('click', () => {
        SelectMove(-1);
        emit('play-req:' + matchId + ':rollback-to', { index: 0 });
    });
    btn('stepback')?.addEventListener('click', () => {
        const idx = Math.max(-1, currentIndex - 1);
        SelectMove(idx);
        emit('play-req:' + matchId + ':rollback-to', { index: idx + 1 });
    });
    btn('stepforward')?.addEventListener('click', () => {
        const idx = Math.min(moveCount - 1, currentIndex + 1);
        SelectMove(idx);
        emit('play-req:' + matchId + ':rollback-to', { index: idx + 1 });
    });
    btn('end')?.addEventListener('click', () => {
        SelectMove(moveCount - 1);
        emit('play-req:' + matchId + ':rollback-to', { index: moveCount });
    });
    btn('resume')?.addEventListener('click', () => {
        // Reprendre la partie depuis le coup selectionne
        emit('play-req:' + matchId + ':rollback-to', { index: currentIndex + 1 });
    });
    btn('save')?.addEventListener('click',  () => SavePJN());

    document.getElementById('button-close')?.addEventListener('click', () => tRpc.close());

    RequestHistory();
});
