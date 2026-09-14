// app/content/remote-chat-channel.js -- Le transport des messages qui ne sont
// pas des coups : discussion, présence, relance.
//
// Deux implémentations, la même interface, exactement comme RemoteChannel a
// HttpRelayChannel et PeerChannel. La fenêtre qui affichera la conversation
// n'aura à savoir ni où passe le fil, ni comment il est stocké.
//
// ── Pourquoi un canal SÉPARÉ du canal de partie ──────────────────────────────
//
// Il aurait été plus court de faire circuler les messages dans l'enveloppe des
// coups. C'aurait été un piège : le canal de partie est en dernier-écrit-gagne
// sur les deux relais, et un message de discussion écrit dans la même clé
// écraserait le coup qui n'a pas encore été lu. Le pair-à-pair a le même
// défaut sous une autre forme -- peer_last_message ne garde QU'UNE ligne pour
// le rattrapage.
//
// ── Sur relai : le point d'entrée chatioaction, partagé avec joclymatch ──────
//
// RelayChatChannel écrit UN MESSAGE dans le fil commun de la partie
// (chatioaction=save), et le serveur l'AJOUTE. Les deux joueurs écrivent dans
// le même fichier, comme joclymatch, et se lisent donc l'un l'autre.
//
// C'est ce qui a remplacé la forme précédente -- deux clés de partie
// ordinaires, un fil par joueur réécrit en entier à chaque message. Cette
// forme évitait la concurrence sans rien demander au serveur, mais elle
// isolait Tabulon : un joueur joclymatch sur la même partie ne voyait rien de
// ce qui s'y disait, et réciproquement. Le serveur sachant ajouter, il n'y a
// plus de concurrence à éviter -- et plus de raison d'être seul.
//
// Le format des lignes est celui de joclymatch, enrichi de champs FACULTATIFS
// (kind, quick, state, enc) : voir toRelayMessage / fromRelayMessage. Un
// client qui les ignore n'en souffre pas.
//
// ── En pair-à-pair : rien à stocker ──────────────────────────────────────────
//
// PeerChatChannel envoie la ligne sur la session TCP et garde localement ce
// qu'il a vu passer. Rien ne transite par un serveur -- mais le flux est en
// clair (pas de TLS), ce que remote-peer-channel.js documente déjà : sur
// Internet, à travers une redirection de port, une conversation pair-à-pair
// traverse autant de machines qu'une autre.
//
// LE TEXTE LIBRE EST DONC SCELLÉ ICI AUSSI, par la même règle que sur le relai
// (sealMessage). Ce n'était pas le cas : le message partait tel quel, et comme
// decodeThread refuse un corps sans marqueur `enc`, il s'affichait en face
// « message envoyé sans protection — non affiché ». Le texte libre était donc
// inutilisable en pair-à-pair, clé ou pas -- alors qu'il marchait par relai.
// Le scellement n'est pas un supplément : c'est ce que le format exige, et le
// pair-à-pair est précisément le cas où le transport ne protège rien.

import { httpFetch, invoke as tauriInvoke, listen as tauriListen } from './tauri-bridge.js';
import { buildChatSaveBody, buildChatLoadBody, ENVELOPE_KIND } from './remote-relay-protocol.js';
import {
    newMessage, decodeThread, mergeThreads, sealMessage,
    toRelayMessage, fromRelayMessage, requiresSeal,
} from './remote-chat-protocol.js';

/**
 * Interface commune. Comme RemoteChannel : l'appelant ne voit que ça.
 */
export class ChatChannel {
    async start() { throw new Error('ChatChannel.start() non implémenté'); }
    stop() { throw new Error('ChatChannel.stop() non implémenté'); }
    /** @param {{kind:string, body?:string, state?:string}} msg */
    async send(_msg) { throw new Error('ChatChannel.send() non implémenté'); }
    /** Rappel appelé avec la conversation ENTIÈRE à chaque changement. */
    onConversation(callback) { this._onConversation = callback; }

    constructor() {
        this._onConversation = null;
        this._mine = [];       // ce que NOUS avons écrit
        /*
         * Le fil du relai est-il plein ?
         *
         * fileio.php plafonne le fichier de conversation (256 Ko par defaut) et
         * REFUSE au-dela. Ce n'est pas une panne : c'est une fin de course
         * prevue, et elle arrive a deux joueurs bavards sur une partie par
         * correspondance. Un etat, donc, et pas une erreur reseau -- il ne
         * disparaitra pas en reessayant.
         */
        this._full = false;
        this._theirs = [];     // ce que nous avons reçu
        this._lastError = null;
    }

    get lastError() { return this._lastError; }

    /** Le relai refuse-t-il d'en accepter davantage ? */
    get full() { return this._full; }

    /** La conversation telle qu'elle doit s'afficher. */
    get conversation() { return mergeThreads(this._mine, this._theirs); }

    /**
     * Recolle et prévient -- mais SEULEMENT si quelque chose a changé.
     *
     * Le fil d'en face est relu en entier à chaque tour de sondage, donc la
     * plupart des tours ne rapportent rien de neuf. Prévenir quand même
     * ferait redessiner la fenêtre toutes les secondes et demie, et ferait
     * clignoter une pastille de « nouveau message » qui n'en est pas un.
     */
    _publish() {
        const conv = this.conversation;
        const stamp = conv.length + ':' + (conv.length ? conv[conv.length - 1].id : '');
        if (stamp === this._lastStamp) return;
        this._lastStamp = stamp;
        this._onConversation?.(conv);
    }
}

// ── Relai HTTP ───────────────────────────────────────────────────────────────

export class RelayChatChannel extends ChatChannel {
    /**
     * @param {object} opts
     * @param {string} opts.relayUrl
     * @param {string} opts.matchId  - celui de la partie ; les clés des deux
     *   fils en dérivent, donc les deux joueurs les trouvent sans se concerter.
     * @param {1|-1} opts.side       - notre camp : décide laquelle est la nôtre.
     * @param {{seal:Function,open:Function}} [opts.sealer] - sans lui, un
     *   message de discussion sera REFUSÉ à l'envoi (voir encodeThread).
     */
    constructor({ relayUrl, matchId, side, sealer = null, allowClear = false,
                  quickText = null, pollIntervalMs = 3000, fetchImpl = httpFetch }) {
        super();
        if (!relayUrl) throw new Error('RelayChatChannel: relayUrl requis');
        if (!matchId) throw new Error('RelayChatChannel: matchId requis');
        this._relayUrl = relayUrl;
        this._sealer = sealer;
        /*
         * LE REGIME CLAIR EST UNE AUTORISATION EXPLICITE, PAS UNE CONSEQUENCE.
         *
         * Une partie creee par Tabulon porte toujours une cle ; le texte libre
         * y est scelle, et un envoi sans scelleur ECHOUE. C'est ce refus qui
         * rend la protection honnete, et le demenagement ne doit rien lui
         * retirer.
         *
         * Une partie rejointe par un lien joclymatch, elle, n'a pas de cle --
         * l'autre bout n'en a pas non plus, et rien a chiffrer avec. Le clair
         * y est le seul regime possible, et il est celui que l'autre joueur
         * attend.
         *
         * D'ou un drapeau POSE PAR L'APPELANT plutot que deduit de l'absence
         * de scelleur : un scelleur qui n'a pas pu se construire -- cle
         * abimee, commande Rust indisponible -- ne doit surtout pas valoir
         * permission d'ecrire en clair. C'est exactement le chemin par lequel
         * une protection se perd sans que personne l'ait decide.
         */
        this._allowClear = !!allowClear;
        /*
         * Traduction d'un message rapide, pour le champ `msg` du fil commun.
         *
         * Sans elle, `msg` vaut la chaine vide et joclymatch affiche une BULLE
         * VIDE -- constate en faisant dialoguer les deux applications. Le
         * module de protocole reste pur : c'est l'appelant qui fournit de quoi
         * traduire, parce que c'est lui qui connait la langue.
         */
        this._quickText = typeof quickText === 'function' ? quickText : null;
        this._pollIntervalMs = pollIntervalMs;
        this._fetch = fetchImpl;
        // UNE seule cle, celle de la partie : le serveur AJOUTE, donc il n'y a
        // plus de concurrence a eviter et plus de fil a reecrire. Les deux
        // joueurs ecrivent dans le meme fichier, comme joclymatch.
        this._mid = matchId;
        this._polling = false;
        this._timer = null;
        this._side = side;
    }

    async start() {
        if (this._polling) return;
        this._polling = true;
        // Plus besoin de relire notre propre fil avant d'ecrire : on n'ecrase
        // plus rien, on ajoute. Le premier sondage rapporte tout, y compris ce
        // que nous avions dit lors d'une session precedente.
        this._scheduleNext(0);
    }

    stop() {
        this._polling = false;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    }

    async send({ kind, body = null, quick = null, state = null }) {
        const msg = newMessage({ kind, side: this._side, body, quick, state });

        /*
         * Le texte libre est scelle, ou refuse -- sauf permission explicite.
         * Les messages rapides et la presence ne portent aucun texte : ils
         * passent dans les deux regimes, et c'est ce qui permet de dire « je
         * fais une pause » a un joueur joclymatch.
         */
        let seal = null;
        if (requiresSeal(msg)) {
            // sealMessage prend le MESSAGE, pas son texte : c'est lui qui
            // porte la garde (requiresSeal) et qui pose le marqueur `enc`.
            // Lui passer une chaine le faisait rendre cette chaine telle
            // quelle -- du clair, sous couvert de scellement.
            if (this._sealer) seal = (await sealMessage(msg, this._sealer)).body;
            else if (!this._allowClear)
                throw new Error('RelayChatChannel: un message de discussion ne peut pas partir '
                    + 'en clair sur une partie protegee (aucun scelleur)');
        }
        const repli = msg.quick && this._quickText ? this._quickText(msg.quick) : null;
        const line = JSON.stringify({ data: toRelayMessage(msg, seal, repli) });
        /*
         * SCELLER D'ABORD, RETENIR ENSUITE.
         *
         * Le fil n'est plus déposé en entier -- une ligne est ajoutée -- donc
         * un message refusé n'empoisonne plus les suivants. La règle tient
         * quand même, et pour une meilleure raison : un message que le
         * scellement refuse ne doit laisser AUCUNE trace dans notre fil,
         * sinon il s'afficherait chez nous comme s'il était parti.
         */
        // Retenu localement pour l'affichage immediat ; le sondage le
        // rapportera aussi, et mergeThreads le dedupliquera par identifiant.
        this._mine = [...this._mine, msg];
        this._publish();

        const res = await this._post(buildChatSaveBody(this._mid, line));
        if (res && res.status === 413) {
            /*
             * LE FIL EST PLEIN, et le message n'est PAS parti.
             *
             * Le laisser affiche chez nous serait un mensonge : l'autre joueur
             * ne le verra jamais, et rien a l'ecran ne le dirait. On le retire
             * donc, et on leve avec un code que l'interface sait nommer --
             * « reessayez » n'aurait aucun sens, le refus est definitif.
             *
             * La LECTURE continue : un fil plein reste lisible, et couper la
             * conversation entiere parce qu'on ne peut plus y ajouter serait
             * disproportionne.
             */
            this._full = true;
            this._mine = this._mine.filter(m => m.id !== msg.id);
            this._publish();
            const err = new Error('le fil de conversation du relai est plein');
            err.code = 'chat-full';
            throw err;
        }
        return msg;
    }

    // -- interne ---------------------------------------------------------------

    _scheduleNext(delayMs) {
        if (!this._polling) return;
        this._timer = setTimeout(() => this._pollOnce(), delayMs);
    }

    async _pollOnce() {
        if (!this._polling) return;
        try {
            this._theirs = await this._readThread();
            this._lastError = null;
            this._publish();
        } catch (e) {
            // Même politique que le canal de partie : une panne réseau
            // ponctuelle ne doit pas casser la partie en cours. On retente.
            this._lastError = e;
            console.warn('[remote-chat] lecture échouée :', e.message || e);
        }
        this._scheduleNext(this._pollIntervalMs);
    }

    /**
     * Relit le fil entier -- les deux joueurs meles, dans l'ordre du fichier.
     *
     * Chaque ligne est traduite puis passee a decodeThread, qui reste la SEULE
     * porte de validation : c'est elle qui ecarte un message mal forme et qui
     * ouvre les sceaux. Ecrire ici un second controle le ferait diverger du
     * premier.
     */
    async _readThread() {
        const res = await this._post(buildChatLoadBody(this._mid));
        let payload;
        try { payload = JSON.parse(await res.text()); } catch { return []; }
        const raw = Array.isArray(payload?.messages) ? payload.messages : [];
        const msgs = raw.map(fromRelayMessage).filter(Boolean);
        return await decodeThread(JSON.stringify({ msgs }),
            { sealer: this._sealer, allowClear: this._allowClear });
    }

    async _post(body) {
        return this._fetch(this._relayUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });
    }
}

// ── Pair-à-pair ──────────────────────────────────────────────────────────────

export class PeerChatChannel extends ChatChannel {
    /**
     * @param {object} opts
     * @param {1|-1} opts.side
     * @param {{seal:Function,open:Function}} [opts.sealer] - MÊME rôle que sur
     *   le relai : sans lui, un message de texte libre est refusé à l'envoi
     *   plutôt que d'arriver illisible en face. La clé vient du code
     *   d'invitation pair-à-pair, qui la transporte déjà (voir
     *   remote-peer-protocol.js).
     * @param {Function} [opts.invokeImpl] / [opts.listenImpl] - injectables
     *   pour les tests, comme PeerChannel.
     */
    constructor({ side, sealer = null, invokeImpl = tauriInvoke, listenImpl = tauriListen }) {
        super();
        this._side = side;
        this._sealer = sealer;
        this._invoke = invokeImpl;
        this._listen = listenImpl;
        this._unlisteners = [];
        this._started = false;
    }

    async start() {
        if (this._started) return;
        this._started = true;
        this._unlisteners.push(await this._listen('tabulon-peer://message',
            ev => this._handleLine(ev.payload)));
    }

    stop() {
        this._started = false;
        this._unlisteners.forEach(un => { try { un(); } catch { /* déjà délié */ } });
        this._unlisteners = [];
        /*
         * PAS de peer_stop ici, contrairement à PeerChannel : la session TCP
         * appartient à la partie, pas à la conversation. Fermer la fenêtre de
         * discussion ne doit pas couper le lien par lequel passent les coups.
         */
    }

    async send({ kind, body = null, quick = null, state = null }) {
        const msg = newMessage({ kind, side: this._side, body, quick, state });

        /*
         * Le texte libre est scelle, ou refuse -- sauf permission explicite.
         * Les messages rapides et la presence ne portent aucun texte : ils
         * passent dans les deux regimes, et c'est ce qui permet de dire « je
         * fais une pause » a un joueur joclymatch.
         */
        /*
         * SCELLER D'ABORD, RETENIR ENSUITE, même raisonnement que sur le relai
         * : un message que le scellement refuse ne doit laisser aucune trace
         * dans notre fil, sinon il s'afficherait chez nous comme s'il était
         * parti.
         *
         * ICI, CONTRAIREMENT AU RELAI, IL N'Y A PAS DE REGIME CLAIR. Le
         * pair-a-pair n'existe qu'entre deux Tabulon, et son code d'invitation
         * porte toujours une cle : un texte libre sans scelleur est donc une
         * erreur de programmation, pas une configuration possible. C'est
         * sealMessage qui le refuse, en un seul endroit.
         *
         * Le corps de cette methode dupliquait celui du relai : il calculait
         * un `seal` et une `line` au format joclymatch -- inutiles, le
         * pair-a-pair transportant le format Tabulon -- puis appelait
         * sealMessage une SECONDE fois. Deux scellements du meme texte, deux
         * nonces, et un message compose a partir du second.
         */
        const wire = await sealMessage(msg, this._sealer);
        this._mine = [...this._mine, msg];   // en clair CHEZ NOUS : c'est ce qu'on relit
        this._publish();
        // Un message par ligne, comme les coups : le transport Rust relaie des
        // lignes et ne regarde pas ce qu'elles contiennent.
        await this._invoke('peer_send', { line: JSON.stringify(wire) });
        return msg;
    }

    // -- interne ---------------------------------------------------------------

    async _handleLine(line) {
        let data;
        try { data = JSON.parse(line); } catch { return; }
        // Le canal transporte AUSSI les coups : ils passent par le même
        // événement. Un coup n'a pas de `kind`, ou porte `move` -- dans les
        // deux cas il ne nous concerne pas, et c'est PeerChannel qui le lit.
        if (!data || typeof data !== 'object') return;
        if (data.kind === undefined || data.kind === ENVELOPE_KIND.MOVE) return;
        // Relu par decodeThread pour n'accepter qu'un message bien formé --
        // la même porte que sur le relai, plutôt qu'une seconde validation
        // écrite à part qui divergerait.
        const [msg] = await decodeThread(JSON.stringify({ msgs: [data] }),
            { sealer: this._sealer });
        if (!msg) return;
        // Un message que NOUS avons écrit ne revient pas : le transport est
        // direct, chacun n'entend que l'autre. Le filtre est là par sûreté --
        // mergeThreads déduplique de toute façon par identifiant.
        if (msg.side === this._side) return;
        this._theirs = mergeThreads(this._theirs, [msg]);
        this._publish();
    }
}
