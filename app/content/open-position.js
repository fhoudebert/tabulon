// app/content/open-position.js
//
// "Board state" / "Load board state" : saisir un état de plateau et
//   - avec matchId : recharger la partie en cours (satellite load-board-state
//     vers play.js — l'ancien rpc load_board_state n'avait pas de commande Rust) ;
//   - sans matchId (bouton "Board state" du hub) : démarrer une nouvelle
//     partie depuis cet état, via le canal fork ({initialBoard}) + new_match,
//     comme joclyboard::loadBoardState sans match.
import tRpc from './tabulon-rpc.js';
import twu  from './tabulon-winutils.js';
import { emit, Store } from './tauri-bridge.js';
import { initI18n, t } from './tabulon-i18n.js';
import { SideWithoutKing } from './book-format.js';

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
    await twu.init(config.model['title-en']);

    document.getElementById('button-cancel').addEventListener('click', () => tRpc.close());
    // Avertissement pendant la saisie. Une position dont un camp n'a pas de
    // piece royale se pose sans erreur et reste FIGEE : jocly tient ce camp
    // pour perdu, il n'y a aucun coup legal et rien ne le dit. C'est le cas
    // normal d'un probleme de mat -- que Tabulon ouvre par un fichier, ou le
    // commentaire {Tsume} declenche le mode -- et une faute de frappe le reste
    // du temps. On ne bloque donc pas la saisie : on previent.
    const input = document.querySelector('input');
    const notice = document.getElementById('position-notice');
    const CheckState = () => {
        if (!notice) return;
        const side = SideWithoutKing(input.value.trim());
        notice.textContent = side ? t('position.noKing') : '';
    };
    input.addEventListener('input', CheckState);
    CheckState();

    document.getElementById('button-save').addEventListener('click', async () => {
        const state = document.querySelector('input').value.trim();
        if (!state) return;
        if (matchId) {
            await emit(`play-req:${matchId}:load-board-state`, { state });
        } else {
            const id = 'pos-' + Date.now();
            const store = await Store.load('tabulon.json');
            await store.set('fork:' + id, { game: gameName, playedMoves: [], initialBoard: state });
            await tRpc.call('new_match', gameName, null, id);
        }
        tRpc.close();
    });
    twu.ready();
});
