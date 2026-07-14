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

// Relai HTTP par defaut (etape 1/2 : instance de test jocly-simple-match
// utilisee pour valider le protocole -- voir README.md § Remote play et
// ANALYSE-JEU-DISTANCE.md). A rendre choisissable par l'utilisateur dans une
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
export function encodeEnvelope({ nbTurns, lastMove = null, state = null }) {
    if (!Number.isInteger(nbTurns) || nbTurns < 0) {
        throw new Error('encodeEnvelope: nbTurns doit être un entier >= 0');
    }
    return JSON.stringify({
        v: PROTOCOL_VERSION,
        nbTurns,
        lastMove,
        state,
        updatedAt: Date.now(),
    });
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
    return {
        v: Number.isInteger(data.v) ? data.v : 1,
        nbTurns: data.nbTurns,
        lastMove: data.lastMove ?? null,
        state: data.state ?? null,
        updatedAt: Number.isInteger(data.updatedAt) ? data.updatedAt : null,
    };
}

/**
 * true si l'enveloppe distante contient un coup que nous n'avons pas encore
 * localement (nbTurns distant strictement supérieur au nôtre).
 * @param {number} localNbTurns
 * @param {{nbTurns:number}|null} remoteEnvelope
 */
export function hasOpponentMoved(localNbTurns, remoteEnvelope) {
    return !!remoteEnvelope && remoteEnvelope.nbTurns > localNbTurns;
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
// tout l'interet du bouton "Invitation" (voir README.md § Remote play).
// matchdata est un objet Jocly opaque (mais du meme moteur jocly2 des deux
// cotes, donc du meme format) ; on ne l'interprete jamais ici, seul
// matchdata.playedMoves (tableau) est lu pour en extraire le dernier coup.

/**
 * @param {{matchId:string, gameName:string, nbTurns:number, matchdata:*}} data
 * @returns {string} JSON pret a poster comme "gamedata"
 */
export function encodeJoclySimpleMatchEnvelope({ matchId, gameName, nbTurns, matchdata }) {
    if (!matchId) throw new Error('encodeJoclySimpleMatchEnvelope: matchId requis');
    if (!Number.isInteger(nbTurns) || nbTurns < 0) {
        throw new Error('encodeJoclySimpleMatchEnvelope: nbTurns doit être un entier >= 0');
    }
    return JSON.stringify({
        matchDetails: { matchId, gameName, nbTurns, a: { pseudo: '' }, b: { pseudo: '' } },
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
    return { nbTurns, lastMove, state: data.matchdata ?? null };
}

/**
 * Décompose un lien d'invitation jocly-simple-match, ex. :
 *   https://biscandine.fr/variantes/joclymatch/index.php?game=knightmate-chess&mid=1784023862731-pIUWbcgh0yDFVT&player=a
 * en {gameName, matchId, player, relayUrl} -- relayUrl est déduite en
 * remplaçant index.php par fileio.php dans le même dossier (les deux scripts
 * vivent toujours côte à côte dans jocly-simple-match).
 * @param {string} urlString
 * @returns {{gameName:string, matchId:string, player:'a'|'b', relayUrl:string}|null}
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
    return { gameName, matchId, player: playerParam, relayUrl: url.origin + relayPath };
}
