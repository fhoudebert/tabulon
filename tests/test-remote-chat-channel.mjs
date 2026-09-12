// test-remote-chat-channel.mjs — le transport des messages qui ne sont pas des
// coups, contre un relai en mémoire et un pair-à-pair simulé.
//
// Même forme que test-remote-channel.mjs et test-remote-peer-channel.mjs : le
// relai est un équivalent en mémoire de fileio.php (stockage texte brut par
// gameid, aucune validation de structure — c'est ce que fait le vrai script), et
// le pair-à-pair passe par des invoke/listen injectés.
//
// CE QUI SE JOUE ICI, et qui n'est visible qu'au niveau du transport :
//
//   1. deux clés, un seul écrivain chacune. Les deux relais stockent en
//      dernier-écrit-gagne ; deux joueurs dans la même clé, ce sont des
//      messages perdus dès qu'ils écrivent en même temps ;
//   2. un fil est déposé ENTIER à chaque message, donc une fenêtre rouverte
//      doit d'abord relire le sien, sans quoi son premier message effacerait
//      tout ce qu'elle avait dit ;
//   3. sur le fil pair-à-pair, coups et messages passent par le même
//      événement : chacun doit ignorer ce qui ne le concerne pas.
//
// Usage : node tests/test-remote-chat-channel.mjs

// ── Mock relai (équivalent en mémoire de fileio.php) ─────────────────────────
const store = new Map();          // gameid -> texte brut
const writes = [];                // trace des clés écrites, pour l'assertion
async function mockFetch(url, init) {
    const params = new URLSearchParams(init.body);
    const action = params.get('gameioaction');
    const gameid = params.get('gameid');
    if (action === 'save') {
        writes.push(gameid);
        store.set(gameid, params.get('gamedata'));
        return { status: 200, text: async () => '{"ok":true}' };
    }
    if (action === 'load') {
        return { status: 200, text: async () => store.get(gameid) ?? '' };
    }
    return { status: 400, text: async () => '' };
}
globalThis.window = { __TAURI__: { http: { fetch: mockFetch } } };

const { RelayChatChannel, PeerChatChannel } =
    await import('../app/content/remote-chat-channel.js');
const { ENVELOPE_KIND, PRESENCE, chatMidFor } =
    await import('../app/content/remote-chat-protocol.js');
const { encodeEnvelope } = await import('../app/content/remote-relay-protocol.js');

let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 2000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return; await sleep(10); }
    throw new Error('timeout: ' + what);
}

// Scelleur factice : il n'imite pas la sécurité — le vrai sera en Rust — mais
// il doit CACHER le texte, sinon les assertions ne vérifieraient rien.
const sealer = {
    seal: (t) => 'S:' + [...t].reverse().join(''),
    open: (t) => t.startsWith('S:') ? [...t.slice(2)].reverse().join('') : null,
};

const A = 1, B = -1;
const MATCH = 'match-0001-abcd';

// ── 1. Deux joueurs, deux clés ───────────────────────────────────────────────
console.log('Relai : chacun n’écrit que dans son fil');
{
    const alice = new RelayChatChannel({
        relayUrl: 'https://relai.test/fileio.php', matchId: MATCH, side: A,
        sealer, pollIntervalMs: 20,
    });
    const bob = new RelayChatChannel({
        relayUrl: 'https://relai.test/fileio.php', matchId: MATCH, side: B,
        sealer, pollIntervalMs: 20,
    });

    let seenByBob = [];
    bob.onConversation(conv => { seenByBob = conv; });
    await alice.start();
    await bob.start();

    await alice.send({ kind: ENVELOPE_KIND.CHAT, body: 'bonjour' });
    assert(writes.every(w => w === chatMidFor(MATCH, A)),
        'Alice n’a écrit que dans sa clé : ' + [...new Set(writes)].join(', '));
    assert(store.has(chatMidFor(MATCH, A)) && !store.has(chatMidFor(MATCH, B)),
        'et la clé de Bob n’a pas été touchée');

    // Ce que voit le serveur : rien de lisible.
    assert(!store.get(chatMidFor(MATCH, A)).includes('bonjour'),
        'le texte n’apparaît pas dans ce qui est déposé sur le relai');

    await waitFor(() => seenByBob.some(m => m.body === 'bonjour'), 'Bob reçoit le message');
    assert(true, 'Bob le lit dans le fil d’Alice');

    // Les deux écrivent « en même temps » : sur une clé commune, l’un des deux
    // messages serait perdu. Sur deux clés, il n’y a pas de concurrence.
    await Promise.all([
        alice.send({ kind: ENVELOPE_KIND.CHAT, body: 'moi d’abord' }),
        bob.send({ kind: ENVELOPE_KIND.CHAT, body: 'non, moi' }),
    ]);
    await waitFor(() => bob.conversation.length === 3, 'les trois messages arrivent chez Bob');
    assert(bob.conversation.length === 3, 'aucun message perdu malgré l’écriture simultanée');

    alice.stop(); bob.stop();
}

// ── 2. Une fenêtre rouverte ne s’efface pas elle-même ────────────────────────
console.log('');
console.log('Relai : relire son propre fil avant d’y écrire');
{
    // Le fil est déposé ENTIER à chaque message. Une fenêtre qui repartirait
    // d’une liste vide écraserait tout son historique dès le premier envoi.
    const again = new RelayChatChannel({
        relayUrl: 'https://relai.test/fileio.php', matchId: MATCH, side: A,
        sealer, pollIntervalMs: 20,
    });
    await again.start();
    assert(again.conversation.length === 2, 'au démarrage, Alice retrouve ses deux messages');

    await again.send({ kind: ENVELOPE_KIND.CHAT, body: 'et de trois' });
    const reread = await (async () => {
        const probe = new RelayChatChannel({
            relayUrl: 'https://relai.test/fileio.php', matchId: MATCH, side: A,
            sealer, pollIntervalMs: 20,
        });
        await probe.start(); probe.stop();
        return probe.conversation;
    })();
    assert(reread.length === 3, 'et son ancien fil n’a pas été écrasé');
    again.stop();
}

// ── 3. Sans clé, rien ne part en clair ───────────────────────────────────────
console.log('');
console.log('Relai : pas de clé, pas de texte libre');
{
    const naked = new RelayChatChannel({
        relayUrl: 'https://relai.test/fileio.php', matchId: 'nu-0001-abcd', side: A,
        pollIntervalMs: 20,          // aucun sealer
    });
    await naked.start();
    let failed = false;
    try { await naked.send({ kind: ENVELOPE_KIND.CHAT, body: 'secret' }); }
    catch { failed = true; }
    assert(failed, 'un message de discussion sans scelleur échoue plutôt que de partir en clair');
    assert(!store.has(chatMidFor('nu-0001-abcd', A)), 'et rien n’est déposé');
    // Le fil est déposé ENTIER à chaque message : un message refusé qui
    // resterait dans la liste serait réencodé à chaque envoi et les ferait
    // tous échouer ensuite, y compris ceux qui n’ont rien à se reprocher.
    assert(naked.conversation.length === 0, 'et le refus ne laisse aucune trace dans le fil');

    // La présence, elle, ne porte aucun texte : elle passe sans clé. C’est ce
    // qui permet de dire « je fais une pause » même discussion désactivée.
    await naked.send({ kind: ENVELOPE_KIND.PRESENCE, state: PRESENCE.PAUSED });
    assert(store.has(chatMidFor('nu-0001-abcd', A)), 'un état de présence passe sans clé');
    naked.stop();
}

// ── 4. Pair-à-pair : coups et messages sur le même fil ───────────────────────
console.log('');
console.log('Pair-à-pair : ne lire que ce qui nous concerne');
{
    const sent = [];
    let emit = null;
    const invoke = async (cmd, args) => { sent.push({ cmd, args }); };
    const listen = async (name, cb) => { if (name === 'tabulon-peer://message') emit = cb; return () => { emit = null; }; };

    const chan = new PeerChatChannel({ side: A, invokeImpl: invoke, listenImpl: listen });
    let conv = [];
    chan.onConversation(c => { conv = c; });
    await chan.start();

    // Un COUP passe par le même événement : il ne doit pas apparaître dans la
    // conversation.
    emit({ payload: encodeEnvelope({ nbTurns: 4 }) });
    assert(conv.length === 0, 'un coup n’entre pas dans la conversation');

    // Une enveloppe ancienne, sans `kind`, est un coup elle aussi.
    emit({ payload: JSON.stringify({ v: 1, nbTurns: 5 }) });
    assert(conv.length === 0, 'une enveloppe ancienne non plus');

    // Une ligne illisible ne casse rien.
    emit({ payload: 'pas du json' });
    assert(conv.length === 0, 'une ligne illisible est ignorée');

    // Un vrai message d’en face.
    emit({ payload: JSON.stringify({
        v: 1, kind: ENVELOPE_KIND.PRESENCE, side: B, at: 1000, id: 'aabbccdd', state: PRESENCE.PAUSED }) });
    await waitFor(() => conv.length === 1, 'le message de présence arrive');
    assert(conv[0].state === PRESENCE.PAUSED, 'et il dit que l’adversaire s’absente');

    // Un message mal formé (état inconnu) est refusé par la même porte que sur
    // le relai, plutôt que par une validation écrite à part.
    emit({ payload: JSON.stringify({
        v: 1, kind: ENVELOPE_KIND.PRESENCE, side: B, at: 2000, id: 'eeff', state: 'a-la-peche' }) });
    await sleep(20);
    assert(conv.length === 1, 'un état inconnu est ignoré');

    await chan.send({ kind: ENVELOPE_KIND.CHAT, body: 'salut' });
    assert(sent.some(s => s.cmd === 'peer_send'), 'un message part sur la session TCP');
    // Pas de scelleur ici, et c’est volontaire : rien ne transite par un
    // serveur, donc encodeThread n’est pas sur ce chemin.
    assert(chan.conversation.some(m => m.body === 'salut'), 'et s’affiche tout de suite chez nous');

    // Fermer la fenêtre de discussion ne doit PAS couper le lien par lequel
    // passent les coups.
    chan.stop();
    assert(!sent.some(s => s.cmd === 'peer_stop'), 'arrêter la discussion ne ferme pas la session de jeu');
}

// ── 5. On ne prévient que quand quelque chose a changé ───────────────────────
console.log('');
console.log('Pas de réveil pour rien');
{
    // Le fil d’en face est relu en entier à chaque sondage. Prévenir à chaque
    // tour ferait redessiner la fenêtre en boucle et clignoter une pastille de
    // « nouveau message » qui n’en est pas un.
    const quiet = new RelayChatChannel({
        relayUrl: 'https://relai.test/fileio.php', matchId: MATCH, side: B,
        sealer, pollIntervalMs: 10,
    });
    let calls = 0;
    quiet.onConversation(() => { calls++; });
    await quiet.start();
    await waitFor(() => calls > 0, 'première publication');
    const after = calls;
    await sleep(120);            // une douzaine de tours de sondage
    assert(calls === after, `rien de neuf, aucune notification de plus (${calls})`);
    quiet.stop();
}

// ── 6. Un message rapide traverse le canal sans clé ─────────────────────────
{
    // Il voyage comme identifiant : rien de personnel ne transite, donc rien à
    // sceller — et il fonctionne dans une partie qui n'a pas de clé, là où le
    // texte libre est refusé.
    const nokey = new RelayChatChannel({
        relayUrl: 'https://relai.test/fileio.php', matchId: 'rapide-0001', side: A,
        pollIntervalMs: 20,          // aucun sealer
    });
    await nokey.start();
    await nokey.send({ kind: ENVELOPE_KIND.CHAT, quick: 'wellPlayed' });
    const stored = JSON.parse(store.get(chatMidFor('rapide-0001', A)));
    assert(stored.msgs[0].quick === 'wellPlayed', 'un message rapide passe sans scelleur');
    assert(!('body' in stored.msgs[0]), 'et ne dépose aucun texte');
    nokey.stop();
}

console.log(`\n${passed} assertions OK — transport de la discussion validé.`);
process.exit(0);
