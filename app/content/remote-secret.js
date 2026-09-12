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

/**
 * Le scelleur d'une partie : ce que RelayChatChannel attend pour accepter
 * d'envoyer du texte libre.
 *
 * Deux appels de commande, rien de plus -- tout le travail est en Rust
 * (src-tauri/src/commands/seal_cmds.rs). Ce module ne connait ni l'algorithme,
 * ni la taille du nonce, ni le format du sceau : c'est ce qui permettra d'en
 * changer sans toucher au JS.
 *
 * `open` rend `null` plutot que de lever, parce que c'est ce que
 * decodeThread attend : un message qu'on ne peut pas ouvrir doit s'afficher
 * verrouille, pas faire disparaitre la conversation. Le Rust, lui, ne dit pas
 * POURQUOI il a echoue -- base64 abime, message tronque, sceau qui ne
 * correspond pas donnent la meme erreur -- et c'est voulu : la distinction
 * n'aiderait que celui qui cherche a deviner la cle.
 *
 * @param {string} key - 32 octets hexadecimaux (voir generateChatKey)
 * @param {Function} [invokeImpl] - injectable pour les tests
 */
export function makeSealer(key, invokeImpl = null) {
    if (!isSeed(key)) throw new Error('makeSealer: cle mal formee');
    const call = invokeImpl
        ? (cmd, args) => invokeImpl(cmd, args)
        : async (cmd, args) => {
            const { default: tRpc } = await import('./tabulon-rpc.js');
            return cmd === 'seal_text'
                ? tRpc.call('seal_text', args.key, args.text)
                : tRpc.call('open_text', args.key, args.sealed);
        };
    return {
        seal: (text) => call('seal_text', { key, text }),
        open: async (sealed) => {
            try { return await call('open_text', { key, sealed }); }
            catch { return null; }
        },
    };
}

/**
 * La cle d'une partie, derivee de la cle de communaute.
 *
 * RIEN NE CIRCULE : les deux joueurs la recalculent chacun de leur cote a
 * partir de ce qu'ils ont deja -- la cle partagee une fois -- et de
 * l'identifiant de partie, que le relai connait de toute facon puisque c'est sa
 * cle de stockage. Il n'y a donc rien a perdre a la copie d'un lien, et rien
 * qu'un membre de la communaute puisse intercepter en chemin.
 *
 * Le calcul est en Rust (seal_cmds.rs) : crypto.subtle exige un contexte
 * securise, que rien ne garantit pour tauri:// sous WebKitGTK.
 */
export async function deriveChatKey(master, matchId, invokeImpl = null) {
    if (!isSeed(master)) throw new Error('deriveChatKey: cle de communaute mal formee');
    if (invokeImpl) return invokeImpl('derive_chat_key', { master, info: String(matchId) });
    const { default: tRpc } = await import('./tabulon-rpc.js');
    return tRpc.call('derive_chat_key', master, String(matchId));
}

/**
 * L'empreinte publique d'une cle de communaute.
 *
 * Elle DESIGNE une cle sans la donner : avec plusieurs cles -- un club, une
 * famille, une competition -- l'invitation doit dire laquelle employer. Le nom
 * ne convient pas, chacun nommant les siennes comme il veut ; l'empreinte se
 * calcule depuis la cle elle-meme, donc les deux bouts trouvent la meme quel
 * que soit le nom donne de part et d'autre.
 */
export async function chatKeyId(master, invokeImpl = null) {
    if (!isSeed(master)) throw new Error('chatKeyId: cle de communaute mal formee');
    if (invokeImpl) return invokeImpl('chat_key_id', { master });
    const { default: tRpc } = await import('./tabulon-rpc.js');
    return tRpc.call('chat_key_id', master);
}

/** Forme d'une empreinte : 8 octets en hexadecimal. */
export function isChatKeyId(value) {
    return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);
}

/**
 * La cle de discussion d'une invitation qu'on REJOINT.
 *
 * Une invitation porte l'un ou l'autre, jamais les deux : une cle (adversaire
 * inconnu, tiree au hasard et transportee par le fragment du lien) ou
 * l'EMPREINTE du trousseau a employer (adversaire de la meme communaute). Dans
 * le second cas la cle ne circule pas du tout : on cherche parmi les notres
 * celle qui porte cette empreinte -- le nom qu'on lui a donne n'a aucune
 * importance, c'est la cle elle-meme qui la produit -- et on en derive celle de
 * la partie.
 *
 * ICI PLUTOT QUE DANS LA FENETRE INVITATION parce qu'il y a DEUX portes pour
 * rejoindre une partie : cette fenetre, et le panneau Invitation du hub. La
 * seconde ne faisait pas ce travail, et une meme invitation ouverte par l'une
 * donnait une discussion, par l'autre rien -- sans que rien ne le dise.
 *
 * Le trousseau est passe en ARGUMENT plutot que relu ici : ce module ne connait
 * pas le store, et une fonction qui ne lit rien se teste sans en simuler un.
 *
 * @param {{chatKey?:string, chatKeyId?:string, matchId:string}} parsed
 * @param {Array<{key:string}>} communityKeys - contenu de la preference
 *   `community-keys`, tel quel.
 * @returns {Promise<string|null>} null = pas de discussion pour cette partie,
 *   ce qui est un etat normal (invitation ancienne, groupe inconnu).
 */
export async function resolveInviteChatKey(parsed, communityKeys, invokeImpl = null) {
    if (!parsed) return null;
    if (parsed.chatKey) return parsed.chatKey;
    if (!parsed.chatKeyId || !Array.isArray(communityKeys)) return null;
    for (const entry of communityKeys) {
        if (!entry?.key) continue;
        try {
            if (await chatKeyId(entry.key, invokeImpl) !== parsed.chatKeyId) continue;
            return await deriveChatKey(entry.key, parsed.matchId, invokeImpl);
        } catch (e) {
            console.warn('[remote-secret] trousseau illisible :', e.message || e);
        }
    }
    console.info('[remote-secret] aucune cle de communaute ne correspond a cette invitation');
    return null;
}
