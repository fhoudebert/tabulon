// app/content/invitation.js
// Fenetre satellite : coller un lien d'invitation jocly-simple-match
// (index.php?game=...&mid=...&player=a|b) pour rejoindre cette partie.
// Depose la config sous "invite:{id}" dans le store, puis lance new_match
// avec cet id -- play.js lit ce store au demarrage (voir README § Remote play).

import tRpc from './tabulon-rpc.js';
import { initI18n, t } from './tabulon-i18n.js';
import twu  from './tabulon-winutils.js';
import { Store } from './tauri-bridge.js';
import { parseInvitationUrl } from './remote-relay-protocol.js';

const selectedGame = new URLSearchParams(window.location.search).get('game') || null;

document.addEventListener('DOMContentLoaded', async () => {
    await initI18n();
    await twu.init(t('invitation.title'));

    const store  = await Store.load('tabulon.json');
    const input  = document.getElementById('invitation-url');
    const status = document.getElementById('invitation-status');

    const setStatus = (text, cls) => {
        if (!status) return;
        status.textContent = text || '';
        status.className = 'invitation-status' + (cls ? ' ' + cls : '');
    };

    document.getElementById('button-cancel')?.addEventListener('click', () => tRpc.close());

    document.getElementById('button-join')?.addEventListener('click', async () => {
        const parsed = parseInvitationUrl(input?.value || '');
        if (!parsed) { setStatus(t('invitation.invalidLink'), 'fail'); return; }

        // Le jeu de la fenêtre (bouton cliqué depuis le hub) et celui du lien
        // peuvent différer si l'ami a partagé un lien pour un autre jeu que
        // celui actuellement sélectionné -- on avertit mais on suit le lien
        // (source de vérité pour ce qui va réellement se jouer sur le relai).
        if (selectedGame && parsed.gameName !== selectedGame)
            setStatus(t('invitation.gameMismatch', { game: parsed.gameName }), 'warn');

        const inviteId = 'inv-' + Date.now();
        await store.set('invite:' + inviteId, {
            matchId: parsed.matchId, relayUrl: parsed.relayUrl,
            gameName: parsed.gameName, player: parsed.player,
        });
        await tRpc.call('new_match', parsed.gameName, null, undefined, inviteId);
        tRpc.close();
    });

    await twu.ready();
});
