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
/*
 * Le relai en mémoire imite désormais `chatioaction` de fileio.php : c'est le
 * SERVEUR qui ajoute une ligne au fichier `<gameid>-chat.txt`, là où Tabulon
 * réécrivait deux fichiers entiers. La différence est le fond du
 * déménagement — plus de concurrence à éviter, donc plus de dispositif à deux
 * clés — et c'est ce que ce mock doit reproduire fidèlement.
 */
const chatLog = new Map();       // gameid -> [ligne, …] (le fichier -chat.txt)
let chatCap = null;              // plafond du fichier, comme $chatMaxBytes
async function mockFetch(url, init) {
    const params = new URLSearchParams(init.body);
    const chat = params.get('chatioaction');
    const gameid = params.get('gameid');
    if (chat === 'save') {
        const line = params.get('chatmsg');
        // Le vrai serveur plafonne le fichier ($chatMaxBytes) et REFUSE
        // au-delà, avec un 413. Ce n'est pas une panne réseau : réessayer n'y
        // changerait rien.
        const size = (chatLog.get(gameid) || []).join('\n').length;
        if (chatCap !== null && size + line.length > chatCap)
            return { status: 413, text: async () => '{"error":"chat log full"}' };
        // Le vrai serveur refuse (400) un message multiligne : il relit le
        // fichier ligne par ligne.
        if (/[\r\n]/.test(line)) return { status: 400, text: async () => 'single line' };
        writes.push(gameid);
        if (!chatLog.has(gameid)) chatLog.set(gameid, []);
        chatLog.get(gameid).push(line);
        return { status: 200, text: async () => '{"ok":true}' };
    }
    if (chat === 'load') {
        const lines = chatLog.get(gameid) || [];
        return { status: 200, text: async () => '{"messages":[' + lines.join(',') + ']}' };
    }
    const action = params.get('gameioaction');
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
const { ENVELOPE_KIND, PRESENCE } =
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

// ── 1. Un seul fil, partagé — et c'est le point du déménagement ─────────────
//
// Les deux joueurs écrivaient chacun dans SA clé, et chacun réécrivait son fil
// entier à chaque message : un fil de 200 messages coûtait 200 écritures de
// taille croissante. Le serveur AJOUTE désormais une ligne, sous la clé de la
// partie — celle que joclymatch emploie déjà. Plus de concurrence à éviter,
// donc plus de dispositif à deux clés.
console.log('Relai : un seul fil, que le serveur complète');
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
    assert(writes.every(w => w === MATCH),
        'tout part sous la clé de la partie : ' + [...new Set(writes)].join(', '));
    // Ce que voit le serveur : rien de lisible.
    assert(!(chatLog.get(MATCH) || []).join('').includes('bonjour'),
        'le texte n’apparaît pas dans ce qui est déposé sur le relai');

    await waitFor(() => seenByBob.some(m => m.body === 'bonjour'), 'Bob reçoit le message');
    assert(true, 'Bob le lit dans le fil commun');

    // Les deux écrivent « en même temps ». Sur une clé commune RÉÉCRITE, l'un
    // des deux messages serait perdu ; sur un fichier que le serveur complète,
    // il n'y a rien à perdre.
    await Promise.all([
        alice.send({ kind: ENVELOPE_KIND.CHAT, body: 'moi d’abord' }),
        bob.send({ kind: ENVELOPE_KIND.CHAT, body: 'non, moi' }),
    ]);
    await waitFor(() => bob.conversation.length === 3, 'les trois messages arrivent chez Bob');
    assert(bob.conversation.length === 3, 'aucun message perdu malgré l’écriture simultanée');
    // Un message écrit ET relu ne doit apparaître qu'une fois : c'est
    // l'identifiant partagé « horodatage-aléa » qui le garantit.
    assert(new Set(alice.conversation.map(m => m.id)).size === alice.conversation.length,
        'et aucun doublon, le fil étant relu en entier à chaque sondage');

    alice.stop(); bob.stop();
}

// ── 2. Une fenêtre rouverte retrouve le fil ────────────────────────────────
//
// Elle devait auparavant relire son propre fil AVANT d'écrire, sous peine
// d'écraser son historique au premier message — le fil étant déposé en entier.
// Le serveur complétant le fichier, cette précaution n'a plus d'objet : il n'y
// a plus rien à écraser, et le premier sondage rapporte tout.
console.log('');
console.log('Relai : rouvrir ne perd rien');
{
    const again = new RelayChatChannel({
        relayUrl: 'https://relai.test/fileio.php', matchId: MATCH, side: A,
        sealer, pollIntervalMs: 20,
    });
    await again.start();
    await waitFor(() => again.conversation.length === 3, 'le fil revient au premier sondage');
    assert(again.conversation.length === 3, 'les trois messages sont là');

    await again.send({ kind: ENVELOPE_KIND.CHAT, body: 'et de quatre' });
    await waitFor(() => again.conversation.length === 4, 'le nouveau message s’ajoute');
    assert((chatLog.get(MATCH) || []).length === 4,
        'et le fichier compte quatre lignes, pas un fil réécrit');
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
    assert(!chatLog.has('nu-0001-abcd'), 'et rien n’est déposé');
    assert(naked.conversation.length === 0, 'et le refus ne laisse aucune trace dans le fil');

    // La présence, elle, ne porte aucun texte : elle passe sans clé. C’est ce
    // qui permet de dire « je fais une pause » à un joueur joclymatch.
    await naked.send({ kind: ENVELOPE_KIND.PRESENCE, state: PRESENCE.PAUSED });
    assert(chatLog.has('nu-0001-abcd'), 'un état de présence passe sans clé');

    /*
     * LE RÉGIME CLAIR EST UNE PERMISSION EXPLICITE, PAS UNE CONSÉQUENCE.
     *
     * Sans scelleur, le refus ci-dessus est le comportement voulu : une partie
     * créée par Tabulon porte une clé, et un scelleur manquant signale une
     * panne — clé abîmée, commande Rust indisponible. Le laisser valoir
     * permission d'écrire en clair serait exactement le chemin par lequel une
     * protection se perd sans que personne l'ait décidé.
     *
     * Une partie rejointe par un lien joclymatch, elle, n'a AUCUNE clé : le
     * clair y est le seul régime possible, et c'est celui que l'autre joueur
     * attend. L'appelant le dit, et seulement dans ce cas.
     */
    const open = new RelayChatChannel({
        relayUrl: 'https://relai.test/fileio.php', matchId: 'clair-0001', side: A,
        allowClear: true, pollIntervalMs: 20,
    });
    await open.start();
    await open.send({ kind: ENVELOPE_KIND.CHAT, body: 'bonjour joclymatch' });
    assert((chatLog.get('clair-0001') || []).join('').includes('bonjour joclymatch'),
        'régime clair assumé : le texte part, lisible, comme joclymatch l’attend');
    await waitFor(() => open.conversation.some(m => m.body === 'bonjour joclymatch'),
        'et se relit sans cadenas');
    assert(open.conversation.every(m => !m.locked), 'aucun message verrouillé en régime clair');
    open.stop();
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

    await chan.send({ kind: ENVELOPE_KIND.CHAT, quick: 'goodGame' });
    assert(sent.some(s => s.cmd === 'peer_send'), 'un message part sur la session TCP');
    assert(chan.conversation.some(m => m.quick === 'goodGame'), 'et s’affiche tout de suite chez nous');

    // Fermer la fenêtre de discussion ne doit PAS couper le lien par lequel
    // passent les coups.
    chan.stop();
    assert(!sent.some(s => s.cmd === 'peer_stop'), 'arrêter la discussion ne ferme pas la session de jeu');
}

// ── 4 bis. Pair-à-pair : le texte libre doit ARRIVER ─────────────────────────
//
// LA RÉGRESSION QUE CE FICHIER LAISSAIT PASSER. Les assertions ci-dessus ne
// regardaient que l'expéditeur, qui voit toujours son propre message : le
// trajet A -> B n'était vérifié pour aucun texte libre. Or PeerChatChannel
// envoyait le corps tel quel, sans le marqueur `enc` que decodeThread exige --
// donc en face, « message envoyé sans protection — non affiché », clé ou pas.
// La conversation pair-à-pair était inutilisable là où le relai marchait.
//
// On branche ici les deux canaux l'un sur l'autre, ce qui est la seule façon
// de le voir : le fil TCP est symétrique, chacun lit littéralement ce que
// l'autre a écrit.
console.log('');
console.log('Pair-à-pair : un message scellé traverse le fil');
{
    const wire = [];                      // ce qui passe VRAIMENT sur le TCP
    const listeners = [];
    const invoke = async (cmd, args) => {
        if (cmd !== 'peer_send') return;
        wire.push(args.line);
        listeners.forEach(cb => cb({ payload: args.line }));
    };
    const listen = async (name, cb) => {
        if (name !== 'tabulon-peer://message') return () => {};
        listeners.push(cb);
        return () => { listeners.splice(listeners.indexOf(cb), 1); };
    };

    const alice = new PeerChatChannel({ side: A, sealer, invokeImpl: invoke, listenImpl: listen });
    const bob   = new PeerChatChannel({ side: B, sealer, invokeImpl: invoke, listenImpl: listen });
    await alice.start();
    await bob.start();

    await alice.send({ kind: ENVELOPE_KIND.CHAT, body: 'à toi de jouer' });
    await waitFor(() => bob.conversation.length === 1, 'Bob reçoit le message');
    const received = bob.conversation[0];
    assert(received.body === 'à toi de jouer', 'Bob lit le texte, et non un cadenas');
    assert(!received.locked, 'le message n’arrive pas marqué « envoyé sans protection »');

    // Ce qui circule ne doit pas être le texte : le fil TCP n'a pas de TLS, et
    // passe par autant de machines qu'un autre dès qu'il traverse Internet.
    assert(!wire.some(l => l.includes('à toi de jouer')),
        'et le texte n’apparaît pas en clair sur le fil');

    // Un message rapide n'est qu'un identifiant : rien à sceller, et il doit
    // rester lisible tel quel.
    await bob.send({ kind: ENVELOPE_KIND.CHAT, quick: 'goodGame' });
    await waitFor(() => alice.conversation.length === 2, 'le message rapide arrive');
    assert(alice.conversation.some(m => m.quick === 'goodGame'),
        'un message rapide traverse sans scellement');

    alice.stop(); bob.stop();
}

// ── 4 ter. Pair-à-pair sans clé : pas de texte libre non plus ────────────────
console.log('');
console.log('Pair-à-pair : pas de clé, pas de texte libre');
{
    const sent = [];
    const invoke = async (cmd, args) => { sent.push({ cmd, args }); };
    const listen = async () => () => {};
    const naked = new PeerChatChannel({ side: A, invokeImpl: invoke, listenImpl: listen });
    await naked.start();

    let failed = false;
    try { await naked.send({ kind: ENVELOPE_KIND.CHAT, body: 'secret' }); }
    catch { failed = true; }
    // Même règle que sur le relai, et pour une raison plus forte encore : sans
    // scelleur le message partirait en clair ET arriverait illisible. Échouer
    // ici est la seule issue honnête -- play.js ferme d'ailleurs la saisie.
    assert(failed, 'un texte libre sans scelleur échoue plutôt que de partir tel quel');
    assert(!sent.some(s => s.cmd === 'peer_send'), 'et rien n’est envoyé');
    assert(naked.conversation.length === 0, 'ni retenu dans notre propre fil');

    // La présence, elle, ne porte aucun texte : elle passe sans clé.
    await naked.send({ kind: ENVELOPE_KIND.PRESENCE, state: PRESENCE.PAUSED });
    assert(sent.some(s => s.cmd === 'peer_send'), 'un état de présence passe sans clé');
    naked.stop();
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
    const line = JSON.parse((chatLog.get('rapide-0001') || [])[0]);
    assert(line.data.quick === 'wellPlayed', 'un message rapide passe sans scelleur');
    // `msg` vide et non absent : joclymatch ignore une ligne sans `msg`, et
    // c'est ainsi qu'un message rapide y reste invisible au lieu d'y afficher
    // « undefined ».
    assert(line.data.msg === '', 'et ne dépose aucun texte');
    // Le camp voyage sous le nom de joclymatch, avec les mêmes valeurs : c'est
    // le seul endroit où les deux formats se rejoignaient déjà.
    assert(line.data.player === A, 'le camp s’écrit `player`, aux mêmes valeurs');
    nokey.stop();
}

// ── 7. Le fil plein est un ÉTAT, pas une panne ─────────────────────────────
//
// fileio.php plafonne le fichier de conversation par partie et refuse au-delà.
// Cela arrive à deux joueurs bavards sur une partie par correspondance, et
// c'est définitif : réessayer n'y changerait rien.
//
// Le plafond est désormais PARTAGÉ — un seul fichier pour les deux joueurs, là
// où chacun avait le sien. Le traiter comme une erreur réseau ferait retaper le
// même message indéfiniment.
console.log('');
console.log('Relai : le fil plein');
{
    chatCap = 400;              // quelques messages, pas plus
    const chan = new RelayChatChannel({
        relayUrl: 'https://relai.test/fileio.php', matchId: 'plein-0001', side: A,
        allowClear: true, pollIntervalMs: 20,
    });
    await chan.start();
    await chan.send({ kind: ENVELOPE_KIND.CHAT, body: 'premier' });
    await waitFor(() => chan.conversation.length === 1, 'le premier message passe');
    assert(!chan.full, 'et le fil n’est pas encore plein');

    let code = null;
    for (let k = 0; k < 12 && !code; k++)
        try { await chan.send({ kind: ENVELOPE_KIND.CHAT, body: 'message numéro ' + k }); }
        catch (e) { code = e.code; }

    assert(code === 'chat-full', 'le refus porte un code nommé : ' + code);
    assert(chan.full, 'et le canal retient l’état');

    /*
     * LE MESSAGE REFUSÉ NE DOIT PAS RESTER AFFICHÉ. Il est ajouté localement
     * avant l'envoi, pour s'afficher sans attendre l'aller-retour ; le laisser
     * après un refus serait un mensonge — l'autre joueur ne le verra jamais, et
     * rien à l'écran ne le dirait.
     */
    await waitFor(() => chan.conversation.length === (chatLog.get('plein-0001') || []).length,
        'le fil affiché rejoint le fil déposé');
    assert(chan.conversation.length === (chatLog.get('plein-0001') || []).length,
        `rien d’affiché qui ne soit sur le relai (${chan.conversation.length} = ${(chatLog.get('plein-0001') || []).length})`);

    // ET LA LECTURE CONTINUE : un fil plein reste lisible. Couper la
    // conversation entière parce qu'on ne peut plus y ajouter serait
    // disproportionné.
    const before = chan.conversation.length;
    chatCap = null;
    chatLog.get('plein-0001').push(JSON.stringify({ data: {
        msg: 'venu d’en face', player: B, time: Date.now(), key: 'zz' } }));
    await waitFor(() => chan.conversation.length > before, 'un message d’en face arrive encore');
    assert(chan.conversation.some(m => m.body === 'venu d’en face'), 'et s’affiche');
    chan.stop();
    chatCap = null;
}

// ── Bascule explicite en clair ───────────────────────────────────────────────
//
// LE CAS : une partie creee par Tabulon porte une cle, mais son lien pointe
// vers index.php et peut donc etre ouvert dans joclymatch, qui ignore le
// fragment et ecrit en clair. Sans bascule, la conversation est a sens unique
// des deux cotes -- ses messages « non montres » chez nous, les notres
// illisibles chez lui.
{
    const sealer = {
        seal: (t) => 'S:' + t,
        open: (s) => (String(s).startsWith('S:') ? String(s).slice(2) : null),
    };
    const mid = 'bascule-0001';
    const chan = new RelayChatChannel({
        relayUrl: 'http://relai/fileio.php', matchId: mid, side: A,
        sealer, pollIntervalMs: 20, fetchImpl: mockFetch,
    });
    await chan.start();

    // Le correspondant ecrit en clair : refuse, mais VISIBLE.
    chatLog.set(mid, [JSON.stringify({ data: {
        msg: 'bonjour en clair', player: B, time: Date.now(), key: 'cc' } })]);
    await waitFor(() => chan.conversation.length > 0, 'le message en clair arrive');
    const avant = chan.conversation.find(m => m.side === B);
    assert(avant.locked === true && avant.reason === 'unsealed',
        'avant la bascule : garde, marque « sans protection », corps masque');
    assert(avant.body === null, 'et son texte n’est pas affiche');
    assert(chan.sealing === true, 'ce qui part est encore scelle');

    // L'utilisateur accepte.
    chan.allowClearFrom();
    await waitFor(() => chan.conversation.some(m => m.body === 'bonjour en clair'),
        'apres la bascule : le message devient lisible');
    assert(chan.sealing === false, 'et ce qui part ne l’est plus');

    // Ce qui a deja ete dit sous protection reste lisible : le scelleur n'est
    // pas jete, il ne sert plus qu'a ouvrir.
    chatLog.get(mid).push(JSON.stringify({ data: {
        msg: 'S:dit avant la bascule', player: B, time: Date.now() + 1, key: 'dd', enc: 1 } }));
    await waitFor(() => chan.conversation.some(m => m.body === 'dit avant la bascule'),
        'un message scelle reste ouvrable apres la bascule');

    // Et le texte libre part desormais en clair, donc lisible par l'autre.
    await chan.send({ kind: 'chat', body: 'et voila' });
    const depose = JSON.parse(chatLog.get(mid).at(-1)).data;
    assert(depose.msg === 'et voila', 'le texte libre part en clair');
    assert(depose.enc === undefined, 'et sans marqueur de scellement');
    chan.stop();
}

console.log(`\n${passed} assertions OK — transport de la discussion validé.`);
process.exit(0);
