// app/content/remote-secret.js -- La graine qui protégera les discussions
// à distance.
//
// LE PROBLÈME QU'ELLE RÉSOUT. Les relais connus n'ont aucune authentification :
// tout ce qu'on y dépose est lisible par qui tient le serveur, et par qui
// devine un identifiant de partie. Chiffrer avec une clé dérivée de cet
// identifiant ne protégerait de rien -- il est ENVOYÉ au serveur à chaque
// requête, c'est même la clé de stockage.
//
// Il faut donc un second secret qui ne parte JAMAIS vers le relai. Celui-ci
// vit dans les préférences de Tabulon, il est propre à l'installation, et il
// voyage d'un joueur à l'autre par le lien d'invitation -- lequel passe par un
// autre canal (message, courriel), pas par le relai.
//
// CE QUI N'EST PAS ENCORE LÀ, et ne doit pas être improvisé ici : la dérivation
// (graine + identifiant de partie -> clé de session) et le scellement lui-même.
// Les deux appartiennent au Rust : crypto.subtle exige un contexte sécurisé, et
// rien ne garantit que tauri:// en soit un sous WebKitGTK -- le projet a déjà
// payé ce pari avec WebRTC (voir remote-peer-protocol.js). getRandomValues, en
// revanche, est disponible partout, y compris hors contexte sécurisé : générer
// la graine ici ne coûte rien et évite d'ajouter une source d'aléa côté Cargo,
// exactement comme generatePeerToken.
//
// Ce module ne fait donc que : produire une graine, la ranger, la relire.

/** Longueur de la graine, en octets. 32 = de quoi dériver une clé de 256 bits
 *  sans que la graine soit le maillon faible. */
export const SEED_BYTES = 32;

/** Clé de préférence. Le préfixe `remote-` la range avec ce qui touche au jeu
 *  à distance ; elle n'est jamais transmise sous ce nom. */
export const SEED_KEY = 'remote-secret-seed';

/**
 * Une graine neuve, en hexadécimal.
 *
 * Pas de repli vers Math.random : une graine devinable est pire qu'une absence
 * de chiffrement, parce qu'elle en donne l'apparence. Mieux vaut échouer et
 * laisser l'appelant désactiver la discussion.
 */
export function generateSeed() {
    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function')
        throw new Error('remote-secret: aucune source d’aléa sûre disponible');
    const bytes = new Uint8Array(SEED_BYTES);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Une graine est-elle de la bonne forme ? Sert à rejeter une préférence
 *  abîmée plutôt qu'à s'en servir. */
export function isSeed(value) {
    return typeof value === 'string' && new RegExp(`^[0-9a-f]{${SEED_BYTES * 2}}$`).test(value);
}

/**
 * La graine de cette installation, créée au premier appel.
 *
 * PARESSEUSE À DESSEIN : tant que personne ne joue à distance, il n'y a aucune
 * raison d'écrire un secret dans les préférences. Une préférence illisible ou
 * abîmée est REMPLACÉE plutôt que réparée -- une graine à moitié valide ne
 * protège rien, et la seule conséquence est que les invitations déjà envoyées
 * cessent de fonctionner, ce qui est le bon comportement pour un secret.
 *
 * @param {{get:Function,set:Function}} store - le Store de tauri-bridge
 */
export async function getOrCreateSeed(store) {
    if (!store) throw new Error('getOrCreateSeed: store requis');
    let seed = null;
    try { seed = await store.get(SEED_KEY); } catch { seed = null; }
    if (isSeed(seed)) return seed;
    seed = generateSeed();
    await store.set(SEED_KEY, seed);
    return seed;
}

/**
 * Une clé de discussion pour UNE partie.
 *
 * Même forme que la graine -- 32 octets, hexadécimal -- parce que c'est la
 * forme que le lien d'invitation transporte (voir isChatKey dans
 * remote-relay-protocol.js).
 *
 * DEUX FAÇONS DE L'OBTENIR, et il faut choisir :
 *
 *   a) la tirer au sort ici, et la ranger à côté de la partie. Ne demande
 *      aucune primitive de dérivation, donc rien côté Rust : getRandomValues
 *      suffit, et il est disponible partout. En contrepartie, une clé perdue
 *      est une conversation perdue.
 *
 *   b) la dériver de la graine et de l'identifiant de partie. Rien à ranger --
 *      la clé se recalcule pour n'importe quelle partie, même reprise depuis
 *      l'historique. Mais la dérivation demande un HMAC, donc crypto.subtle
 *      (contexte sécurisé non garanti sous tauri://) ou du Rust.
 *
 * C'est (a) qui est écrit ici, parce qu'elle ne bloque rien et que la
 * différence ne se voit que le jour où l'on veut rouvrir la discussion d'une
 * partie dont on a effacé la trace locale. deriveChatKey() reste à écrire
 * quand ce jour viendra ; la graine est déjà là pour ça, et le format des
 * deux est identique, donc passer de l'une à l'autre ne change rien à ce qui
 * circule.
 */
export function generateChatKey() {
    return generateSeed();
}

/**
 * Remplace la graine.
 *
 * Le geste « je repars de zéro » : toutes les invitations déjà envoyées
 * deviennent inutilisables, et les fils déjà déposés sur un relai illisibles,
 * y compris pour nous. C'est voulu -- c'est ce qu'on attend d'une révocation.
 */
export async function rotateSeed(store) {
    if (!store) throw new Error('rotateSeed: store requis');
    const seed = generateSeed();
    await store.set(SEED_KEY, seed);
    return seed;
}
