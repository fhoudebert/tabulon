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
import { generateChatKey, deriveChatKey, chatKeyId } from './remote-secret.js';
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
    /**
     * La cle a donner a une nouvelle partie.
     *
     * LA CLE DE COMMUNAUTE D'ABORD (Preferences -> Conversations) : elle a
     * deja ete echangee une fois avec les personnes avec qui on joue, donc le
     * lien n'a plus rien a leur apprendre et il n'y a AUCUN geste a faire.
     * C'est tout l'interet du reglage : l'echange manuel a lieu une fois, pas
     * une fois par partie.
     *
     * A defaut, une cle tiree au hasard, transportee par le fragment du lien
     * comme avant -- ce qui reste le bon comportement face a un adversaire
     * inconnu, qui n'a pas notre cle de communaute.
     *
     * Et si le tirage lui-meme echoue, pas de cle du tout plutot qu'une cle
     * devinable : une protection qui n'en est pas une est pire que rien.
     */
    /** La cle de communaute selectionnee, ou null. */
    async function selectedCommunityKey() {
        const keys = await store?.get('community-keys').catch(() => null);
        const id = await store?.get('community-key-current').catch(() => null);
        if (!Array.isArray(keys) || !keys.length) return null;
        return keys.find(k => k.id === id) || keys[0] || null;
    }

    /**
     * La cle a donner a une nouvelle partie, et ce que le lien doit en dire.
     *
     * AVEC UNE CLE DE COMMUNAUTE : on DERIVE celle de la partie, et le lien ne
     * transporte que l'EMPREINTE du trousseau employe. Rien de secret ne
     * circule, il n'y a rien a perdre a la copie, et l'invite -- qui a la meme
     * cle -- recalcule exactement la meme chose de son cote.
     *
     * SANS : une cle tiree au hasard, transportee par le fragment du lien
     * comme avant. C'est le bon comportement face a un adversaire inconnu, qui
     * n'a aucune cle en commun avec nous.
     *
     * Et si le tirage lui-meme echoue, pas de cle du tout plutot qu'une cle
     * devinable : une protection qui n'en est pas une est pire que rien.
     */
    async function inviteChatKey(matchId) {
        const community = await selectedCommunityKey();
        if (community?.key) {
            try {
                return {
                    chatKey: await deriveChatKey(community.key, matchId),
                    chatKeyId: await chatKeyId(community.key),
                    derived: true,
                };
            } catch (e) {
                console.warn('[invitation] derivation impossible :', e.message || e);
            }
        }
        try { return { chatKey: generateChatKey(), chatKeyId: null, derived: false }; }
        catch (e) {
            console.warn('[invitation] pas de cle de discussion :', e.message || e);
            return { chatKey: null, chatKeyId: null, derived: false };
        }
    }

    /**
     * La cle de discussion d'une partie qu'on rejoint.
     *
     * Le lien porte SOIT une cle (adversaire inconnu), SOIT l'empreinte du
     * trousseau a employer (adversaire de la meme communaute). Dans le second
     * cas on cherche parmi nos cles celle qui porte cette empreinte -- le nom
     * qu'on lui a donne n'a aucune importance, c'est la cle elle-meme qui la
     * produit -- et on en derive celle de la partie.
     *
     * Empreinte inconnue : on ne connait pas ce groupe. La partie demarre SANS
     * discussion, ce qui est un etat normal ; la fenetre de discussion permet
     * de coller une cle a la main si besoin.
     */
    async function joinChatKey(parsed) {
        if (parsed.chatKey) return parsed.chatKey;
        if (!parsed.chatKeyId) return null;
        const keys = await store?.get('community-keys').catch(() => null);
        if (!Array.isArray(keys)) return null;
        for (const entry of keys) {
            if (!entry?.key) continue;
            try {
                if (await chatKeyId(entry.key) !== parsed.chatKeyId) continue;
                return await deriveChatKey(entry.key, parsed.matchId);
            } catch (e) {
                console.warn('[invitation] trousseau illisible :', e.message || e);
            }
        }
        console.info('[invitation] aucune cle de communaute ne correspond a cette invitation');
        return null;
    }

    async function startMatch({ gameName, matchId, relayUrl, player, creator, peer, chatKey = null }) {
        const inviteId = 'inv-' + Date.now();
        /*
         * La cle de discussion est rangee AVEC l'invitation, et nulle part
         * ailleurs : elle est propre a cette partie, elle arrive par le lien
         * ou le code, et c'est play.js qui la reprendra pour ouvrir le canal.
         *
         * Absente = pas de discussion pour cette partie. C'est un etat normal,
         * pas une panne : une invitation d'avant cette version, ou un hote qui
         * n'en a pas voulu.
         */
        await store.set('invite:' + inviteId, {
            matchId, relayUrl, gameName, player,
            creator: !!creator, peer: !!peer, chatKey: chatKey || null,
        });
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
        await startMatch({ ...parsed, chatKey: await joinChatKey(parsed) });
    });

    // -- Create + Start -------------------------------------------------------------
    let created = null;  // {gameName, matchId, relayUrl, player:'a'} une fois Create cliqué

    document.getElementById('button-create')?.addEventListener('click', () => {
        if (!selectedGame) { setStatus(createStatus, t('invitation.invalidLink'), 'fail'); return; }
        const relayUrl = relayInput?.value.trim() || DEFAULT_RELAY_URL;
        const matchId = generateMatchId();
        /*
         * Une cle par partie, tiree au sort ici et transportee par le lien --
         * dans son FRAGMENT, que le navigateur n'envoie jamais au serveur
         * (voir buildInvitationUrl). C'est ce qui fait que le relai stocke la
         * conversation sans pouvoir la lire.
         *
         * Si le tirage echoue -- pas de source d'alea sure -- on cree la
         * partie SANS discussion plutot qu'avec une cle devinable : une
         * protection qui n'en est pas une serait pire que pas de protection.
         */
        const { chatKey, chatKeyId: kid, derived } = await inviteChatKey(matchId);
        // Une cle derivee ne voyage PAS : le lien ne porte que l'empreinte du
        // trousseau, et l'invite en deduit la meme cle.
        const link = buildInvitationUrl({ relayUrl, gameName: selectedGame, matchId, player: 'b',
            chatKey: derived ? null : chatKey, chatKeyId: derived ? kid : null });
        if (!link) { setStatus(createStatus, t('players.testFail'), 'fail'); return; }
        created = { gameName: selectedGame, matchId, relayUrl, player: 'a', creator: true, chatKey };
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
        /*
         * PAS DE DERIVATION EN PAIR-A-PAIR, et ce n'est pas un oubli.
         *
         * La derivation sert a ne rien faire circuler la ou un relai pourrait
         * l'intercepter. Ici le code est copie-colle d'un joueur a l'autre et
         * le flux est direct : il n'y a aucun serveur a qui cacher la cle, et
         * une cle tiree au hasard dans le code ne coute rien. Elle evite meme
         * de faire dependre la discussion d'un trousseau partage, la ou deux
         * joueurs sur le meme reseau n'en ont peut-etre aucun.
         */
        let chatKey = null;
        try { chatKey = generateChatKey(); }
        catch (e) { console.warn('[invitation] pas de cle de discussion :', e.message || e); }
        try {
            const { code, token } = await hostPeerMatch(selectedGame, { port, extraAddresses, chatKey });
            peerHosting = {
                gameName: selectedGame, matchId: 'p2p:' + token.slice(0, 12),
                player: 'a', peer: true, creator: true, chatKey,
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
            const { gameName, token, chatKey } = await joinPeerMatch(raw);
            if (selectedGame && gameName !== selectedGame)
                setStatus(peerJoinStatus, t('invitation.gameMismatch', { game: gameName }), 'warn');
            await startMatch({
                gameName, matchId: 'p2p:' + token.slice(0, 12),
                player: 'b', peer: true, chatKey,
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
