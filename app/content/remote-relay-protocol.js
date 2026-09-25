// app/content/remote-relay-protocol.js -- Protocole du relai HTTP "jeu à distance".
//
// Étape 1 (branche remoteplay) : ce module ne contient QUE la logique pure
// d'encodage/décodage, sans fetch ni DOM, pour rester testable tel quel sous
// Node (voir tests/test-remote-relay-protocol.mjs). Le transport réel est
// dans remote-channel.js.
//
// Compatibilité : le endpoint fileio.php de jocly-simple-match
// (https://framagit.org/jcfrog/jocly-simple-match, aussi déployé sur
// https://biscandine.fr/variantes/joclymatch/fileio.php) est un simple
// stockage clé-valeur par POST form-encodé :
//   save : gameioaction=save & gameid=<id> & gamedata=<texte quelconque>
//   load : gameioaction=load & gameid=<id>            -> renvoie le texte tel quel
// Le serveur ne connaît RIEN de la structure de gamedata (aucune validation) :
// on est donc libre de choisir notre propre enveloppe JSON plutôt que de
// reproduire celle de control.js (matchDetails/matchdata/key) qui est propre
// à l'implémentation cliente de jocly-simple-match, pas au protocole serveur.

export const PROTOCOL_VERSION = 1;

/**
 * Nature d'une enveloppe.
 *
 * POURQUOI CE CHAMP EXISTE MAINTENANT : jusqu'ici une enveloppe ne pouvait
 * etre qu'un coup, et `hasOpponentMoved` la reconnaissait a son `nbTurns`. Des
 * qu'un second genre de message circule sur le meme canal -- discussion,
 * presence (« je fais une pause »), relance -- deviner le genre a la forme
 * devient un piege : un message sans `nbTurns` serait rejete par
 * decodeEnvelope, et un message qui en aurait un serait pris pour un coup.
 *
 * COMPATIBILITE : une enveloppe ancienne n'a pas de `kind`, et c'est toujours
 * un coup -- d'ou le defaut a MOVE au decodage. Le champ est donc additif et
 * PROTOCOL_VERSION ne bouge pas : un client ancien qui recevrait un message de
 * discussion le refuserait faute de `nbTurns`, ce qui est exactement le
 * comportement voulu (il l'ignore au lieu de le jouer).
 */
export const ENVELOPE_KIND = {
    MOVE: 'move',
    CHAT: 'chat',
    PRESENCE: 'presence',
    NUDGE: 'nudge',
};

// Relai HTTP par defaut (etape 1/2 : instance de test jocly-simple-match
// utilisee pour valider le protocole -- voir DEVELOPMENT.md § Remote
// play). A rendre choisissable par l'utilisateur dans une
// etape ulterieure ; en attendant, le champ "Relay URL" de players.js permet
// deja de le remplacer manuellement partie par partie.
export const DEFAULT_RELAY_URL = 'https://biscandine.fr/variantes/joclymatch/fileio.php';

/**
 * Construit l'enveloppe JSON poussée après un coup local.
 * @param {{nbTurns:number, lastMove:*, state:*}} data
 *   nbTurns  - nombre de coups joués depuis le début (compteur, comme
 *              matchDetails.nbTurns dans jocly-simple-match) ; sert à détecter
 *              qu'un nouveau coup adverse est arrivé sans tout retélécharger.
 *   lastMove - le dernier coup joué (objet Jocly opaque), pour permettre à
 *              l'adversaire de rejouer juste ce coup (playMove) plutôt que de
 *              recharger toute la partie -- comme loadMatchFromID côté
 *              jocly-simple-match.
 *   state    - snapshot complet et opaque de la partie (typiquement la sortie
 *              de joclyMatch.save()), pour permettre une resynchronisation
 *              complète (nouvelle connexion, désynchronisation détectée).
 * @returns {string} JSON prêt à poster comme "gamedata"
 */
export function encodeEnvelope({ nbTurns, lastMove = null, state = null, allowTakeback = null }) {
    if (!Number.isInteger(nbTurns) || nbTurns < 0) {
        throw new Error('encodeEnvelope: nbTurns doit être un entier >= 0');
    }
    const envelope = {
        v: PROTOCOL_VERSION,
        kind: ENVELOPE_KIND.MOVE,
        nbTurns,
        lastMove,
        state,
        updatedAt: Date.now(),
    };
    // Reglage de la PARTIE, recopie a chaque ecriture : le relai ne garde que
    // la derniere enveloppe, un champ absent d'une seule ecriture serait
    // perdu pour les deux joueurs. Pas ecrit quand on ne le connait pas --
    // l'absence veut dire « inconnu », pas « interdit ».
    if (typeof allowTakeback === 'boolean') envelope.allowTakeback = allowTakeback;
    return JSON.stringify(envelope);
}

/**
 * Décode la réponse brute d'un "load". Renvoie null si la partie n'existe pas
 * encore côté relai (fichier absent -> fileio.php renvoie une réponse vide)
 * ou si le contenu est illisible (relai non compatible, page d'erreur...).
 * @param {string} text
 * @returns {{v:number, nbTurns:number, lastMove:*, state:*, updatedAt:number}|null}
 */
export function decodeEnvelope(text) {
    if (typeof text !== 'string' || text.trim().length === 0) return null;
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        return null;
    }
    if (!data || typeof data !== 'object' || !Number.isInteger(data.nbTurns)) return null;
    // Une enveloppe sans `kind` vient d'un client anterieur au champ : c'etait
    // forcement un coup, il n'y avait rien d'autre.
    if (data.kind !== undefined && data.kind !== ENVELOPE_KIND.MOVE) return null;
    return {
        v: Number.isInteger(data.v) ? data.v : 1,
        kind: ENVELOPE_KIND.MOVE,
        nbTurns: data.nbTurns,
        lastMove: data.lastMove ?? null,
        state: data.state ?? null,
        updatedAt: Number.isInteger(data.updatedAt) ? data.updatedAt : null,
        allowTakeback: readAllowTakeback(data.allowTakeback),
    };
}

/** true/false tels quels ; tout le reste (absent, abime) = inconnu (null). */
function readAllowTakeback(value) {
    return typeof value === 'boolean' ? value : null;
}

/**
 * true si l'enveloppe distante contient un coup que nous n'avons pas encore
 * localement (nbTurns distant strictement supérieur au nôtre).
 * @param {number} localNbTurns
 * @param {{nbTurns:number}|null} remoteEnvelope
 */
export function hasOpponentMoved(localNbTurns, remoteEnvelope) {
    if (!remoteEnvelope) return false;
    // Ceinture et bretelles : decodeEnvelope ne rend deja que des coups, mais
    // cette fonction est aussi appelee sur des objets venus d'ailleurs (le
    // rattrapage de PeerChannel, les tests). Un message de discussion pris
    // pour un coup ferait avancer la partie sur du vide.
    if (remoteEnvelope.kind !== undefined && remoteEnvelope.kind !== ENVELOPE_KIND.MOVE) return false;
    return remoteEnvelope.nbTurns > localNbTurns;
}

/**
 * true si l'adversaire a REPRIS un ou plusieurs coups (ou recommence la
 * partie) : le relai porte MOINS de coups que nous.
 *
 * C'est le pendant de hasOpponentMoved, et c'est pourquoi celle-ci teste un
 * strict superieur : une baisse n'est pas un coup. La passer dans la branche
 * « il a joue » depilerait un coup et le rejouerait -- ce qui defait
 * l'annulation d'un cran en animant un coup que personne n'a joue. Le piege
 * a deja ete corrige une fois cote joclymatch (un `!=` devenu `>` / `<`).
 *
 * Une annulation se charge TELLE QUELLE, depuis l'etat complet : il n'y a pas
 * de coup a jouer.
 * @param {number} localNbTurns
 * @param {{nbTurns:number, kind?:string}|null} remoteEnvelope
 */
export function hasOpponentTakenBack(localNbTurns, remoteEnvelope) {
    if (!remoteEnvelope) return false;
    if (remoteEnvelope.kind !== undefined && remoteEnvelope.kind !== ENVELOPE_KIND.MOVE) return false;
    if (!Number.isInteger(remoteEnvelope.nbTurns)) return false;
    return remoteEnvelope.nbTurns < localNbTurns;
}

/**
 * La reprise de coup est-elle permise dans cette partie ?
 *
 * LE FICHIER FAIT FOI, le lien annonce : le fichier du relai est le meme pour
 * les deux joueurs par construction, il survit a un rechargement et a un lien
 * tronque au copier-coller ; un lien, lui, a pu etre retouche a la main. Le
 * lien ne sert que tant que le fichier ne dit rien -- en particulier avant
 * que l'hote n'y ait ecrit.
 *
 * Et quand PERSONNE ne dit rien, `fallback` : la valeur par defaut depend du
 * correspondant possible (voir play.js), pas de ce module.
 * @param {boolean|null} fileValue
 * @param {boolean|null} linkValue
 * @param {boolean} fallback
 */
export function resolveAllowTakeback(fileValue, linkValue, fallback) {
    if (typeof fileValue === 'boolean') return fileValue;
    if (typeof linkValue === 'boolean') return linkValue;
    return !!fallback;
}

/**
 * Verdict du bouton « Tester » sur la reponse d'un relai.
 *
 * AVANT, TOUTE REPONSE VALAIT « JOIGNABLE ». Or une installation mogichex
 * renvoie index.html -- avec un 200 -- pour toute adresse qui n'est pas un
 * fichier (regle mono-page de son .htaccess) : sans fileio.php, le test
 * disait « relai joignable » et la partie restait muette ensuite.
 *
 * On ne demande pas pour autant du JSON : un fileio.php de jocly-simple-match
 * d'origine repond a un identifiant jamais sauvegarde par un avertissement
 * PHP (du HTML en fragments, pas un document), et ce relai-la fonctionne tres
 * bien. Ce qui trahit « pas de relai ici », c'est une PAGE entiere, ou un
 * statut d'erreur.
 * @param {number} status
 * @param {string} bodyText
 * @returns {'ok'|'not-relay'|'http-error'}
 */
export function classifyRelayProbe(status, bodyText) {
    if (Number.isInteger(status) && status >= 400) return 'http-error';
    const head = String(bodyText || '').trimStart().slice(0, 200).toLowerCase();
    if (head.startsWith('<!doctype') || head.startsWith('<html')) return 'not-relay';
    return 'ok';
}

/**
 * Corps x-www-form-urlencoded pour un POST "save" vers fileio.php.
 * @param {string} gameId
 * @param {string} envelopeJson - sortie de encodeEnvelope()
 */
export function buildSaveBody(gameId, envelopeJson) {
    if (!gameId) throw new Error('buildSaveBody: gameId requis');
    const p = new URLSearchParams();
    p.set('gameioaction', 'save');
    p.set('gameid', gameId);
    p.set('gamedata', envelopeJson);
    return p;
}

/**
 * Corps x-www-form-urlencoded pour un POST "load" vers fileio.php.
 * @param {string} gameId
 */
export function buildLoadBody(gameId) {
    if (!gameId) throw new Error('buildLoadBody: gameId requis');
    const p = new URLSearchParams();
    p.set('gameioaction', 'load');
    p.set('gameid', gameId);
    return p;
}

/**
 * Corps d'un POST "chat" vers fileio.php : le serveur AJOUTE la ligne.
 *
 * Point d'entree distinct de celui des coups, et fichier distinct
 * (`<gameid>-chat.txt`) : ecrire une conversation dans la cle de la partie
 * ecraserait le coup qui n'a pas encore ete lu.
 *
 * C'est le point d'entree de joclymatch, et c'est tout l'objet du
 * demenagement : deux applications qui partagent un plateau partagent
 * desormais aussi le fil.
 *
 * UN MESSAGE EST UNE LIGNE. Le serveur refuse (400) un `chatmsg` contenant un
 * saut de ligne, parce qu'il relit le fichier ligne par ligne : un message
 * multiligne couperait le JSON de son auteur en fragments invalides et
 * rendrait le fil illisible POUR LES DEUX joueurs, durablement. JSON.stringify
 * n'en emet jamais -- a condition de ne pas indenter.
 */
export function buildChatSaveBody(gameId, line) {
    if (!gameId) throw new Error('buildChatSaveBody: gameId requis');
    if (/[\r\n]/.test(line))
        throw new Error('buildChatSaveBody: un message est une ligne (le relai refuse les sauts de ligne)');
    const p = new URLSearchParams();
    p.set('chatioaction', 'save');
    p.set('gameid', gameId);
    p.set('chatmsg', line);
    return p;
}

/** Corps d'un POST "chat load" : rend TOUT le fil, les deux joueurs meles. */
export function buildChatLoadBody(gameId) {
    if (!gameId) throw new Error('buildChatLoadBody: gameId requis');
    const p = new URLSearchParams();
    p.set('chatioaction', 'load');
    p.set('gameid', gameId);
    return p;
}

/**
 * Identifiant de partie non-devinable (UUID v4 si dispo, sinon repli).
 * jocly-simple-match n'a AUCUNE authentification réelle -- toute la
 * "sécurité" tient au fait que l'identifiant de partie n'est pas devinable.
 * On s'assure donc ici de ne jamais générer d'identifiant court/prévisible.
 */
export function generateMatchId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // Repli (environnements sans crypto.randomUUID) : assez d'entropie pour
    // rester non-devinable, format volontairement différent d'un UUID pour
    // qu'on distingue les deux au premier coup d'oeil en debug.
    const bytes = new Uint8Array(16);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return 'tb-' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// -- Codec compatible jocly-simple-match ---------------------------------------
// Contrairement a encodeEnvelope/decodeEnvelope ci-dessus (notre propre
// format, libre puisque le relai ne valide rien), CE codec reproduit
// exactement la structure ecrite/lue par control.js
// (https://framagit.org/jcfrog/jocly-simple-match/-/blob/master/js/control.js) :
//   { matchDetails: {matchId, gameName, nbTurns, a:{pseudo}, b:{pseudo}},
//     matchdata: <sortie de match.save()>, time, key }
// Necessaire pour VRAIMENT jouer contre quelqu'un connecte via leur page web
// (index.php), pas seulement contre une autre instance de Tabulon -- c'est
// tout l'interet du bouton "Invitation" (voir DEVELOPMENT.md § Remote play).
// matchdata est un objet Jocly opaque (mais du meme moteur jocly2 des deux
// cotes, donc du meme format) ; on ne l'interprete jamais ici, seul
// matchdata.playedMoves (tableau) est lu pour en extraire le dernier coup.

/**
 * @param {{matchId:string, gameName:string, nbTurns:number, matchdata:*}} data
 * @returns {string} JSON pret a poster comme "gamedata"
 */
export function encodeJoclySimpleMatchEnvelope({ matchId, gameName, nbTurns, matchdata, allowTakeback = null }) {
    if (!matchId) throw new Error('encodeJoclySimpleMatchEnvelope: matchId requis');
    if (!Number.isInteger(nbTurns) || nbTurns < 0) {
        throw new Error('encodeJoclySimpleMatchEnvelope: nbTurns doit être un entier >= 0');
    }
    const matchDetails = { matchId, gameName, nbTurns, a: { pseudo: '' }, b: { pseudo: '' } };
    /*
     * matchDetails est RECONSTRUIT a chaque sauvegarde, ici comme dans
     * control.js : un champ que l'un des deux clients ne recopie pas est
     * efface a sa premiere ecriture. Le reglage de reprise est donc reporte
     * explicitement, et seulement quand on le connait.
     */
    if (typeof allowTakeback === 'boolean') matchDetails.allowTakeback = allowTakeback;
    return JSON.stringify({
        matchDetails,
        matchdata,
        time: Date.now(),
        // jocly-simple-match ne verifie jamais cette cle malgre son nom --
        // aucune authentification reelle, cote eux comme cote nous.
        key: 'tabulon',
    });
}

/**
 * @param {string} text
 * @returns {{nbTurns:number, lastMove:*, state:*}|null}
 */
export function decodeJoclySimpleMatchEnvelope(text) {
    if (typeof text !== 'string' || text.trim().length === 0) return null;
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        return null;
    }
    const nbTurns = data?.matchDetails?.nbTurns;
    if (!Number.isInteger(nbTurns)) return null;
    const moves = data.matchdata?.playedMoves;
    const lastMove = Array.isArray(moves) && moves.length ? moves[moves.length - 1] : null;
    return {
        nbTurns, lastMove, state: data.matchdata ?? null,
        allowTakeback: readAllowTakeback(data.matchDetails.allowTakeback),
    };
}

/**
 * Décompose un lien d'invitation jocly-simple-match, ex. :
 *   https://biscandine.fr/variantes/joclymatch/index.php?game=knightmate-chess&mid=1784023862731-pIUWbcgh0yDFVT&player=a
 * en {gameName, matchId, player, relayUrl} -- relayUrl est déduite en
 * remplaçant index.php par fileio.php dans le même dossier (les deux scripts
 * vivent toujours côte à côte dans jocly-simple-match).
 * @param {string} urlString
 * @returns {{gameName:string, matchId:string, player:'a'|'b', relayUrl:string,
 *            allowTakeback:boolean|null}|null}
 */
export function parseInvitationUrl(urlString) {
    let url;
    try {
        url = new URL(String(urlString).trim());
    } catch {
        return null;
    }
    const gameName = url.searchParams.get('game');
    const matchId  = url.searchParams.get('mid');
    const playerParam = (url.searchParams.get('player') || '').toLowerCase();
    if (!gameName || !matchId || (playerParam !== 'a' && playerParam !== 'b')) return null;
    // index.php -> fileio.php, meme dossier (convention jocly-simple-match)
    const relayPath = url.pathname.replace(/[^/]*$/, 'fileio.php');
    const hash = new URLSearchParams(String(url.hash || '').replace(/^#/, ''));
    const keyId = hash.get('kid');
    return {
        gameName, matchId, player: playerParam,
        relayUrl: url.origin + relayPath,
        chatKey: chatKeyFromHash(url.hash),
        /*
         * L'empreinte de la cle de communaute a employer, quand il y en a une.
         *
         * Elle DESIGNE une cle sans la donner : l'invite cherche parmi les
         * siennes celle qui porte cette empreinte, et en derive la cle de la
         * partie. Rien de secret ne voyage donc -- mais elle reste dans le
         * fragment avec le reste, parce qu'elle dit a quel groupe la partie
         * appartient, et que le relai n'a pas a l'apprendre.
         */
        chatKeyId: /^[0-9a-f]{16}$/.test(keyId || '') ? keyId : null,
        /*
         * `tb` : la reprise de coup, telle que l'hote l'a reglee. DANS LA
         * REQUETE, pas dans le fragment : le fragment est reserve a ce qui ne
         * doit pas atteindre le serveur (la cle), alors que la page de
         * joclymatch a besoin de lire ce reglage. Absent ou illisible = null,
         * c'est-a-dire « le lien ne dit rien » -- un lien d'avant ce reglage.
         */
        allowTakeback: takebackFromParam(url.searchParams.get('tb'))
            ?? takebackFromHostPage(url.pathname),
    };
}

/*
 * UN LIEN SANS `tb` NE DIT PAS LA MEME CHOSE SELON LA PAGE QUI L'A EMIS.
 *
 * Seule la page de joclymatch s'appelle index.php, et joclymatch a toujours
 * su recevoir une reprise : se taire, pour lui, c'est « permis », et c'est ce
 * que suppose la valeur par defaut du codec jocly-simple-match (null ici).
 *
 * Toute autre page -- mogichex sert index.html, ou son repertoire nu -- peut
 * etre un client qui ne sait PAS recevoir une reprise : mogichex jusqu'a sa
 * 1.01 comprise ignore tout nbTurns qui baisse. Tabulon reprenait alors un
 * coup, mogichex n'en voyait rien, puis ignorait aussi le coup suivant (plus
 * court que ce qu'il avait deja) : chaque camp attendait l'autre, plateaux
 * divergents. D'ou « interdit » quand le lien ne dit rien. Le fichier du
 * relai l'emporte toujours (resolveAllowTakeback) : un mogichex qui sait
 * reprendre l'y ecrit, et un lien qu'il emet porte `tb` explicitement.
 */
function takebackFromHostPage(pathname) {
    const page = String(pathname || '').split('/').pop().toLowerCase();
    return page === 'index.php' ? null : false;
}

function takebackFromParam(value) {
    if (value === '1') return true;
    if (value === '0') return false;
    return null;
}

/**
 * Clé de discussion transportée par le lien -- DANS LE FRAGMENT, jamais dans
 * la requête.
 *
 * C'EST LE POINT DE TOUTE LA CONSTRUCTION. Le lien d'invitation est une URL de
 * joclymatch, faite pour être ouverte dans un navigateur ; un `?k=...` serait
 * donc envoyé au SERVEUR dès que l'invité clique dessus, et la clé censée
 * cacher la conversation à ce serveur lui arriverait par la porte d'entrée. Un
 * fragment, lui, n'est jamais transmis : le navigateur le garde, la page de
 * joclymatch l'ignore, et Tabulon le lit.
 *
 * Le lien voyage par un autre canal -- message, courriel -- que celui du
 * relai. C'est ce qui rend la séparation possible : le relai voit
 * l'identifiant de partie, il ne voit pas la clé.
 */
function chatKeyFromHash(hash) {
    const raw = String(hash || '').replace(/^#/, '');
    if (!raw) return null;
    const key = new URLSearchParams(raw).get('k');
    return isChatKey(key) ? key : null;
}

/** Forme attendue d'une clé : 32 octets en hexadécimal, comme la graine. */
export function isChatKey(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Inverse de parseInvitationUrl : construit le lien à envoyer à l'autre
 * joueur pour une partie qu'ON vient de créer (voir invitation.js, section
 * "Create"). fileio.php -> index.php, même dossier -- même convention.
 * @param {{relayUrl:string, gameName:string, matchId:string, player:'a'|'b'}} data
 * @returns {string|null} null si relayUrl n'est pas une URL valide
 */
export function buildInvitationUrl({ relayUrl, gameName, matchId, player, chatKey = null, chatKeyId = null,
                                    allowTakeback = null }) {
    let url;
    try {
        url = new URL(relayUrl);
    } catch {
        return null;
    }
    url.pathname = url.pathname.replace(/[^/]*$/, 'index.php');
    url.search = '';
    url.hash = '';
    url.searchParams.set('game', gameName);
    url.searchParams.set('mid', matchId);
    url.searchParams.set('player', player);
    // Emis EXPLICITEMENT dans les deux sens (tb=1 comme tb=0) : un lien qui
    // ne dit rien laisse croire a un client ancien, pas a un choix.
    if (typeof allowTakeback === 'boolean') url.searchParams.set('tb', allowTakeback ? '1' : '0');
    /*
     * La clé va dans le FRAGMENT, et une clé mal formée est refusée plutôt
     * qu'écrite : un lien qui en porterait une inutilisable annoncerait une
     * discussion protégée qui ne le serait pas. Voir chatKeyFromHash pour
     * pourquoi le fragment et pas la requête.
     */
    if (chatKey !== null) {
        if (!isChatKey(chatKey)) return null;
        url.hash = 'k=' + chatKey;
    } else if (chatKeyId !== null) {
        // Une EMPREINTE plutot qu'une cle : les deux joueurs partagent deja la
        // cle de communaute, le lien n'a donc qu'a dire laquelle employer. Rien
        // de secret ne circule, et il n'y a rien a perdre a la copie.
        if (!/^[0-9a-f]{16}$/.test(chatKeyId)) return null;
        url.hash = 'kid=' + chatKeyId;
    }
    return url.toString();
}
