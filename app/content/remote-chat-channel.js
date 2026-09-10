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
// ── Sur relai : deux clés, un seul écrivain chacune ──────────────────────────
//
// RelayChatChannel n'utilise PAS le point d'entrée chatioaction de joclymatch.
// Chaque joueur dépose son propre fil sous une clé de partie ordinaire
// (chatMidFor), n'écrit que dans la sienne et ne lit que celle d'en face. Il
// n'y a donc aucune concurrence -- un seul écrivain par fichier -- et le
// dernier-écrit-gagne devient exact au lieu d'être dangereux.
//
// Le bénéfice qui a décidé de cette forme : le MÊME code marche sur fileio.php
// (joclymatch) et sur match.php (mogichex), sans branche particulière, et les
// deux savent désormais effacer leurs fichiers tout seuls -- expiration par
// ancienneté, plus une action de suppression explicite.
//
// ── En pair-à-pair : rien à stocker ──────────────────────────────────────────
//
// PeerChatChannel envoie la ligne sur la session TCP et garde localement ce
// qu'il a vu passer. Rien ne transite par un serveur, donc la question du
// chiffrement ne se pose pas -- mais le flux est en clair (pas de TLS), ce que
// remote-peer-channel.js documente déjà : hors réseau de confiance, une
// conversation pair-à-pair n'est pas confidentielle non plus.

import { httpFetch, invoke as tauriInvoke, listen as tauriListen } from './tauri-bridge.js';
import { buildSaveBody, buildLoadBody, ENVELOPE_KIND } from './remote-relay-protocol.js';
import {
    chatMidFor, newMessage, encodeThread, decodeThread, mergeThreads,
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
        this._theirs = [];     // ce que nous avons reçu
        this._lastError = null;
    }

    get lastError() { return this._lastError; }

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
    constructor({ relayUrl, matchId, side, sealer = null, pollIntervalMs = 3000, fetchImpl = httpFetch }) {
        super();
        if (!relayUrl) throw new Error('RelayChatChannel: relayUrl requis');
        if (!matchId) throw new Error('RelayChatChannel: matchId requis');
        this._relayUrl = relayUrl;
        this._sealer = sealer;
        this._pollIntervalMs = pollIntervalMs;
        this._fetch = fetchImpl;
        this._mineMid = chatMidFor(matchId, side);
        this._theirsMid = chatMidFor(matchId, side === 1 ? -1 : 1);
        this._polling = false;
        this._timer = null;
        this._side = side;
    }

    async start() {
        if (this._polling) return;
        this._polling = true;
        /*
         * On relit d'abord NOTRE fil : une fenêtre rouverte, ou une partie
         * reprise sur une autre machine, doit retrouver ce qu'elle a dit --
         * sinon le premier message réécrirait la clé et effacerait tout
         * l'historique, puisqu'un fil est déposé en entier.
         */
        this._mine = await this._read(this._mineMid);
        this._scheduleNext(0);
    }

    stop() {
        this._polling = false;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    }

    async send({ kind, body = null, quick = null, state = null }) {
        const msg = newMessage({ kind, side: this._side, body, quick, state });
        /*
         * ENCODER D'ABORD, RETENIR ENSUITE.
         *
         * Le fil est déposé en ENTIER à chaque message, donc un message que
         * l'encodage refuse -- un texte libre sans scelleur -- empoisonnerait
         * tout ce qui suit : il serait réencodé à chaque envoi et les ferait
         * tous échouer, y compris ceux qui n'ont rien à se reprocher. On le
         * valide donc avant de l'ajouter, et un refus ne laisse aucune trace.
         *
         * L'encodage est synchrone : l'affichage local reste immédiat, sans
         * attendre l'aller-retour réseau.
         */
        const next = [...this._mine, msg];
        const payload = await encodeThread(next, { sealer: this._sealer });
        this._mine = next;
        this._publish();
        await this._post(buildSaveBody(this._mineMid, payload));
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
            this._theirs = await this._read(this._theirsMid);
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

    async _read(mid) {
        const res = await this._post(buildLoadBody(mid));
        return await decodeThread(await res.text(), { sealer: this._sealer });
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
     * @param {Function} [opts.invokeImpl] / [opts.listenImpl] - injectables
     *   pour les tests, comme PeerChannel.
     */
    constructor({ side, invokeImpl = tauriInvoke, listenImpl = tauriListen }) {
        super();
        this._side = side;
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
        this._mine = [...this._mine, msg];
        this._publish();
        // Un message par ligne, comme les coups : le transport Rust relaie des
        // lignes et ne regarde pas ce qu'elles contiennent.
        await this._invoke('peer_send', { line: JSON.stringify(msg) });
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
        const [msg] = await decodeThread(JSON.stringify({ msgs: [data] }));
        if (!msg) return;
        // Un message que NOUS avons écrit ne revient pas : le transport est
        // direct, chacun n'entend que l'autre. Le filtre est là par sûreté --
        // mergeThreads déduplique de toute façon par identifiant.
        if (msg.side === this._side) return;
        this._theirs = mergeThreads(this._theirs, [msg]);
        this._publish();
    }
}
