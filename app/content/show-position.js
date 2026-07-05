// app/content/show-position.js
//
// "Display board state" : affiche l'état du plateau (FEN ou équivalent) de la
// partie. L'état est demandé à play.js via le protocole satellite
// (play-req/play-rep get-board-state) — l'ancien push rpc "setPosition"
// n'avait pas d'émetteur côté Rust.
import tRpc from './tabulon-rpc.js';
import twu  from './tabulon-winutils.js';
import { listen, emit } from './tauri-bridge.js';
import { initI18n, t } from './tabulon-i18n.js';

const gameName = (function () {
    const m = /\?.*\bgame=([^&]+)/.exec(window.location.href);
    return m && m[1] || 'classic-chess';
})();
const matchId = (function () {
    const m = /\?.*\bid=([0-9]+)/.exec(window.location.href);
    return m && m[1] || '';
})();

document.addEventListener('DOMContentLoaded', async () => {
    await initI18n();
    const config = await Jocly.getGameConfig(gameName);
    await twu.init(`${config.model['title-en']} #${matchId}`);
    document.getElementById('button-cancel').addEventListener('click', () => tRpc.close());

    if (matchId) {
        await listen(`play-rep:${matchId}:get-board-state`, ({ payload }) => {
            document.querySelector('textarea').value = payload?.state || '';
        });
        await emit(`play-req:${matchId}:get-board-state`, null);
    }
    twu.ready();
});
