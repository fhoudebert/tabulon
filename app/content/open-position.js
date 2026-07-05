// app/content/open-position.js
import tRpc from './tabulon-rpc.js';
import twu  from './tabulon-winutils.js';

const gameName = (function () {
    const m = /\?.*\bgame=([^&]+)/.exec(window.location.href);
    return m && m[1] || 'classic-chess';
})();
const matchId = (function () {
    const m = /\?.*\bid=([0-9]+)/.exec(window.location.href);
    return m && m[1] || '';
})();

document.addEventListener('DOMContentLoaded', async () => {
    const config = await Jocly.getGameConfig(gameName);
    await twu.init(config.model['title-en'] + ' board state');

    document.getElementById('button-cancel').addEventListener('click', () => tRpc.close());
    document.getElementById('button-save').addEventListener('click', async () => {
        const fen = document.querySelector('input').value;
        await tRpc.call('load_board_state', gameName, matchId, fen);
        tRpc.close();
    });
});
