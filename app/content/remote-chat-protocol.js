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

/**
 * Ce message transporte-t-il du texte libre, donc doit-il être scellé ?
 *
 * La question porte sur le MESSAGE et non sur son genre, parce qu'un message
 * de discussion n'est pas forcément du texte : un message rapide (« bien
 * joué », « à toi ») voyage comme IDENTIFIANT, se traduit chez celui qui le
 * lit, et ne contient donc rien de personnel. Il n'a rien à sceller, ce qui
 * lui permet de circuler dans une partie sans clé — exactement comme la
 * présence.
 */
export function requiresSeal(message) {
    return !!message && message.kind === ENVELOPE_KIND.CHAT && typeof message.body === 'string';
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
export function newMessage({ kind, side, body = null, quick = null, state = null, at = Date.now(), rand = defaultRand }) {
    if (![ENVELOPE_KIND.CHAT, ENVELOPE_KIND.PRESENCE, ENVELOPE_KIND.NUDGE].includes(kind))
        throw new Error('newMessage: genre inattendu : ' + kind);
    if (side !== 1 && side !== -1) throw new Error('newMessage: side doit être 1 ou -1');
    if (kind === ENVELOPE_KIND.CHAT && !String(body ?? '').trim() && !quick)
        throw new Error('newMessage: un message de discussion sans texte n’a rien à dire');
    if (quick !== null && !/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(String(quick)))
        throw new Error('newMessage: identifiant de message rapide inattendu : ' + quick);
    if (kind === ENVELOPE_KIND.PRESENCE && !PRESENCE_VALUES.includes(state))
        throw new Error('newMessage: état de présence inconnu : ' + state);

    /*
     * L'identifiant est « horodatage-alea », et non un alea seul : c'est la
     * forme que joclymatch construit de son cote (time + "-" + key). Les deux
     * applications relisent le MEME fil ; si elles n'y calculaient pas le meme
     * identifiant, chacune dedupliquerait dans son coin et un message relu
     * apparaitrait deux fois chez l'une, une seule chez l'autre.
     */
    const msg = { v: THREAD_VERSION, kind, side, at, id: at + '-' + messageId(rand) };
    if (kind === ENVELOPE_KIND.CHAT && quick) msg.quick = String(quick);
    else if (kind === ENVELOPE_KIND.CHAT) msg.body = String(body);
    if (kind === ENVELOPE_KIND.PRESENCE) msg.state = state;
    return msg;
}

// ── L'enveloppe de joclymatch ────────────────────────────────────────────────

/**
 * Traduit un message vers la forme que joclymatch depose et relit.
 *
 * LES DEUX FORMATS SE REJOIGNAIENT DEJA SUR L'ESSENTIEL : le camp s'y ecrit
 * `1` / `-1` des deux cotes. Le reste est un changement de nom -- `body` ->
 * `msg`, `at` -> `time` -- plus une part aleatoire `key`, dont joclymatch fait
 * son identifiant en la collant a l'horodatage.
 *
 * C'est pourquoi notre `id` PREND cette forme (« time-key ») au lieu d'etre un
 * aleatoire independant : les deux applications relisent le meme fil, et il
 * faut qu'elles y dedupliquent les memes messages. Deux schemas d'identifiant
 * donneraient un message affiche deux fois chez l'un et une seule chez
 * l'autre.
 *
 * Les champs que joclymatch ne connait pas -- `kind`, `quick`, `state`, `enc`
 * -- voyagent a cote : il les ignore, et son durcissement garantit qu'il ne
 * s'y casse pas.
 *
 * @param {object} msg    - un message produit par newMessage()
 * @param {string} [seal] - le corps SCELLE, quand il doit l'etre
 */
export function toRelayMessage(msg, seal = null, quickText = null) {
    const [time, key] = String(msg.id).split('-');
    /*
     * UN MESSAGE RAPIDE DOIT RESTER LISIBLE PAR QUI NE CONNAIT PAS `quick`.
     *
     * Le champ `quick` est un identifiant que Tabulon traduit chez le lecteur.
     * joclymatch ne le connait pas : il affiche `msg`, qui valait la chaine
     * vide -- donc une BULLE VIDE dans le fil, mesuree telle quelle. On y met
     * donc le libelle traduit, dans la langue de celui qui l'envoie : imparfait
     * si les deux joueurs n'ont pas la meme, mais infiniment mieux qu'une bulle
     * sans contenu.
     *
     * Rien n'est perdu pour autant : `quick` part AUSSI, et un client qui le
     * comprend continue de traduire chez lui. `msg` n'est qu'un repli.
     *
     * Et rien n'est trahi : un message rapide ne porte aucun texte personnel
     * -- c'est precisement ce qui lui permet de circuler dans une partie sans
     * cle.
     */
    let corps = seal !== null ? seal : (msg.body ?? '');
    if (seal === null && msg.quick && typeof quickText === 'string' && quickText.length)
        corps = quickText;
    const out = {
        msg: corps,
        player: msg.side,
        time: Number(time) || msg.at,
        key: key || '',
    };
    if (seal !== null) out.enc = 1;
    // `chat` est le defaut cote joclymatch : ne pas l'ecrire evite un champ
    // inutile sur chaque ligne d'un fichier plafonne a 256 Ko.
    if (msg.kind !== ENVELOPE_KIND.CHAT) out.kind = msg.kind;
    if (msg.quick) out.quick = msg.quick;
    if (msg.state) out.state = msg.state;
    return out;
}

/**
 * Relit une ligne deposee par l'une ou l'autre application.
 *
 * Rend null pour tout ce qui n'est pas exploitable, plutot que de lever : un
 * fil partage contient des lignes ecrites par un client qu'on ne connait pas,
 * et une seule d'entre elles ne doit pas emporter la conversation.
 *
 * LE CAMP 0 EXISTE : joclymatch s'en sert pour ses messages de service. Il est
 * conserve, parce qu'un message qui disparait sans laisser de trace est pire
 * qu'un message qu'on ne sait pas attribuer.
 */
export function fromRelayMessage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const data = raw.data && typeof raw.data === 'object' ? raw.data : raw;
    if (typeof data.msg !== 'string') return null;
    const side = data.player;
    if (side !== 1 && side !== -1 && side !== 0) return null;
    const at = Number(data.time);
    if (!Number.isFinite(at)) return null;
    const out = {
        v: THREAD_VERSION,
        kind: typeof data.kind === 'string' ? data.kind : ENVELOPE_KIND.CHAT,
        side, at,
        id: at + '-' + (data.key ?? ''),
        body: data.msg,
    };
    if (data.enc) out.enc = 1;
    if (typeof data.quick === 'string') out.quick = data.quick;
    if (typeof data.state === 'string') out.state = data.state;
    // Le pseudo de joclymatch : conserve pour l'affichage, jamais emis par
    // nous -- en regime scelle il annoncerait une protection que le fil n'a
    // pas.
    if (typeof data.pseudo === 'string') out.pseudo = data.pseudo;
    return out;
}

// ── Fils ─────────────────────────────────────────────────────────────────────

/**
 * Sérialise le fil d'UN joueur, tel qu'il sera déposé sous sa clé.
 *
 * ASYNCHRONE, et c'est le scellement qui l'impose : il se fait en Rust (voir
 * seal_cmds.rs), donc par un appel de commande, donc par une promesse. Un
 * scelleur synchrone -- ceux des tests -- passe sans changement, `await` sur
 * une valeur ordinaire etant transparent.
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
export async function encodeThread(messages, { sealer = null } = {}) {
    if (!Array.isArray(messages)) throw new Error('encodeThread: liste attendue');
    const out = [];
    for (const m of messages) out.push(await sealMessage(m, sealer));
    return JSON.stringify({ v: THREAD_VERSION, msgs: out });
}

/**
 * La forme QUI CIRCULE d'un message : scellée si c'est du texte libre, telle
 * quelle sinon.
 *
 * Sortie d'encodeThread parce que le pair-à-pair envoie ses messages UN PAR UN
 * -- il n'a pas de fil à déposer -- et doit pourtant appliquer exactement la
 * même règle. Deux règles de scellement écrites séparément finiraient par
 * diverger, et la divergence a déjà eu lieu : un corps envoyé en clair sur le
 * fil TCP arrive chez l'autre marqué `unsealed`, donc affiché « message envoyé
 * sans protection », ce qui rendait le texte libre inutilisable en
 * pair-à-pair.
 *
 * Le marqueur `enc` n'est pas décoratif : decodeThread refuse d'afficher un
 * corps qui ne l'a pas. C'est voulu -- sans lui, rien ne distinguerait un
 * correspondant mal configuré d'un message qu'on a le droit de lire.
 */
export async function sealMessage(message, sealer = null) {
    if (!requiresSeal(message)) return message;
    if (!sealer)
        throw new Error('sealMessage: un message de discussion ne peut pas partir en clair '
            + '(aucun sealer fourni) -- voir remote-secret.js');
    return { ...message, body: await sealer.seal(message.body), enc: 1 };
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
/**
 * Reporte le pseudo de joclymatch sur le message reconstruit.
 *
 * decodeThread rebatit chaque message a partir d'une liste FIXE de champs --
 * c'est ce qui empeche un client inconnu d'injecter n'importe quoi. Mais
 * `pseudo`, que fromRelayMessage prend soin de conserver, tombait dans ce
 * filtre : le joueur joclymatch qui s'etait donne un nom s'affichait
 * « Joueur B » chez son correspondant Tabulon.
 *
 * Il est recopie ici, et nulle part ailleurs, pour que la liste fixe reste la
 * seule porte d'entree.
 */
function avecPseudo(out, source) {
    if (typeof source.pseudo === 'string' && source.pseudo.length) out.pseudo = source.pseudo;
    return out;
}

export async function decodeThread(text, { sealer = null, allowClear = false } = {}) {
    if (typeof text !== 'string' || !text.trim()) return [];
    let data;
    try { data = JSON.parse(text); } catch { return []; }
    if (!data || !Array.isArray(data.msgs)) return [];

    const out = [];
    for (const m of data.msgs) {
        if (!m || typeof m !== 'object') continue;
        if (typeof m.id !== 'string' || !m.id) continue;
        /*
         * LE CAMP 0 EST CELUI DES MESSAGES DE SERVICE de joclymatch. Il est
         * accepte plutot qu'ecarte : un message qui disparait sans laisser de
         * trace est pire qu'un message qu'on ne sait pas attribuer, et les deux
         * applications relisent desormais le meme fil.
         */
        if (m.side !== 1 && m.side !== -1 && m.side !== 0) continue;
        if (!Number.isFinite(m.at)) continue;
        if (m.kind === ENVELOPE_KIND.PRESENCE) {
            if (!PRESENCE_VALUES.includes(m.state)) continue;
            out.push({ v: m.v ?? 1, kind: m.kind, side: m.side, at: m.at, id: m.id, state: m.state });
        } else if (m.kind === ENVELOPE_KIND.NUDGE) {
            out.push({ v: m.v ?? 1, kind: m.kind, side: m.side, at: m.at, id: m.id });
        } else if (m.kind === ENVELOPE_KIND.CHAT) {
            // Message rapide : un identifiant, traduit chez le lecteur. Rien à
            // ouvrir, rien à sceller -- il passe dans une partie sans clé.
            if (typeof m.quick === 'string') {
                if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(m.quick)) continue;
                out.push(avecPseudo(
                    { v: m.v ?? 1, kind: m.kind, side: m.side, at: m.at, id: m.id, quick: m.quick }, m));
                continue;
            }
            if (typeof m.body !== 'string') continue;
            if (!m.enc) {
                /*
                 * REGIME CLAIR ASSUME : la partie n'a pas de cle, l'autre bout
                 * n'en a pas non plus, et le texte circule en clair parce que
                 * c'est le seul regime possible -- typiquement une partie
                 * rejointe par un lien joclymatch. On l'affiche.
                 *
                 * La permission vient de l'APPELANT, jamais de l'absence de
                 * scelleur : un scelleur qui n'a pas pu se construire ne doit
                 * pas valoir permission de lire du clair sur une partie
                 * protegee.
                 */
                if (allowClear) {
                    out.push(avecPseudo(
                        { v: m.v ?? 1, kind: m.kind, side: m.side, at: m.at, id: m.id, body: m.body }, m));
                    continue;
                }
                // En clair alors que le genre exige un scellement : on le
                // garde, verrouillé. Refuser l'affichage effacerait la trace
                // d'un correspondant mal configuré ; l'afficher tel quel
                // laisserait croire que le canal protège quelque chose.
                out.push(avecPseudo({ v: m.v ?? 1, kind: m.kind, side: m.side, at: m.at, id: m.id,
                    body: null, locked: true, reason: 'unsealed' }, m));
                continue;
            }
            let body = null;
            try { body = sealer ? await sealer.open(m.body) : null; } catch { body = null; }
            out.push(avecPseudo(body === null
                ? { v: m.v ?? 1, kind: m.kind, side: m.side, at: m.at, id: m.id,
                    body: null, locked: true, reason: sealer ? 'badKey' : 'noKey' }
                : { v: m.v ?? 1, kind: m.kind, side: m.side, at: m.at, id: m.id, body }, m));
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
