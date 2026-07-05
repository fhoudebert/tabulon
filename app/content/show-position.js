// app/content/show-position.js
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

tRpc.listen({
    setPosition(data) {
        document.querySelector('textarea').value = data;
    }
});

document.addEventListener('DOMContentLoaded', () => {
    Jocly.getGameConfig(gameName).then(async (config) => {
        await twu.init(`${config.model['title-en']} #${matchId} board state`);
        document.getElementById('button-cancel').addEventListener('click', () => tRpc.close());
        twu.ready();
    });
});
