// app/content/remote-peer-channel.js -- Jeu a distance en pair-a-pair :
// PeerChannel, deuxieme implementation de l'interface RemoteChannel (apres
// HttpRelayChannel), par-dessus la session TCP directe portee cote Rust
// (src-tauri/src/commands/peer_cmds.rs -- voir README § Remote play, etape 8,
// pour la decision "TCP cote Rust plutot que WebRTC", verifiee empiriquement).
//
// gameLoop() (play.js) ne voit que l'interface RemoteChannel
// (start/stop/push/onRemoteMove/resetBaseline) : rien n'y change quand
// l'adversaire passe du relai HTTP au pair-a-pair.
//
// Particularite d'architecture : la CONNEXION n'appartient pas a cette
// classe mais a l'application (etat Rust). La fenetre Invitation etablit la
// session (hostPeerMatch/joinPeerMatch ci-dessous), puis se ferme ; la
// fenetre de jeu cree ensuite un PeerChannel qui ne fait que S'ATTACHER a la
// session existante (events tabulon-peer://message + commande peer_send).
// Un coup arrive entre les deux est rattrape via peer_last_message (le Rust
// garde le dernier message recu) -- le filtre hasOpponentMoved rend toute
// relecture inoffensive, exactement comme pour le polling du relai HTTP.

import { invoke as tauriInvoke, listen as tauriListen } from './tauri-bridge.js';
import { encodeEnvelope, decodeEnvelope, hasOpponentMoved } from './remote-relay-protocol.js';
import { encodePeerCode, decodePeerCode, generatePeerToken } from './remote-peer-protocol.js';
import { RemoteChannel } from './remote-channel.js';

export class PeerChannel extends RemoteChannel {
    /**
     * @param {object} [opts]
     * @param {string} [opts.matchId='p2p'] - identifiant purement local (le
     *   jeton de session tient ce role cote transport) ; sert a
     *   ensureRemoteChannel (play.js) pour decider de reutiliser le canal.
     * @param {number} [opts.localNbTurns=0] - baseline de coups deja connus.
     * @param {Function} [opts.invokeImpl] / @param {Function} [opts.listenImpl]
     *   injectables pour les tests (tests/test-remote-peer-channel.mjs).
     */
    constructor({ matchId = 'p2p', localNbTurns = 0, invokeImpl = tauriInvoke, listenImpl = tauriListen } = {}) {
        super();
        this._matchId = matchId;
        this._localNbTurns = localNbTurns;
        this._invoke = invokeImpl;
        this._listen = listenImpl;
        this._onRemoteMove = null;
        this._onStatusChange = null;
        this._unlisteners = [];
        this._started = false;
        this._lastError = null;
    }

    get matchId() { return this._matchId; }
    get lastError() { return this._lastError; }

    onRemoteMove(callback) { this._onRemoteMove = callback; }

    /**
     * Callback {connected:boolean, error?:string} quand la session change
     * d'etat (deconnexion du pair, arret...). Propre au pair-a-pair : le
     * relai HTTP n'a pas de notion de presence, ici on peut prevenir
     * l'utilisateur que l'adversaire est parti.
     */
    onStatusChange(callback) { this._onStatusChange = callback; }

    /** Meme role que HttpRelayChannel.resetBaseline (takeback, restart...). */
    resetBaseline(nbTurns) { this._localNbTurns = nbTurns; }

    async start() {
        if (this._started) return;
        this._started = true;
        this._unlisteners.push(await this._listen('tabulon-peer://message',
            ev => this._handleLine(ev.payload)));
        this._unlisteners.push(await this._listen('tabulon-peer://status',
            ev => {
                const p = ev.payload || {};
                if (p.error) this._lastError = new Error(String(p.error));
                this._onStatusChange?.({ connected: !!p.connected, error: p.error || null });
            }));
        // Rattrapage : un coup a pu arriver entre l'etablissement de la
        // session (fenetre Invitation) et notre abonnement (fenetre de jeu).
        try {
            const last = await this._invoke('peer_last_message');
            if (last) this._handleLine(last);
        } catch (e) {
            this._lastError = e;
        }
    }

    stop() {
        this._started = false;
        this._unlisteners.forEach(un => { try { un(); } catch { /* deja delie */ } });
        this._unlisteners = [];
        // Fin de la session cote Rust aussi : contrairement au polling HTTP
        // (sans etat), la session TCP est une ressource a liberer.
        this._invoke('peer_stop').catch(() => {});
    }

    async push({ nbTurns, lastMove = null, state = null }) {
        this._localNbTurns = nbTurns;
        await this._invoke('peer_send', { line: encodeEnvelope({ nbTurns, lastMove, state }) });
    }

    // -- interne ---------------------------------------------------------------

    _handleLine(line) {
        // decodeEnvelope renvoie null (jamais d'exception) sur un contenu
        // illisible ; hasOpponentMoved(_, null) est faux -- rien a faire.
        const remote = decodeEnvelope(line);
        if (hasOpponentMoved(this._localNbTurns, remote)) {
            this._localNbTurns = remote.nbTurns;
            this._onRemoteMove?.(remote);
        }
    }
}

// -- Etablissement de session (fenetre Invitation) -------------------------------

/**
 * Cote HOTE : demarre l'ecoute Rust et construit le code d'invitation a
 * transmettre a l'autre joueur. La connexion effective arrivera plus tard
 * (event tabulon-peer://status {connected:true}) -- a ecouter cote UI.
 * @returns {Promise<{code:string, token:string}>}
 */
export async function hostPeerMatch(gameName, { invokeImpl = tauriInvoke } = {}) {
    const token = generatePeerToken();
    const info = await invokeImpl('peer_host_start', { token });
    const code = encodePeerCode({ gameName, ips: info.ips, port: info.port, token });
    if (!code) throw new Error('code d\'invitation impossible a construire');
    return { code, token };
}

/**
 * Cote INVITE : decode le code colle et etablit la session (peer_connect ne
 * rend la main qu'une fois connecte, ou en erreur).
 * @returns {Promise<{gameName:string, token:string}>} infos du code
 * @throws si le code est invalide ou qu'aucune adresse ne repond
 */
export async function joinPeerMatch(code, { invokeImpl = tauriInvoke } = {}) {
    const parsed = decodePeerCode(code);
    if (!parsed) throw new Error('code d\'invitation invalide');
    await invokeImpl('peer_connect', { addrs: parsed.ips, port: parsed.port, token: parsed.token });
    return { gameName: parsed.gameName, token: parsed.token };
}
