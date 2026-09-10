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
    SEED_KEY, SEED_BYTES, generateSeed, isSeed, getOrCreateSeed, rotateSeed,
} from '../app/content/remote-secret.js';
import { decodeEnvelope, encodeEnvelope, hasOpponentMoved } from '../app/content/remote-relay-protocol.js';

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };
const throws = (fn, m) => { try { fn(); ok(false, m); } catch { ok(true, m); } };

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
    ok(requiresSeal(chat.kind), 'un message de discussion doit être scellé');

    // LE point de ce module : sans scelleur, l’encodage ÉCHOUE. Un envoi en
    // clair ne se verrait pas, et le relai garde ce qu’on lui donne.
    throws(() => encodeThread([chat]), 'sans scelleur, l’encodage échoue plutôt que d’envoyer en clair');

    // Scelleur factice : il n'imite pas la sécurité — le vrai sera en Rust —
    // mais il doit au moins CACHER le texte, sinon l'assertion qui suit ne
    // vérifierait rien.
    const sealer = {
        seal: (t) => 'S:' + [...t].reverse().join(''),
        open: (t) => t.startsWith('S:') ? [...t.slice(2)].reverse().join('') : null,
    };
    const wire = encodeThread([chat], { sealer });
    ok(!wire.includes('bien joué'), 'scellé, le texte n’apparaît pas sur le fil');

    const back = decodeThread(wire, { sealer });
    ok(back.length === 1 && back[0].body === 'bien joué', 'et se relit avec la clé');

    // Sans la clé, le message est CONSERVÉ et marqué : un trou silencieux
    // dans une conversation est pire qu’un cadenas visible.
    const locked = decodeThread(wire);
    ok(locked.length === 1 && locked[0].locked && locked[0].body === null,
       'sans la clé, il reste visible mais verrouillé');
    ok(locked[0].reason === 'noKey', 'et la raison est dite : ' + locked[0].reason);

    // Un correspondant mal configuré qui enverrait du clair : gardé,
    // verrouillé aussi. L’afficher tel quel laisserait croire que le canal
    // protège quelque chose.
    const plain = JSON.stringify({ v: THREAD_VERSION, msgs: [{ ...chat }] });
    const p = decodeThread(plain, { sealer });
    ok(p.length === 1 && p[0].locked && p[0].reason === 'unsealed',
       'un message reçu en clair est signalé, pas affiché');

    // Mauvaise clé : même traitement, raison différente — c’est ce qui
    // distingue « je n’ai pas la clé » de « ce n’est pas la bonne ».
    const wrong = decodeThread(wire, { sealer: { seal: (t) => t, open: () => null } });
    ok(wrong[0].locked && wrong[0].reason === 'badKey', 'une mauvaise clé se distingue d’une clé absente');
}

console.log('');
console.log('La présence n’a rien à chiffrer');
{
    const pause = newMessage({ kind: ENVELOPE_KIND.PRESENCE, side: B, state: PRESENCE.PAUSED, at: 2000, rand });
    ok(!requiresSeal(pause.kind), 'un état de présence n’est pas du texte');
    // Il passe donc SANS scelleur : c’est ce qui permet de dire « je fais une
    // pause » même quand la discussion est désactivée.
    const wire = encodeThread([pause]);
    ok(decodeThread(wire)[0].state === PRESENCE.PAUSED, 'et voyage sans clé');
    ok(!wire.includes('pause') || wire.includes('paused'),
       'transporté comme identifiant, pas comme phrase — chacun l’affiche dans sa langue');

    throws(() => newMessage({ kind: ENVELOPE_KIND.PRESENCE, side: A, state: 'gone-fishing', rand }),
        'un état inconnu est refusé à l’émission');
    ok(decodeThread(JSON.stringify({ v: 1, msgs: [{ ...pause, state: 'gone-fishing' }] })).length === 0,
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
        ok(Array.isArray(decodeThread(bad)) && decodeThread(bad).length === 0,
           'entrée illisible -> liste vide : ' + JSON.stringify(bad.slice(0, 18)));

    // Un genre inconnu est ignoré en silence : c’est ce qui permettra d’en
    // ajouter un quatrième sans casser les clients d’aujourd’hui.
    const future = JSON.stringify({ v: 99, msgs: [
        { id: 'z1', kind: 'reaction', side: 1, at: 1, emoji: '👏' },
        { id: 'z2', kind: ENVELOPE_KIND.NUDGE, side: 1, at: 2 },
    ] });
    ok(decodeThread(future).length === 1, 'un genre inconnu est ignoré, le reste du fil passe');
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
console.log(`RESULTAT remote-chat-protocol: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
