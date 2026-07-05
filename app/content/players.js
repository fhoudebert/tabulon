// app/content/players.js
// Fenetre satellite : configuration des joueurs (humain / IA niveau X).
// Communique avec play.html via Tauri events (play-req/play-rep:{matchId}:*).

import tRpc from './tabulon-rpc.js';
import { initI18n, t } from './tabulon-i18n.js';
import twu  from './tabulon-winutils.js';
import { listen, emit } from './tauri-bridge.js';

const matchId = parseInt(new URLSearchParams(window.location.search).get('id') || '0', 10);

function BuildSelect(sel, levels, currentType, currentLevelIndex) {
    sel.innerHTML = '';
    const optHuman = document.createElement('option');
    optHuman.value = 'human'; optHuman.textContent = t('common.human');
    sel.appendChild(optHuman);
    levels.forEach((lvl, i) => {
        const opt = document.createElement('option');
        opt.value = 'ai:' + i;
        opt.textContent = lvl.label || lvl.name || t('common.level', { n: i + 1 });
        sel.appendChild(opt);
    });
    sel.value = (currentType === 'ai' && currentLevelIndex >= 0)
        ? 'ai:' + currentLevelIndex : 'human';
}

document.addEventListener('DOMContentLoaded', async () => {
    await initI18n();
    await twu.init(t('players.title', { id: matchId }));

    listen('play-rep:' + matchId + ':get-players', ({ payload }) => {
        const { levels, players } = payload;
        ['a', 'b'].forEach(which => {
            const key  = which === 'a' ? 1 : -1;  // PLAYER_A=1, PLAYER_B=-1
            const form = document.querySelector('.players-' + which);
            const sel  = form?.querySelector('select');
            if (!sel) return;
            const info = players[key] || {};
            BuildSelect(sel, levels, info.type, info.levelIndex);
            const nameInput = form.querySelector('input[type=text]');
            if (nameInput) nameInput.value = which === 'a' ? t('common.playerA') : t('common.playerB');
        });
        twu.ready();
    });

    document.getElementById('button-cancel')?.addEventListener('click', () => tRpc.close());

    document.getElementById('button-save')?.addEventListener('click', async () => {
        const result = {};
        ['a', 'b'].forEach(which => {
            const key  = which === 'a' ? 1 : -1;
            const sel  = document.querySelector('.players-' + which + ' select');
            if (!sel) return;
            const val  = sel.value;
            if (val === 'human') {
                result[key] = { type: 'human', levelIndex: -1 };
            } else {
                const idx = parseInt(val.replace('ai:', ''), 10);
                result[key] = { type: 'ai', levelIndex: idx };
            }
        });
        await emit('play-req:' + matchId + ':set-players', result);
        tRpc.close();
    });

    await emit('play-req:' + matchId + ':get-players', null);
});
