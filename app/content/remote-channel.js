// app/content/remote-channel.js -- Jouer à distance : interface de transport
// et première implémentation (relai HTTP, protocole fileio.php).
//
// Étape 1 (branche remoteplay) : ce module fournit uniquement l'abstraction
// et le transport. Il n'est PAS encore branché sur play.js/gameLoop() -- ça
// viendra dans une étape suivante, une fois ce module validé isolément
// (tests/test-remote-channel.mjs avec un relai mocké, et
// scripts/check-remote-relay.mjs contre une vraie instance jocly-simple-match).
//
// Pourquoi une classe abstraite : la boucle de jeu (gameLoop) ne doit jamais
// avoir à savoir si l'adversaire distant parle par relai HTTP, WebSocket ou
// pair-à-pair (voir DEVELOPMENT.md § Remote play). Elle appelle seulement
// push()/onRemoteMove() sur l'objet RemoteChannel qu'on lui donne.

import { httpFetch } from './tauri-bridge.js';
import {
    encodeEnvelope, decodeEnvelope, hasOpponentMoved, hasOpponentTakenBack,
    resolveAllowTakeback, buildSaveBody, buildLoadBody,
    encodeJoclySimpleMatchEnvelope, decodeJoclySimpleMatchEnvelope,
} from './remote-relay-protocol.js';

/**
 * Interface transport-agnostique. Toute implémentation (HttpRelayChannel,
 * plus tard WebSocketChannel, PeerChannel...) doit fournir ces méthodes.
 */
export class RemoteChannel {
    /** Démarre la réception (connexion, boucle de polling...). */
    async start() { throw new Error('RemoteChannel.start() non implémenté'); }

    /** Arrête proprement la réception. */
    stop() { throw new Error('RemoteChannel.stop() non implémenté'); }

    /**
     * Transmet l'état après un coup joué localement.
     * @param {{nbTurns:number, lastMove:*, state:*}} payload
     */
    async push(_payload) { throw new Error('RemoteChannel.push() non implémenté'); }

    /**
     * Enregistre le callback appelé quand un coup adverse est détecté.
     * @param {(payload:{nbTurns:number, lastMove:*, state:*}) => void} callback
     */
    onRemoteMove(_callback) { throw new Error('RemoteChannel.onRemoteMove() non implémenté'); }

    /*
     * REPRISE DE COUP -- commun aux deux implementations.
     *
     * Une annulation adverse se reconnait a un nbTurns qui BAISSE ; elle est
     * remise a onRemoteTakeback avec l'etat complet, jamais a onRemoteMove
     * (voir hasOpponentTakenBack pour le piege evite).
     *
     * Le reglage `allowTakeback` est une propriete de la PARTIE : chaque
     * enveloppe recue qui le porte le met a jour (le fichier fait foi), chaque
     * enveloppe emise le recopie. `allowTakeback` a la construction est ce
     * que l'invitation annoncait ; quand personne ne dit rien, la reprise
     * est interdite (voir resolveAllowTakeback).
     */
    _initTakeback({ allowTakeback = null } = {}) {
        this._linkAllowTakeback = typeof allowTakeback === 'boolean' ? allowTakeback : null;
        this._fileAllowTakeback = null;
        this._onRemoteTakeback = null;
        this._onSettingsChange = null;
    }

    /** Le reglage effectif, toujours un booleen. */
    get allowTakeback() {
        return resolveAllowTakeback(this._fileAllowTakeback, this._linkAllowTakeback);
    }

    /** Ce qu'on ECRIT : la valeur connue, ou null (champ omis) si personne ne l'a dite. */
    _knownAllowTakeback() {
        return this._fileAllowTakeback ?? this._linkAllowTakeback;
    }

    /**
     * Callback appele quand l'adversaire a repris un ou plusieurs coups (ou
     * recommence) : payload {nbTurns, state, ...}, a CHARGER tel quel.
     */
    onRemoteTakeback(callback) { this._onRemoteTakeback = callback; }

    /** Callback {allowTakeback} quand le reglage effectif change. */
    onSettingsChange(callback) { this._onSettingsChange = callback; }

    _learnSettings(remote) {
        if (typeof remote?.allowTakeback !== 'boolean') return;
        const before = this.allowTakeback;
        this._fileAllowTakeback = remote.allowTakeback;
        if (this.allowTakeback !== before) this._onSettingsChange?.({ allowTakeback: this.allowTakeback });
    }

    /** Aiguille une enveloppe recue : coup, annulation, ou rien. */
    _dispatchRemote(remote) {
        this._learnSettings(remote);
        if (hasOpponentMoved(this._localNbTurns, remote)) {
            this._localNbTurns = remote.nbTurns;
            this._onRemoteMove?.(remote);
        } else if (hasOpponentTakenBack(this._localNbTurns, remote)) {
            this._localNbTurns = remote.nbTurns;
            this._onRemoteTakeback?.(remote);
        }
    }
}

/**
 * Relai HTTP par polling, compatible avec le fileio.php de jocly-simple-match
 * (https://framagit.org/jcfrog/jocly-simple-match) -- donc utilisable dès
 * maintenant contre une instance existante telle que
 * https://biscandine.fr/variantes/joclymatch/fileio.php, ou contre une copie
 * de ce même script déployée ailleurs (voir DEVELOPMENT.md § Remote play).
 */
export class HttpRelayChannel extends RemoteChannel {
    /**
     * @param {object} opts
     * @param {string} opts.relayUrl - URL complète du script fileio.php
     * @param {string} opts.matchId - identifiant de partie (voir generateMatchId)
     * @param {number} [opts.localNbTurns=0] - compteur de coups déjà connus localement
     * @param {number} [opts.pollIntervalMs=1500] - fréquence de polling en attente
     *   (jocly-simple-match utilise 500ms ; on part plus prudent le temps de
     *   valider le comportement contre un relai qu'on ne contrôle pas)
     * @param {(url:string, init?:object) => Promise<{status:number, text():Promise<string>}>} [opts.fetchImpl]
     *   fetch à utiliser -- par défaut httpFetch (plugin-http, cote Rust, pas
     *   de CORS). Injectable pour les tests (relai en mémoire).
     * @param {'tabulon'|'jocly-simple-match'} [opts.codec='tabulon']
     *   'tabulon' : notre enveloppe libre (encodeEnvelope/decodeEnvelope) --
     *   suffisante quand les DEUX cotes sont Tabulon.
     *   'jocly-simple-match' : enveloppe compatible avec le vrai client web
     *   jocly-simple-match (control.js) -- necessaire pour rejoindre une
     *   partie creee via une invitation (index.php?...), potentiellement
     *   jouee en face par ce client web plutot que par une autre instance
     *   de Tabulon. Necessite opts.gameName.
     * @param {string} [opts.gameName] - requis si codec='jocly-simple-match'
     *   (attendu dans matchDetails.gameName par control.js).
     * @param {boolean|null} [opts.allowTakeback=null] - reprise de coup telle
     *   que l'invitation l'annonce (null = elle ne dit rien) ; le fichier du
     *   relai la remplace des qu'il la porte ; ni l'un ni l'autre = interdite.
     */
    constructor({
        relayUrl, matchId, localNbTurns = 0, pollIntervalMs = 1500, fetchImpl = httpFetch,
        codec = 'tabulon', gameName = null, allowTakeback = null,
    }) {
        super();
        if (!relayUrl) throw new Error('HttpRelayChannel: relayUrl requis');
        if (!matchId) throw new Error('HttpRelayChannel: matchId requis');
        if (codec === 'jocly-simple-match' && !gameName)
            throw new Error('HttpRelayChannel: gameName requis pour le codec jocly-simple-match');
        this._relayUrl = relayUrl;
        this._matchId = matchId;
        this._localNbTurns = localNbTurns;
        this._pollIntervalMs = pollIntervalMs;
        this._fetch = fetchImpl;
        this._codec = codec;
        this._gameName = gameName;
        this._onRemoteMove = null;
        this._timer = null;
        this._polling = false;
        this._lastError = null;
        /*
         * DEUX GARDES CONTRE UNE LECTURE PERIMEE.
         *
         * Un sondage parti AVANT une ecriture peut revenir APRES : il rapporte
         * alors l'ancien fichier. Tant qu'on ne faisait qu'avancer, c'etait
         * sans consequence (l'ancien compte est plus petit, donc ignore).
         * Depuis qu'on peut reculer, l'ancien compte est PLUS GRAND que le
         * notre, et serait pris pour un coup adverse -- celui-la meme qu'on
         * vient d'annuler, rejoue sous nos yeux. `_generation` change a chaque
         * ecriture et chaque recalage ; `_pushing` couvre une ecriture encore
         * en vol. Une reponse lue sous l'une ou l'autre est jetee : le sondage
         * suivant relira le fichier a jour.
         */
        this._generation = 0;
        this._pushing = 0;
        this._initTakeback({ allowTakeback });
    }

    get matchId() { return this._matchId; }
    /** Dernière erreur réseau rencontrée (diagnostic UI), null si aucune. */
    get lastError() { return this._lastError; }

    onRemoteMove(callback) { this._onRemoteMove = callback; }

    /**
     * Recale la baseline de comparaison sans rien transmettre au relai.
     * A utiliser quand la position locale change autrement que par un coup
     * poussé (takeback, restart, chargement d'une sauvegarde/etat...) : ces
     * actions n'ont pas d'equivalent cote relai (fileio.php ne sait pas
     * "deposer un coup"), donc elles ne font QUE decaler notre reference
     * locale pour eviter de re-signaler comme "nouveau" un coup deja connu,
     * ou de rater un vrai nouveau coup adverse. Ne resout PAS la
     * desynchronisation avec le relai lui-meme (voir DEVELOPMENT.md § Remote play,
     * limite connue).
     * @param {number} nbTurns
     */
    resetBaseline(nbTurns) {
        this._localNbTurns = nbTurns;
        this._generation++;
    }

    async start() {
        if (this._polling) return;
        this._polling = true;
        this._scheduleNext(0);
    }

    stop() {
        this._polling = false;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    }

    async push({ nbTurns, lastMove = null, state = null }) {
        this._localNbTurns = nbTurns;
        this._generation++;
        const allowTakeback = this._knownAllowTakeback();
        const envelope = this._codec === 'jocly-simple-match'
            ? encodeJoclySimpleMatchEnvelope({ matchId: this._matchId, gameName: this._gameName, nbTurns,
                matchdata: state, allowTakeback })
            : encodeEnvelope({ nbTurns, lastMove, state, allowTakeback });
        const body = buildSaveBody(this._matchId, envelope);
        this._pushing++;
        try { await this._post(body); }
        finally { this._pushing--; }
    }

    // -- interne ---------------------------------------------------------------

    _scheduleNext(delayMs) {
        if (!this._polling) return;
        this._timer = setTimeout(() => this._pollOnce(), delayMs);
    }

    async _pollOnce() {
        if (!this._polling) return;
        try {
            const generation = this._generation;
            const res = await this._post(buildLoadBody(this._matchId));
            const text = await res.text();
            this._lastError = null;
            const remote = this._codec === 'jocly-simple-match'
                ? decodeJoclySimpleMatchEnvelope(text)
                : decodeEnvelope(text);
            // Lecture perimee (voir le constructeur) : on la jette.
            if (generation === this._generation && this._pushing === 0)
                this._dispatchRemote(remote);
        } catch (e) {
            // Panne réseau ponctuelle : on ne fait pas planter la partie, on
            // relogue et on retente au prochain cycle (même logique que
            // jocly-simple-match, qui ignore silencieusement les échecs de
            // checkIfOtherUserPlayed).
            this._lastError = e;
            console.warn('[remote-channel] poll a échoué :', e.message || e);
        }
        this._scheduleNext(this._pollIntervalMs);
    }

    async _post(body) {
        return this._fetch(this._relayUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });
    }
}
