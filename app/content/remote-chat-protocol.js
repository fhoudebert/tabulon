// app/content/remote-chat-protocol.js -- Échanger autre chose que des coups
// avec un adversaire distant : discussion, présence (« je fais une pause »),
// relance.
//
// Logique PURE : aucun import Tauri, DOM ni réseau, comme
// remote-relay-protocol.js et remote-peer-protocol.js. Le transport (relais
// HTTP ou pair-à-pair) reste dans remote-channel.js et
// remote-peer-channel.js ; ce module ne décide que de la FORME de ce qui
// circule.
//
// ── Un seul écrivain par fil, et c'est ce qui rend le relais possible ────────
//
// Les deux relais connus stockent une clé -> une valeur, en dernier-écrit-
// gagne : fileio.php de joclymatch (gameid) et match.php de mogichex (mid).
// Écrire une discussion à deux dans la même clé, c'est une lecture-modification-
// écriture concurrente, donc des messages perdus dès que les deux joueurs
// tapent en même temps. joclymatch a contourné le problème avec un fichier
// séparé ouvert en AJOUT (chatioaction), ce que match.php ne propose pas.
//
// La solution retenue ne demande rien au serveur : DEUX clés, une par joueur.
// Chacun n'écrit QUE dans la sienne et ne lit QUE celle d'en face. Il n'y a
// alors plus aucune concurrence -- un seul écrivain par fichier -- et le
// dernier-écrit-gagne devient exact plutôt que dangereux. Le prix est que
// chaque joueur réécrit son fil entier à chaque message ; un fil de partie
// tient largement dans la limite de 1 Mo de match.php.
//
// Cela vaut aussi pour le pair-à-pair, où il n'y a pas de stockage du tout :
// le même message part sur le fil TCP et les deux côtés fusionnent ce qu'ils
// ont. mergeThreads() est écrit pour être appelé dans les deux cas.
//
// ── Ce qui n'est PAS ici ────────────────────────────────────────────────────
//
// Le chiffrement. Un relais sans authentification voit tout ce qu'on y dépose,
// et la clé ne peut pas dériver du seul identifiant de partie -- il est envoyé
// au serveur à chaque requête. Il faut un second secret qui ne parte jamais
// (voir remote-secret.js), et le scellement lui-même appartient au Rust :
// crypto.subtle exige un contexte sécurisé, ce que rien ne garantit pour
// tauri:// sous WebKitGTK, et le projet a déjà payé ce pari avec WebRTC.
//
// Ce module en porte donc le CONTRAT, pas la mise en oeuvre : un `sealer`
// injecté, et le refus d'encoder un corps de discussion sans lui. Voir
// requiresSeal().

import { PROTOCOL_VERSION, ENVELOPE_KIND } from './remote-relay-protocol.js';

/** Version du format de fil. Distincte de PROTOCOL_VERSION : les deux
 *  évolueront séparément. */
export const THREAD_VERSION = 1;

/**
 * États de présence.
 *
 * Ce sont des DRAPEAUX, pas des phrases, et c'est délibéré. Un message de
 * présence traverse le réseau comme un identifiant : chaque client l'affiche
 * ensuite dans sa propre langue, ce qui marche entre deux joueurs qui n'en
 * partagent aucune. Rien de personnel ne circule, donc rien à chiffrer -- ils
 * restent disponibles même quand la discussion est désactivée, ce qui est
 * précisément le cas « je fais une pause ».
 */
export const PRESENCE = {
    PAUSED: 'paused',       // « je m'absente »
    BACK: 'back',           // « je reviens »
    THINKING: 'thinking',   // « je suis là, je réfléchis »
    LEAVING: 'leaving',     // « j'arrête pour aujourd'hui »
};

const PRESENCE_VALUES = Object.values(PRESENCE);

/** Les genres qui transportent du texte libre, donc qui doivent être scellés. */
export function requiresSeal(kind) {
    return kind === ENVELOPE_KIND.CHAT;
}

// ── Identifiants de fil ──────────────────────────────────────────────────────

/**
 * La clé de stockage du fil d'un joueur.
 *
 * Le suffixe est le CAMP, pas un numéro d'ordre : les deux joueurs doivent
 * calculer la même chose sans se concerter, et chacun connaît son camp.
 *
 * Le motif accepté par match.php est /^[A-Za-z0-9_-]{6,64}$/ -- pas de point,
 * pas de barre, sous peine de traversée de répertoire. Un identifiant de
 * partie est un UUID (36 caractères), donc le suffixe passe ; on vérifie quand
 * même, parce qu'un identifiant plus long refusé par le serveur donnerait un
 * échec réseau opaque plutôt qu'une erreur lisible.
 *
 * @param {string} matchId
 * @param {1|-1} side - Jocly.PLAYER_A / PLAYER_B
 */
export function chatMidFor(matchId, side) {
    if (typeof matchId !== 'string' || !matchId) throw new Error('chatMidFor: matchId requis');
    if (side !== 1 && side !== -1) throw new Error('chatMidFor: side doit être 1 ou -1');
    const mid = matchId + (side === 1 ? '-ca' : '-cb');
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(mid))
        throw new Error('chatMidFor: identifiant hors du format accepté par le relai : ' + mid);
    return mid;
}

// ── Messages ─────────────────────────────────────────────────────────────────

/**
 * Identifiant de message : non-devinable, et surtout STABLE, puisqu'il sert à
 * dédupliquer quand un fil est relu (rattrapage, reconnexion, relecture d'un
 * fichier inchangé). Deux messages écrits dans la même milliseconde par le
 * même joueur ne doivent pas se confondre, d'où la part aléatoire.
 */
function messageId(rand) {
    const bytes = new Uint8Array(8);
    rand(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function defaultRand(bytes) {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        crypto.getRandomValues(bytes);
        return;
    }
    // Pas de repli silencieux vers Math.random pour un identifiant : ici il ne
    // sert qu'à dédupliquer, pas à protéger, mais un repli muet dans un module
    // dont d'autres parties sont sensibles est une mauvaise habitude.
    throw new Error('remote-chat-protocol: crypto.getRandomValues indisponible');
}

/**
 * Construit un message.
 *
 * @param {object} m
 * @param {string} m.kind    - ENVELOPE_KIND.CHAT / PRESENCE / NUDGE
 * @param {1|-1}  m.side     - qui parle
 * @param {string} [m.body]  - texte libre (CHAT uniquement), DÉJÀ scellé si
 *                             un sealer est fourni à encodeThread
 * @param {string} [m.state] - une valeur de PRESENCE (PRESENCE uniquement)
 * @param {number} [m.at]    - horodatage, injectable pour les tests
 * @param {Function} [m.rand]
 */
export function newMessage({ kind, side, body = null, state = null, at = Date.now(), rand = defaultRand }) {
    if (![ENVELOPE_KIND.CHAT, ENVELOPE_KIND.PRESENCE, ENVELOPE_KIND.NUDGE].includes(kind))
        throw new Error('newMessage: genre inattendu : ' + kind);
    if (side !== 1 && side !== -1) throw new Error('newMessage: side doit être 1 ou -1');
    if (kind === ENVELOPE_KIND.CHAT && !String(body ?? '').trim())
        throw new Error('newMessage: un message de discussion sans texte n’a rien à dire');
    if (kind === ENVELOPE_KIND.PRESENCE && !PRESENCE_VALUES.includes(state))
        throw new Error('newMessage: état de présence inconnu : ' + state);

    const msg = { v: THREAD_VERSION, kind, side, at, id: messageId(rand) };
    if (kind === ENVELOPE_KIND.CHAT) msg.body = String(body);
    if (kind === ENVELOPE_KIND.PRESENCE) msg.state = state;
    return msg;
}

// ── Fils ─────────────────────────────────────────────────────────────────────

/**
 * Sérialise le fil d'UN joueur, tel qu'il sera déposé sous sa clé.
 *
 * `sealer` est appelé sur chaque corps de texte libre. Sans lui, un message de
 * discussion FAIT ÉCHOUER l'encodage plutôt que de partir en clair : c'est la
 * seule protection possible contre l'oubli, et un relais sans authentification
 * garde ce qu'on lui donne. Présence et relance passent, elles ne portent
 * aucun texte.
 *
 * @param {Array} messages
 * @param {{seal:Function}} [opts.sealer] - seal(text) -> chaîne opaque
 */
export function encodeThread(messages, { sealer = null } = {}) {
    if (!Array.isArray(messages)) throw new Error('encodeThread: liste attendue');
    const out = messages.map((m) => {
        if (!requiresSeal(m.kind)) return m;
        if (!sealer)
            throw new Error('encodeThread: un message de discussion ne peut pas partir en clair '
                + '(aucun sealer fourni) -- voir remote-secret.js');
        return { ...m, body: sealer.seal(m.body), enc: 1 };
    });
    return JSON.stringify({ v: THREAD_VERSION, msgs: out });
}

/**
 * Relit un fil. Rend TOUJOURS un tableau -- jamais d'exception, jamais null :
 * un fil illisible (relai neuf, page d'erreur HTML, message d'un client plus
 * récent) doit se traduire par « rien à afficher » et non par une partie
 * cassée. C'est la règle que decodeEnvelope suit déjà.
 *
 * Un corps scellé qu'on ne sait pas ouvrir est CONSERVÉ, marqué `locked` :
 * l'utilisateur voit qu'un message existe et qu'il lui manque la clé, ce qui
 * vaut mieux qu'un trou silencieux dans la conversation.
 */
export function decodeThread(text, { sealer = null } = {}) {
    if (typeof text !== 'string' || !text.trim()) return [];
    let data;
    try { data = JSON.parse(text); } catch { return []; }
    if (!data || !Array.isArray(data.msgs)) return [];

    const out = [];
    for (const m of data.msgs) {
        if (!m || typeof m !== 'object') continue;
        if (typeof m.id !== 'string' || !m.id) continue;
        if (m.side !== 1 && m.side !== -1) continue;
        if (!Number.isFinite(m.at)) continue;
        if (m.kind === ENVELOPE_KIND.PRESENCE) {
            if (!PRESENCE_VALUES.includes(m.state)) continue;
            out.push({ v: m.v ?? 1, kind: m.kind, side: m.side, at: m.at, id: m.id, state: m.state });
        } else if (m.kind === ENVELOPE_KIND.NUDGE) {
            out.push({ v: m.v ?? 1, kind: m.kind, side: m.side, at: m.at, id: m.id });
        } else if (m.kind === ENVELOPE_KIND.CHAT) {
            if (typeof m.body !== 'string') continue;
            if (!m.enc) {
                // En clair alors que le genre exige un scellement : on le
                // garde, verrouillé. Refuser l'affichage effacerait la trace
                // d'un correspondant mal configuré ; l'afficher tel quel
                // laisserait croire que le canal protège quelque chose.
                out.push({ v: m.v ?? 1, kind: m.kind, side: m.side, at: m.at, id: m.id,
                    body: null, locked: true, reason: 'unsealed' });
                continue;
            }
            let body = null;
            try { body = sealer ? sealer.open(m.body) : null; } catch { body = null; }
            out.push(body === null
                ? { v: m.v ?? 1, kind: m.kind, side: m.side, at: m.at, id: m.id,
                    body: null, locked: true, reason: sealer ? 'badKey' : 'noKey' }
                : { v: m.v ?? 1, kind: m.kind, side: m.side, at: m.at, id: m.id, body });
        }
        // Genre inconnu : ignoré en silence. C'est ce qui permettra d'ajouter
        // un quatrième genre sans casser les clients d'aujourd'hui.
    }
    return out;
}

/**
 * Assemble plusieurs fils en une conversation.
 *
 * Trié par horodatage, puis par identifiant à égalité -- deux horloges de
 * machines différentes ne s'accordent pas, et sans départage l'ordre affiché
 * changerait d'un rafraîchissement à l'autre, ce qui se voit tout de suite.
 *
 * Dédupliqué par identifiant : un fil est relu en entier à chaque
 * rafraîchissement, et le pair-à-pair rejoue son dernier message au
 * rattrapage.
 */
export function mergeThreads(...threads) {
    const byId = new Map();
    for (const thread of threads)
        for (const m of thread || [])
            if (m && typeof m.id === 'string' && !byId.has(m.id)) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Le dernier état de présence déclaré par un camp, ou null.
 *
 * C'est ce qu'une interface affiche -- « votre adversaire s'est absenté il y a
 * 12 min » -- plutôt que la suite des changements, qui n'intéresse personne.
 */
export function presenceOf(conversation, side) {
    for (let i = conversation.length - 1; i >= 0; i--) {
        const m = conversation[i];
        if (m.kind === ENVELOPE_KIND.PRESENCE && m.side === side) return m;
    }
    return null;
}

/**
 * Une relance est-elle permise maintenant ?
 *
 * Bornée dans le temps, sinon c'est une arme : une relance fait remonter une
 * notification chez l'autre même fenêtre fermée.
 */
export const NUDGE_MIN_INTERVAL_MS = 5 * 60 * 1000;

export function canNudge(conversation, side, now = Date.now()) {
    for (let i = conversation.length - 1; i >= 0; i--) {
        const m = conversation[i];
        if (m.kind === ENVELOPE_KIND.NUDGE && m.side === side)
            return now - m.at >= NUDGE_MIN_INTERVAL_MS;
    }
    return true;
}

export { PROTOCOL_VERSION, ENVELOPE_KIND };
