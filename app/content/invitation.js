// app/content/invitation.js
// Fenetre satellite : trois façons de démarrer une partie à distance --
//   - Join  : coller un lien reçu (index.php?game=...&mid=...&player=a|b)
//   - Create: générer un identifiant de partie ici, obtenir le lien à
//             envoyer à l'autre joueur (rôle 'b', nous jouons 'a'), puis
//             Start pour lancer la partie.
//   - Pair à pair (AUCUN serveur) : l'hôte crée un CODE à transmettre
//             (copier-coller), l'invité le colle et se connecte -- session
//             TCP directe côté Rust (peer_cmds.rs). La session survit à la
//             fermeture de cette fenêtre : la fenêtre de jeu s'y rattache
//             (voir remote-peer-channel.js). Limites (README § Remote play,
//             étape 8) : joignabilité directe requise (LAN/VPN/IP publique),
//             pas de traversée NAT, flux non chiffré.
// Dans les deux cas, la config est déposée sous "invite:{id}" dans le store,
// puis new_match(gameName, ..., inviteId) est appelé -- play.js lit ce store
// au démarrage (voir README § Remote play).

import tRpc from './tabulon-rpc.js';
import { initI18n, t } from './tabulon-i18n.js';
import twu  from './tabulon-winutils.js';
import { Store, listen, httpFetch } from './tauri-bridge.js';
import { parseInvitationUrl, buildInvitationUrl, generateMatchId, DEFAULT_RELAY_URL, buildLoadBody } from './remote-relay-protocol.js';
import { hostPeerMatch, joinPeerMatch } from './remote-peer-channel.js';

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
<<<<<<< HEAD
    async function startMatch({ gameName, matchId, relayUrl, player, creator, peer }) {
        const inviteId = 'inv-' + Date.now();
        await store.set('invite:' + inviteId, { matchId, relayUrl, gameName, player, creator: !!creator, peer: !!peer });
=======
    async function startMatch({ gameName, matchId, relayUrl, player, creator }) {
        const inviteId = 'inv-' + Date.now();
        await store.set('invite:' + inviteId, { matchId, relayUrl, gameName, player, creator: !!creator });
>>>>>>> 484acdb (create match)
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

    // -- Pair a pair (aucun serveur) ------------------------------------------------
    // Cote hote : "Creer un code" -> ecoute Rust + code affiche a copier ;
    // quand l'invite se connecte (event status), Start se debloque et
    // `created` bascule sur la config p2p (le meme bouton Start sert aux
    // deux modes de creation). Cote invite : coller le code -> connexion
    // etablie -> la partie demarre directement (l'hote a forcement deja
    // clique de son cote pour que le code existe).
    const peerHostStatus = document.getElementById('peer-host-status');
    const peerJoinStatus = document.getElementById('peer-join-status');
    const peerCodeRow    = document.getElementById('peer-code-row');
    const peerCode       = document.getElementById('peer-code');
    const peerCodeInput  = document.getElementById('peer-code-input');
    let   peerHosting    = null;   // {gameName, matchId, ...} en attente de connexion

    await listen('tabulon-peer://status', ({ payload }) => {
        if (!peerHosting || !payload?.connected) return;
        created = peerHosting;   // Start lancera la partie p2p
        if (startBtn) startBtn.disabled = false;
        setStatus(peerHostStatus, t('invitation.peerConnected'), 'ok');
    });

    // Tester le relai (etape 8d, deplace depuis la fenetre Joueurs) : meme
    // sonde qu'avant -- un POST "load" sur un id anodin ; seule
    // l'atteignabilite du fileio.php compte, pas le contenu de la reponse.
    document.getElementById('button-test-relay')?.addEventListener('click', async () => {
        const relayUrl = document.getElementById('invitation-relay-url')?.value.trim() || DEFAULT_RELAY_URL;
        setStatus(createStatus, t('players.testChecking'), '');
        try {
            const res = await httpFetch(relayUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: buildLoadBody('tabulon-test').toString(),
            });
            await res.text();
            setStatus(createStatus, t('players.testOk'), 'ok');
        } catch (e) {
            console.warn('[invitation] test relay failed:', e.message || e);
            setStatus(createStatus, t('players.testFail'), 'fail');
        }
    });

    // Les champs de code/lien en lecture seule se selectionnent en entier au
    // clic : un double-clic ne selectionne que le "mot" sous le curseur (le
    // '-' de TBP1- coupe la selection), ce qui a deja produit un code
    // ampute en copier-coller manuel -- constate en test reel.
    ['peer-code', 'invitation-link'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', function () { this.select(); });
    });

    document.getElementById('button-peer-host')?.addEventListener('click', async () => {
        if (!selectedGame) { setStatus(peerHostStatus, t('invitation.invalidLink'), 'fail'); return; }
        // Jeu a travers Internet (etape 8c), deux champs optionnels :
        //   - port fixe : celui de la regle de redirection de la box de
        //     l'hote (box -> cette machine, TCP). Vide = port ephemere.
        //   - adresse(s) publique(s) : IP publique ou nom d'hote (DynDNS),
        //     plusieurs possibles separees par des virgules -- mises en
        //     tete du code, essayees en premier par l'invite.
        const portRaw = document.getElementById('peer-port')?.value.trim() || '';
        let port = null;
        if (portRaw) {
            port = Number(portRaw);
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                setStatus(peerHostStatus, t('invitation.peerBadPort'), 'fail');
                return;
            }
        }
        const extraAddresses = (document.getElementById('peer-extra-addr')?.value || '')
            .split(',').map(a => a.trim()).filter(Boolean);
        try {
            const { code, token } = await hostPeerMatch(selectedGame, { port, extraAddresses });
            peerHosting = {
                gameName: selectedGame, matchId: 'p2p:' + token.slice(0, 12),
                player: 'a', peer: true, creator: true,
            };
            if (peerCode) peerCode.value = code;
            if (peerCodeRow) peerCodeRow.style.display = '';
            setStatus(peerHostStatus, t('invitation.peerWaiting'), '');
        } catch (e) {
            console.warn('[invitation] peer host failed:', e.message || e);
            setStatus(peerHostStatus, t('invitation.peerHostFail', { error: String(e.message || e) }), 'fail');
        }
    });

    document.getElementById('button-peer-copy')?.addEventListener('click', async () => {
        const btn = document.getElementById('button-peer-copy');
        if (!peerCode?.value || !btn) return;
        try {
            await navigator.clipboard.writeText(peerCode.value);
            const original = btn.textContent;
            btn.textContent = t('players.copied');
            setTimeout(() => { btn.textContent = original; }, 1200);
        } catch (e) {
            console.warn('[invitation] clipboard write failed:', e.message || e);
        }
    });

    document.getElementById('button-peer-join')?.addEventListener('click', async () => {
        const raw = peerCodeInput?.value || '';
        if (!raw.trim()) { setStatus(peerJoinStatus, t('invitation.peerInvalidCode'), 'fail'); return; }
        setStatus(peerJoinStatus, t('invitation.peerConnecting'), '');
        try {
            const { gameName, token } = await joinPeerMatch(raw);
            if (selectedGame && gameName !== selectedGame)
                setStatus(peerJoinStatus, t('invitation.gameMismatch', { game: gameName }), 'warn');
            await startMatch({
                gameName, matchId: 'p2p:' + token.slice(0, 12),
                player: 'b', peer: true,
            });
        } catch (e) {
            console.warn('[invitation] peer join failed:', e.message || e);
            setStatus(peerJoinStatus,
                e.message === 'code d\'invitation invalide'
                    ? t('invitation.peerInvalidCode') : t('invitation.peerConnectFail'), 'fail');
        }
    });

    await twu.ready();
});
