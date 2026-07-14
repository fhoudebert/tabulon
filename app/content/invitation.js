// app/content/invitation.js
// Fenetre satellite : deux façons de démarrer une partie à distance --
//   - Join  : coller un lien reçu (index.php?game=...&mid=...&player=a|b)
//   - Create: générer un identifiant de partie ici, obtenir le lien à
//             envoyer à l'autre joueur (rôle 'b', nous jouons 'a'), puis
//             Start pour lancer la partie.
// Dans les deux cas, la config est déposée sous "invite:{id}" dans le store,
// puis new_match(gameName, ..., inviteId) est appelé -- play.js lit ce store
// au démarrage (voir README § Remote play).

import tRpc from './tabulon-rpc.js';
import { initI18n, t } from './tabulon-i18n.js';
import twu  from './tabulon-winutils.js';
import { Store } from './tauri-bridge.js';
import { parseInvitationUrl, buildInvitationUrl, generateMatchId, DEFAULT_RELAY_URL } from './remote-relay-protocol.js';

const selectedGame = new URLSearchParams(window.location.search).get('game') || null;

document.addEventListener('DOMContentLoaded', async () => {
    await initI18n();
    await twu.init(t('invitation.title'));

    const store = await Store.load('tabulon.json');

    const urlInput      = document.getElementById('invitation-url');
    const status        = document.getElementById('invitation-status');
    const relayInput    = document.getElementById('invitation-relay-url');
    const createStatus  = document.getElementById('invitation-create-status');
    const linkRow       = document.getElementById('invitation-link-row');
    const linkInput     = document.getElementById('invitation-link');
    const startBtn      = document.getElementById('button-start');

    if (relayInput) relayInput.value = DEFAULT_RELAY_URL;

    const setStatus = (el, text, cls) => {
        if (!el) return;
        el.textContent = text || '';
        el.className = 'invitation-status' + (cls ? ' ' + cls : '');
    };

    // A appeler une fois qu'on a {gameName, matchId, relayUrl, player} valides,
    // qu'ils viennent d'un lien collé (Join) ou d'une partie qu'on vient de
    // créer ici (Create + Start).
    async function startMatch({ gameName, matchId, relayUrl, player, creator }) {
        const inviteId = 'inv-' + Date.now();
        await store.set('invite:' + inviteId, { matchId, relayUrl, gameName, player, creator: !!creator });
        await tRpc.call('new_match', gameName, null, undefined, inviteId);
        tRpc.close();
    }

    document.getElementById('button-cancel')?.addEventListener('click', () => tRpc.close());

    // -- Join ---------------------------------------------------------------------
    document.getElementById('button-join')?.addEventListener('click', async () => {
        const parsed = parseInvitationUrl(urlInput?.value || '');
        if (!parsed) { setStatus(status, t('invitation.invalidLink'), 'fail'); return; }
        if (selectedGame && parsed.gameName !== selectedGame)
            setStatus(status, t('invitation.gameMismatch', { game: parsed.gameName }), 'warn');
        await startMatch(parsed);
    });

    // -- Create + Start -------------------------------------------------------------
    let created = null;  // {gameName, matchId, relayUrl, player:'a'} une fois Create cliqué

    document.getElementById('button-create')?.addEventListener('click', () => {
        if (!selectedGame) { setStatus(createStatus, t('invitation.invalidLink'), 'fail'); return; }
        const relayUrl = relayInput?.value.trim() || DEFAULT_RELAY_URL;
        const matchId = generateMatchId();
        const link = buildInvitationUrl({ relayUrl, gameName: selectedGame, matchId, player: 'b' });
        if (!link) { setStatus(createStatus, t('players.testFail'), 'fail'); return; }
        created = { gameName: selectedGame, matchId, relayUrl, player: 'a', creator: true };
        if (linkInput) linkInput.value = link;
        if (linkRow) linkRow.style.display = '';
        if (startBtn) startBtn.disabled = false;
        setStatus(createStatus, '', '');
    });

    document.getElementById('button-copy-link')?.addEventListener('click', async () => {
        const btn = document.getElementById('button-copy-link');
        if (!linkInput?.value || !btn) return;
        try {
            await navigator.clipboard.writeText(linkInput.value);
            const original = btn.textContent;
            btn.textContent = t('players.copied');
            setTimeout(() => { btn.textContent = original; }, 1200);
        } catch (e) {
            console.warn('[invitation] clipboard write failed:', e.message || e);
        }
    });

    startBtn?.addEventListener('click', async () => {
        if (!created) return;
        await startMatch(created);
    });

    await twu.ready();
});
