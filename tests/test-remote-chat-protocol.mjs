// tests/test-remote-chat-protocol.mjs — échanger autre chose que des coups.
//
// Logique pure, testée sous Node comme les deux autres protocoles distants.
// Rien de ce qui suit ne touche au réseau : ce qui est vérifié ici, c'est la
// FORME de ce qui circulera, avant qu'une interface ne s'appuie dessus.
//
// Trois choses s'y jouent, et chacune est une décision plutôt qu'un détail :
//
//   1. un message de discussion ne peut pas partir en clair. Un relai sans
//      authentification garde ce qu'on lui donne, et un oubli de scellement ne
//      se voit pas — d'où un échec bruyant plutôt qu'un envoi silencieux ;
//   2. un fil illisible rend une liste vide, jamais une exception : c'est la
//      règle que decodeEnvelope suit déjà, et une partie ne doit pas casser
//      parce qu'un relai a répondu une page d'erreur ;
//   3. les états de présence sont des drapeaux, pas des phrases — ils
//      traversent le réseau comme identifiants, s'affichent dans la langue de
//      chacun, et n'ont donc rien à chiffrer.
//
// Usage : node tests/test-remote-chat-protocol.mjs
import {
    ENVELOPE_KIND, PRESENCE, THREAD_VERSION, NUDGE_MIN_INTERVAL_MS,
    chatMidFor, newMessage, encodeThread, decodeThread, mergeThreads,
    presenceOf, canNudge, requiresSeal,
} from '../app/content/remote-chat-protocol.js';
import {
    SEED_KEY, SEED_BYTES, generateSeed, generateChatKey, isSeed, getOrCreateSeed, rotateSeed,
    makeSealer, resolveInviteChatKey,
} from '../app/content/remote-secret.js';
import { isChatKey } from '../app/content/remote-relay-protocol.js';
import { decodeEnvelope, encodeEnvelope, hasOpponentMoved } from '../app/content/remote-relay-protocol.js';

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };
const throws = (fn, m) => { try { fn(); ok(false, m); } catch { ok(true, m); } };
// Le scellement se fait en Rust, donc par une promesse : encodeThread et
// decodeThread sont asynchrones et leurs refus se rattrapent en await.
const rejects = async (fn, m) => { try { await fn(); ok(false, m); } catch { ok(true, m); } };

// Aléa déterministe : un identifiant de message doit être unique, pas
// imprévisible — il ne sert qu'à dédupliquer.
let counter = 0;
const rand = (bytes) => { for (let i = 0; i < bytes.length; i++) bytes[i] = (counter + i) & 0xff; counter += 7; };

const A = 1, B = -1;

console.log('L’enveloppe sait désormais de quoi elle parle');
{
    // Sans ce champ, un message de discussion ayant par hasard un nbTurns
    // serait joué comme un coup, et un message sans nbTurns serait rejeté.
    const move = decodeEnvelope(encodeEnvelope({ nbTurns: 3 }));
    ok(move.kind === ENVELOPE_KIND.MOVE, 'un coup se déclare comme tel');

    // Compatibilité : une enveloppe écrite avant le champ n’en a pas, et
    // c’était forcément un coup — il n’y avait rien d’autre.
    const old = decodeEnvelope(JSON.stringify({ v: 1, nbTurns: 5, lastMove: null, state: null }));
    ok(old && old.kind === ENVELOPE_KIND.MOVE, 'une enveloppe ancienne reste un coup');

    // Et l’inverse : ce qui n’est pas un coup ne doit pas franchir le
    // décodeur du canal de partie.
    ok(decodeEnvelope(JSON.stringify({ v: 1, kind: 'chat', nbTurns: 9 })) === null,
       'un message de discussion n’est pas décodé comme un coup');
    ok(hasOpponentMoved(0, { kind: 'chat', nbTurns: 9 }) === false,
       'et ne fait pas avancer la partie');
    ok(hasOpponentMoved(0, { nbTurns: 1 }) === true, 'un vrai coup, si');
}

console.log('');
console.log('Un fil par joueur');
{
    // Les deux relais stockent une clé -> une valeur en dernier-écrit-gagne.
    // Deux joueurs dans la même clé, ce sont des messages perdus dès qu’ils
    // écrivent en même temps ; une clé par camp supprime la concurrence.
    const id = '7f3c9a12-0000-4000-8000-abcdefabcdef';
    ok(chatMidFor(id, A) !== chatMidFor(id, B), 'chaque camp a sa clé');
    ok(chatMidFor(id, A) === chatMidFor(id, A), 'et la calcule sans se concerter');
    // match.php valide /^[A-Za-z0-9_-]{6,64}$/ : un point ou une barre serait
    // une traversée de répertoire, et un identifiant trop long donnerait un
    // échec réseau opaque plutôt qu’une erreur lisible.
    ok(/^[A-Za-z0-9_-]{6,64}$/.test(chatMidFor(id, A)),
       'au format que le relai accepte : ' + chatMidFor(id, A));
    throws(() => chatMidFor('x'.repeat(70), A), 'un identifiant trop long est refusé ici, pas par le serveur');
    throws(() => chatMidFor(id, 0), 'un camp inattendu est refusé');
}

console.log('');
console.log('Le texte libre ne part pas en clair');
{
    const chat = newMessage({ kind: ENVELOPE_KIND.CHAT, side: A, body: 'bien joué', at: 1000, rand });
    ok(requiresSeal(chat), 'un message de discussion doit être scellé');

    // LE point de ce module : sans scelleur, l’encodage ÉCHOUE. Un envoi en
    // clair ne se verrait pas, et le relai garde ce qu’on lui donne.
    await rejects(() => encodeThread([chat]), 'sans scelleur, l’encodage échoue plutôt que d’envoyer en clair');

    // Scelleur factice : il n'imite pas la sécurité — le vrai sera en Rust —
    // mais il doit au moins CACHER le texte, sinon l'assertion qui suit ne
    // vérifierait rien.
    const sealer = {
        seal: (t) => 'S:' + [...t].reverse().join(''),
        open: (t) => t.startsWith('S:') ? [...t.slice(2)].reverse().join('') : null,
    };
    const wire = await encodeThread([chat], { sealer });
    ok(!wire.includes('bien joué'), 'scellé, le texte n’apparaît pas sur le fil');

    const back = await decodeThread(wire, { sealer });
    ok(back.length === 1 && back[0].body === 'bien joué', 'et se relit avec la clé');

    // Sans la clé, le message est CONSERVÉ et marqué : un trou silencieux
    // dans une conversation est pire qu’un cadenas visible.
    const locked = await decodeThread(wire);
    ok(locked.length === 1 && locked[0].locked && locked[0].body === null,
       'sans la clé, il reste visible mais verrouillé');
    ok(locked[0].reason === 'noKey', 'et la raison est dite : ' + locked[0].reason);

    // Un correspondant mal configuré qui enverrait du clair : gardé,
    // verrouillé aussi. L’afficher tel quel laisserait croire que le canal
    // protège quelque chose.
    const plain = JSON.stringify({ v: THREAD_VERSION, msgs: [{ ...chat }] });
    const p = await decodeThread(plain, { sealer });
    ok(p.length === 1 && p[0].locked && p[0].reason === 'unsealed',
       'un message reçu en clair est signalé, pas affiché');

    // Mauvaise clé : même traitement, raison différente — c’est ce qui
    // distingue « je n’ai pas la clé » de « ce n’est pas la bonne ».
    const wrong = await decodeThread(wire, { sealer: { seal: (t) => t, open: () => null } });
    ok(wrong[0].locked && wrong[0].reason === 'badKey', 'une mauvaise clé se distingue d’une clé absente');
}

console.log('');
console.log('Les messages rapides');
{
    /*
     * « Bien joué », « à toi », « je reviens » : ils voyagent comme
     * IDENTIFIANT et se traduisent chez celui qui les lit. Deux joueurs sans
     * langue commune se comprennent donc, et rien de personnel ne transite --
     * ce qui les rend utilisables dans une partie SANS clé, contrairement au
     * texte libre.
     */
    const quick = newMessage({ kind: ENVELOPE_KIND.CHAT, side: A, quick: 'wellPlayed', at: 5, rand });
    ok(!requiresSeal(quick), 'un message rapide n’a rien à sceller');
    ok(quick.body === undefined, 'il ne porte pas de texte');
    const wire = await encodeThread([quick]);          // sans scelleur : doit passer
    ok((await decodeThread(wire))[0].quick === 'wellPlayed', 'et voyage sans clé');

    // Un identifiant est un nom, pas une phrase : ce qui arrivera dans un
    // t('chat.' + quick) doit rester une clé de dictionnaire.
    throws(() => newMessage({ kind: ENVELOPE_KIND.CHAT, side: A, quick: 'oops; DROP', rand }),
        'un identifiant fantaisiste est refusé à l’émission');
    ok((await decodeThread(JSON.stringify({ v: 1, msgs: [{ ...quick, quick: 'a b c' }] }))).length === 0,
       'et ignoré à la réception');

    // Un message de discussion doit dire quelque chose : ni texte ni
    // identifiant, il n’a rien à afficher.
    throws(() => newMessage({ kind: ENVELOPE_KIND.CHAT, side: A, rand }),
        'un message vide est refusé');
}

console.log('');
console.log('La présence n’a rien à chiffrer');
{
    const pause = newMessage({ kind: ENVELOPE_KIND.PRESENCE, side: B, state: PRESENCE.PAUSED, at: 2000, rand });
    ok(!requiresSeal(pause), 'un état de présence n’est pas du texte');
    // Il passe donc SANS scelleur : c’est ce qui permet de dire « je fais une
    // pause » même quand la discussion est désactivée.
    const wire = await encodeThread([pause]);
    ok((await decodeThread(wire))[0].state === PRESENCE.PAUSED, 'et voyage sans clé');
    ok(!wire.includes('pause') || wire.includes('paused'),
       'transporté comme identifiant, pas comme phrase — chacun l’affiche dans sa langue');

    throws(() => newMessage({ kind: ENVELOPE_KIND.PRESENCE, side: A, state: 'gone-fishing', rand }),
        'un état inconnu est refusé à l’émission');
    ok((await decodeThread(JSON.stringify({ v: 1, msgs: [{ ...pause, state: 'gone-fishing' }] }))).length === 0,
       'et ignoré à la réception');

    const conv = mergeThreads(
        [newMessage({ kind: ENVELOPE_KIND.PRESENCE, side: B, state: PRESENCE.PAUSED, at: 10, rand })],
        [newMessage({ kind: ENVELOPE_KIND.PRESENCE, side: B, state: PRESENCE.BACK, at: 20, rand })]);
    ok(presenceOf(conv, B).state === PRESENCE.BACK, 'seul le dernier état compte');
    ok(presenceOf(conv, A) === null, 'et un camp muet n’en a aucun');
}

console.log('');
console.log('Une conversation se recolle');
{
    const m1 = newMessage({ kind: ENVELOPE_KIND.NUDGE, side: A, at: 100, rand });
    const m2 = newMessage({ kind: ENVELOPE_KIND.NUDGE, side: B, at: 50, rand });
    const conv = mergeThreads([m1], [m2], [m1]);
    ok(conv.length === 2, 'un message relu deux fois n’apparaît qu’une fois');
    ok(conv[0].at === 50, 'et l’ordre suit le temps');

    // Deux horloges de machines différentes ne s’accordent pas. Sans
    // départage, l’ordre affiché changerait d’un rafraîchissement à l’autre.
    const tie = mergeThreads([
        { id: 'bbbb', kind: ENVELOPE_KIND.NUDGE, side: A, at: 7 },
        { id: 'aaaa', kind: ENVELOPE_KIND.NUDGE, side: B, at: 7 },
    ]);
    ok(tie[0].id === 'aaaa' && tie[1].id === 'bbbb', 'à égalité de date, l’ordre reste stable');
}

console.log('');
console.log('Un fil illisible ne casse rien');
{
    // Même règle que decodeEnvelope : jamais d’exception, jamais null.
    for (const bad of ['', '   ', 'pas du json', '<html>404</html>', '{}', '{"msgs":"non"}', 'null'])
        ok(Array.isArray(await decodeThread(bad)) && (await decodeThread(bad)).length === 0,
           'entrée illisible -> liste vide : ' + JSON.stringify(bad.slice(0, 18)));

    // Un genre inconnu est ignoré en silence : c’est ce qui permettra d’en
    // ajouter un quatrième sans casser les clients d’aujourd’hui.
    const future = JSON.stringify({ v: 99, msgs: [
        { id: 'z1', kind: 'reaction', side: 1, at: 1, emoji: '👏' },
        { id: 'z2', kind: ENVELOPE_KIND.NUDGE, side: 1, at: 2 },
    ] });
    ok((await decodeThread(future)).length === 1, 'un genre inconnu est ignoré, le reste du fil passe');
}

console.log('');
console.log('La relance est bornée');
{
    // Une relance fait remonter une notification chez l’autre même fenêtre
    // fermée : sans limite, c’est une arme.
    const conv = [newMessage({ kind: ENVELOPE_KIND.NUDGE, side: A, at: 1_000_000, rand })];
    ok(canNudge(conv, A, 1_000_000 + 1000) === false, 'pas deux relances coup sur coup');
    ok(canNudge(conv, A, 1_000_000 + NUDGE_MIN_INTERVAL_MS) === true, 'mais de nouveau après le délai');
    ok(canNudge(conv, B, 1_000_000 + 1000) === true, 'la limite est par joueur');
    ok(canNudge([], A) === true, 'et la première est toujours permise');
}

console.log('');
console.log('La graine');
{
    ok(isSeed(generateSeed()), 'une graine neuve est au bon format');
    ok(generateSeed() !== generateSeed(), 'et deux graines diffèrent');
    ok(generateSeed().length === SEED_BYTES * 2, `${SEED_BYTES} octets, en hexadécimal`);
    for (const bad of [null, '', 'abc', 'x'.repeat(64), 123])
        ok(!isSeed(bad), 'valeur abîmée rejetée : ' + JSON.stringify(bad));

    const mem = new Map();
    const store = { get: async (k) => mem.get(k), set: async (k, v) => { mem.set(k, v); } };

    // Paresseuse : tant que personne ne joue à distance, aucune raison
    // d’écrire un secret dans les préférences.
    ok(mem.size === 0, 'rien n’est écrit avant qu’on la demande');
    const first = await getOrCreateSeed(store);
    ok(isSeed(first) && mem.get(SEED_KEY) === first, 'créée et rangée au premier appel');
    ok(await getOrCreateSeed(store) === first, 'puis stable d’un appel à l’autre');

    // Une préférence abîmée est REMPLACÉE, pas réparée : une graine à moitié
    // valide ne protège rien.
    mem.set(SEED_KEY, 'nawak');
    const repaired = await getOrCreateSeed(store);
    ok(isSeed(repaired) && repaired !== 'nawak', 'une graine abîmée est remplacée');

    // Révocation : les invitations déjà envoyées cessent de fonctionner, ce
    // qui est exactement ce qu’on attend d’un secret qu’on remplace.
    const rotated = await rotateSeed(store);
    ok(isSeed(rotated) && rotated !== repaired, 'la rotation en produit une autre');
    ok(await getOrCreateSeed(store) === rotated, 'et c’est elle qui sert ensuite');
}

console.log('');
console.log('La clé d’une partie');
{
    // Elle est tirée au sort et rangée à côté de la partie, plutôt que dérivée
    // de la graine : la dérivation demanderait un HMAC, donc crypto.subtle
    // (contexte sécurisé non garanti sous tauri://) ou du Rust — et elle ne
    // sert que le jour où l'on veut rouvrir la discussion d'une partie dont on
    // a effacé la trace locale.
    const k = generateChatKey();
    ok(generateChatKey() !== generateChatKey(), 'deux parties, deux clés');
    // Même forme que la graine, et surtout : la forme que le lien
    // d'invitation sait transporter. Passer un jour à une clé dérivée ne
    // changera donc rien à ce qui circule.
    ok(isChatKey(k), 'au format que le lien d’invitation accepte');
    ok(isSeed(k), 'et identique à celui de la graine');
}

console.log('');
console.log('Le scelleur');
{
    // Il ne fait que deux appels de commande : tout le travail est en Rust
    // (seal_cmds.rs). Ce module ne connait ni l'algorithme, ni la taille du
    // nonce, ni le format du sceau — c'est ce qui permettra d'en changer sans
    // toucher au JS. Le faux Rust ci-dessous imite donc l'INTERFACE, pas la
    // sécurité.
    const calls = [];
    const fakeRust = async (cmd, args) => {
        calls.push(cmd);
        if (cmd === 'seal_text') return 'X' + [...args.text].reverse().join('');
        if (!String(args.sealed).startsWith('X')) throw new Error('message illisible');
        return [...String(args.sealed).slice(1)].reverse().join('');
    };
    const key = generateChatKey();
    const sealer = makeSealer(key, fakeRust);

    const wire = await encodeThread(
        [newMessage({ kind: ENVELOPE_KIND.CHAT, side: A, body: 'à tout de suite', at: 1, rand })],
        { sealer });
    ok(calls.includes('seal_text'), 'sceller passe par la commande Rust');
    ok(!wire.includes('tout de suite'), 'et le texte ne se lit pas dans le fil');
    ok((await decodeThread(wire, { sealer }))[0].body === 'à tout de suite',
       'ouvrir le rend intact, accents compris');

    // Le Rust LÈVE quand il ne peut pas ouvrir ; decodeThread, lui, attend un
    // null — un message illisible doit s'afficher verrouillé, pas faire
    // disparaître la conversation.
    ok(await sealer.open('sans le préfixe') === null, 'un sceau refusé rend null plutôt que de lever');

    // La clé est validée ici, avant le premier appel : le Rust panique sur une
    // longueur inattendue (Key::from_slice), et la valeur vient d'un lien collé
    // par l'utilisateur.
    for (const bad of ['', 'trop court', null])
        throws(() => makeSealer(bad, fakeRust), 'clé mal formée refusée : ' + JSON.stringify(bad));
}

console.log('');
console.log('La clé d’une invitation reçue, quelle que soit la porte');
{
    /*
     * MISE EN COMMUN, et c'est ce qui se teste ici. Il y a DEUX portes pour
     * rejoindre une partie -- la fenêtre Invitation et le panneau du hub -- et
     * une seule faisait ce travail. La même invitation donnait donc une
     * discussion par l'une et rien par l'autre, sans que rien ne le dise.
     */
    const fakeRust = async (cmd, args) => {
        if (cmd === 'chat_key_id') return args.master.slice(0, 16);
        if (cmd === 'derive_chat_key') return 'd'.repeat(63) + (args.info === 'm-1' ? '1' : '2');
        throw new Error('commande inattendue : ' + cmd);
    };
    const mine = generateChatKey(), other = generateChatKey();
    const keyring = [{ key: other, name: 'club' }, { key: mine, name: 'famille' }];

    // Cas 1 : le lien porte une clé (adversaire inconnu). Elle sert telle
    // quelle, sans aller voir le trousseau.
    ok(await resolveInviteChatKey({ chatKey: mine, matchId: 'm-1' }, keyring, fakeRust) === mine,
       'une clé portée par le lien sert telle quelle');

    // Cas 2 : le lien ne porte qu'une EMPREINTE. On retrouve la clé chez nous
    // et on en dérive celle de la partie -- rien de secret n'a circulé.
    const derived = await resolveInviteChatKey(
        { chatKeyId: mine.slice(0, 16), matchId: 'm-1' }, keyring, fakeRust);
    ok(derived === 'd'.repeat(63) + '1', 'une empreinte connue donne la clé dérivée de la partie');
    ok(derived !== mine, 'et ce n’est pas la clé de communauté elle-même');

    // La dérivation dépend de la PARTIE : deux parties du même groupe n'ont
    // pas la même clé.
    ok(await resolveInviteChatKey({ chatKeyId: mine.slice(0, 16), matchId: 'm-2' }, keyring, fakeRust)
       !== derived, 'une autre partie du même groupe donne une autre clé');

    // Cas 3 : groupe inconnu, trousseau vide, invitation d'avant cette
    // version. Pas de discussion -- un état normal, pas une panne.
    for (const [parsed, ring, what] of [
        [{ chatKeyId: 'f'.repeat(16), matchId: 'm-1' }, keyring, 'une empreinte inconnue'],
        [{ chatKeyId: mine.slice(0, 16), matchId: 'm-1' }, null, 'un trousseau absent'],
        [{ matchId: 'm-1' }, keyring, 'une invitation sans clé ni empreinte'],
        [null, keyring, 'une invitation illisible'],
    ]) ok(await resolveInviteChatKey(parsed, ring, fakeRust) === null, what + ' ne donne pas de clé');
}

console.log('');
console.log(`RESULTAT remote-chat-protocol: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
