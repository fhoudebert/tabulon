// test-remote-takeback.mjs — reprise de coup en partie à distance : le
// réglage de la partie (lien, fichier, code pair-à-pair) et la détection
// d'une annulation adverse, sur les deux canaux.
//
// CE QUI SE VÉRIFIE ICI, dans l'ordre où ça casserait :
//   1. le réglage traverse le lien (tb=0/1) et se relit, absence comprise ;
//   2. les DEUX codecs le recopient à chaque écriture — sans quoi la
//      première sauvegarde de l'un efface le choix de l'hôte ;
//   3. une BAISSE de nbTurns est une annulation, jamais un coup ;
//   4. le fichier fait foi sur le lien ;
//   5. une lecture partie avant notre écriture et revenue après n'est pas
//      prise pour un coup adverse (elle rejouerait le coup qu'on annule).
//
// Usage : node tests/test-remote-takeback.mjs   (depuis tabulon/)

// ── Relai en mémoire (même règles que fileio.php) ────────────────────────────
const relay = new Map();
let loadGate = null;   // si posé : les « load » attendent cette promesse
async function mockFetch(_url, init) {
    const params = new URLSearchParams(init.body);
    const action = params.get('gameioaction');
    const gameid = params.get('gameid');
    if (action === 'save') {
        relay.set(gameid, params.get('gamedata'));
        return { status: 200, text: async () => 'ok' };
    }
    if (action === 'load') {
        // Le contenu est lu AU MOMENT de la requête, comme un vrai serveur ;
        // seule la RÉPONSE peut être retardée.
        const text = relay.get(gameid) ?? '';
        if (loadGate) await loadGate;
        return { status: 200, text: async () => text };
    }
    return { status: 400, text: async () => '' };
}
globalThis.window = { __TAURI__: { http: { fetch: mockFetch } } };

const {
    encodeEnvelope, decodeEnvelope, hasOpponentMoved, hasOpponentTakenBack, resolveAllowTakeback,
    remoteTakebackBlock,
    encodeJoclySimpleMatchEnvelope, decodeJoclySimpleMatchEnvelope,
    parseInvitationUrl, buildInvitationUrl,
} = await import('../app/content/remote-relay-protocol.js');
const { encodePeerCode, decodePeerCode } = await import('../app/content/remote-peer-protocol.js');
const { HttpRelayChannel } = await import('../app/content/remote-channel.js');
const { PeerChannel } = await import('../app/content/remote-peer-channel.js');

let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RELAY = 'https://biscandine.fr/variantes/joclymatch/fileio.php';

// ── 1. Le lien ───────────────────────────────────────────────────────────────
{
    const on  = buildInvitationUrl({ relayUrl: RELAY, gameName: 'go19', matchId: 'm-1', player: 'b', allowTakeback: true });
    const off = buildInvitationUrl({ relayUrl: RELAY, gameName: 'go19', matchId: 'm-1', player: 'b', allowTakeback: false });
    const old = buildInvitationUrl({ relayUrl: RELAY, gameName: 'go19', matchId: 'm-1', player: 'b' });
    assert(new URL(on).searchParams.get('tb') === '1', 'autorisée : tb=1 écrit explicitement');
    assert(new URL(off).searchParams.get('tb') === '0', 'interdite : tb=0 écrit explicitement');
    assert(!new URL(old).searchParams.has('tb'), 'sans réglage fourni, le lien reste celui d’avant');
    assert(parseInvitationUrl(on).allowTakeback === true, 'tb=1 se relit true');
    assert(parseInvitationUrl(off).allowTakeback === false, 'tb=0 se relit false');
    assert(parseInvitationUrl(old).allowTakeback === null, 'absence -> null (« le lien ne dit rien »)');
    assert(parseInvitationUrl(on.replace('tb=1', 'tb=oui')).allowTakeback === null, 'valeur abîmée -> null');
    // Lien sans `tb` : « le lien ne dit rien », quelle que soit la page qui
    // l'a émis (joclymatch index.php, mogichex index.html ou répertoire nu).
    // La page n'est plus un indice : joclymatch et mogichex appliquent tous
    // deux « absent = interdit ».
    const q = '?game=go19&mid=1784023862731-pIUWbcgh0yDFVT&player=b';
    for (const url of ['https://biscandine.fr/variantes/mogichex/index.html' + q,
                       'https://biscandine.fr/variantes/mogichex/' + q,
                       'https://biscandine.fr/variantes/joclymatch/INDEX.PHP' + q]) {
        assert(parseInvitationUrl(url).allowTakeback === null, 'lien sans tb -> null : ' + new URL(url).pathname);
    }
    assert(parseInvitationUrl('https://biscandine.fr/variantes/mogichex/index.html' + q + '&tb=1').allowTakeback === true,
        'lien AVEC tb=1 -> le lien fait foi');
    // La clé reste dans le fragment, le réglage dans la requête.
    const withKey = buildInvitationUrl({ relayUrl: RELAY, gameName: 'go19', matchId: 'm-1', player: 'b',
        chatKey: 'c'.repeat(64), allowTakeback: false });
    const u = new URL(withKey);
    assert(u.searchParams.get('tb') === '0' && u.hash === '#k=' + 'c'.repeat(64),
        'tb dans la requête (le serveur doit le lire), la clé dans le fragment (il ne doit pas)');
}

// ── 2. Les deux codecs recopient le réglage ─────────────────────────────────
{
    const jsm = encodeJoclySimpleMatchEnvelope({ matchId: 'm', gameName: 'go', nbTurns: 3, matchdata: {}, allowTakeback: false });
    assert(JSON.parse(jsm).matchDetails.allowTakeback === false, 'jocly-simple-match : écrit dans matchDetails');
    assert(decodeJoclySimpleMatchEnvelope(jsm).allowTakeback === false, 'jocly-simple-match : relu');
    const jsmNone = encodeJoclySimpleMatchEnvelope({ matchId: 'm', gameName: 'go', nbTurns: 3, matchdata: {} });
    assert(!('allowTakeback' in JSON.parse(jsmNone).matchDetails), 'inconnu : champ omis, pas écrit à false');
    assert(decodeJoclySimpleMatchEnvelope(jsmNone).allowTakeback === null, 'fichier ancien : relu null');

    const tab = encodeEnvelope({ nbTurns: 2, allowTakeback: true });
    assert(decodeEnvelope(tab).allowTakeback === true, 'enveloppe tabulon : écrit puis relu');
    assert(decodeEnvelope(encodeEnvelope({ nbTurns: 2 })).allowTakeback === null, 'enveloppe tabulon ancienne : null');
}

// ── 3. Une baisse est une annulation, jamais un coup ────────────────────────
assert(hasOpponentTakenBack(5, { nbTurns: 4 }) === true, 'baisse -> annulation');
assert(hasOpponentTakenBack(5, { nbTurns: 0 }) === true, 'retour à zéro -> annulation (recommencer)');
assert(hasOpponentTakenBack(4, { nbTurns: 5 }) === false, 'hausse -> pas une annulation');
assert(hasOpponentTakenBack(4, { nbTurns: 4 }) === false, 'égalité -> rien');
assert(hasOpponentTakenBack(4, null) === false, 'rien au relai -> rien');
assert(hasOpponentTakenBack(4, { kind: 'chat', nbTurns: 0 }) === false, 'un message de discussion n’est pas une annulation');
assert(hasOpponentMoved(5, { nbTurns: 4 }) === false, 'et une baisse n’est toujours pas un coup');

// ── 4. Le fichier fait foi ───────────────────────────────────────────────────
assert(resolveAllowTakeback(false, true) === false, 'fichier false l’emporte sur lien true');
assert(resolveAllowTakeback(true, false) === true, 'fichier true l’emporte sur lien false');
assert(resolveAllowTakeback(null, false) === false && resolveAllowTakeback(null, true) === true, 'fichier muet : le lien');
assert(resolveAllowTakeback(null, null) === false, 'personne ne dit rien : INTERDITE (règle commune joclymatch / mogichex)');

// ── 4b. Quand « Reculer » est permis à distance ─────────────────────────────
{
    const ok = { remote: true, allowed: true, localTurn: true, playedMoves: 2 };
    assert(remoteTakebackBlock({ ...ok, remote: false, allowed: false, localTurn: false, playedMoves: 0 }) === null,
        'partie locale : aucune restriction de ce côté');
    assert(remoteTakebackBlock(ok) === null, 'autorisée, notre tour, deux coups : permis');
    assert(remoteTakebackBlock({ ...ok, allowed: false }) === 'play.remoteTakebackForbidden', 'interdite par la partie');
    assert(remoteTakebackBlock({ ...ok, localTurn: false }) === 'play.remoteTakebackNotYourTurn', 'pas notre tour');
    // B à son premier tour : le seul coup joué est celui de A. Reculer
    // défaisait LE COUP ADVERSE et lui rendait la main.
    assert(remoteTakebackBlock({ ...ok, playedMoves: 1 }) === 'play.remoteTakebackNothingYet',
        'un seul coup joué (celui de l’adversaire) : rien à nous');
    assert(remoteTakebackBlock({ ...ok, allowed: false, playedMoves: 1 }) === 'play.remoteTakebackForbidden',
        'le motif le plus durable est donné en premier');
}

// ── 5. Le code pair-à-pair ───────────────────────────────────────────────────
{
    const base = { gameName: 'go19', ips: ['1.2.3.4'], port: 7777, token: 'ab'.repeat(16) };
    assert(decodePeerCode(encodePeerCode({ ...base, allowTakeback: true })).allowTakeback === true, 'code : true relu');
    assert(decodePeerCode(encodePeerCode({ ...base, allowTakeback: false })).allowTakeback === false, 'code : false relu');
    assert(decodePeerCode(encodePeerCode(base)).allowTakeback === null, 'code d’avant le réglage : null');
}

// ── 6. HttpRelayChannel : annulation, réglage, lecture périmée ──────────────
{
    const matchId = 'reprise-1';
    // Un joueur joclymatch vient d'annuler : le fichier porte 2 coups, nous 3.
    relay.set(matchId, JSON.stringify({
        matchDetails: { matchId, gameName: 'classic-chess', nbTurns: 2, a: { pseudo: '' }, b: { pseudo: '' },
            allowTakeback: true },
        matchdata: { playedMoves: [{ to: 'e4' }, { to: 'e5' }], board: 'après 1.e4 e5' },
        time: 0, key: 'x',
    }));
    const chan = new HttpRelayChannel({ relayUrl: RELAY, matchId, localNbTurns: 3, pollIntervalMs: 15,
        codec: 'jocly-simple-match', gameName: 'classic-chess', allowTakeback: false });
    assert(chan.allowTakeback === false, 'avant le premier sondage : ce que dit le lien');
    let moved = 0, takenBack = null, settings = null;
    chan.onRemoteMove(() => { moved++; });
    chan.onRemoteTakeback(p => { takenBack = p; });
    chan.onSettingsChange(s => { settings = s; });
    await chan.start();
    await sleep(60);
    assert(takenBack?.nbTurns === 2 && takenBack.state.board === 'après 1.e4 e5',
        'la baisse arrive à onRemoteTakeback, avec l’état complet à charger');
    assert(moved === 0, 'et JAMAIS à onRemoteMove (ce qui rejouerait un coup)');
    assert(chan.allowTakeback === true && settings?.allowTakeback === true,
        'le fichier fait foi : le réglage suit le fichier et le changement est signalé');

    // Notre propre écriture recopie le réglage tel que le fichier le porte.
    await chan.push({ nbTurns: 3, state: { playedMoves: [1, 2, 3] } });
    assert(JSON.parse(relay.get(matchId)).matchDetails.allowTakeback === true,
        'le réglage SURVIT à notre sauvegarde (matchDetails n’est plus reconstruit à nu)');
    chan.stop();
}
{
    // LA COURSE : un sondage lit le fichier à 4 coups, puis nous reprenons
    // (push à 2), puis la réponse du sondage revient. Sans garde, 4 > 2 est
    // pris pour un coup adverse -- celui qu'on vient d'annuler.
    const matchId = 'reprise-course';
    const chan = new HttpRelayChannel({ relayUrl: RELAY, matchId, localNbTurns: 4, pollIntervalMs: 10,
        codec: 'jocly-simple-match', gameName: 'classic-chess', allowTakeback: true });
    await chan.push({ nbTurns: 4, state: { playedMoves: [1, 2, 3, 4] } });
    let release;
    loadGate = new Promise(r => { release = r; });
    let moved = 0;
    chan.onRemoteMove(() => { moved++; });
    await chan.start();
    await sleep(20);                       // un sondage est en vol, il a lu « 4 »
    loadGate = null;
    await chan.push({ nbTurns: 2, state: { playedMoves: [1, 2] } });   // notre reprise
    release();                             // la vieille réponse revient
    await sleep(60);
    chan.stop();
    assert(moved === 0, 'une lecture partie avant notre reprise est jetée, pas prise pour un coup');
    assert(JSON.parse(relay.get(matchId)).matchDetails.nbTurns === 2, 'et le fichier porte bien la reprise');
}
{
    // Personne ne dit rien : interdite, quel que soit le codec (joclymatch
    // compris depuis qu'il applique la même règle).
    const a = new HttpRelayChannel({ relayUrl: RELAY, matchId: 'x', codec: 'jocly-simple-match', gameName: 'go' });
    assert(a.allowTakeback === false, 'relai joclymatch, par défaut : interdite');
    const b = new HttpRelayChannel({ relayUrl: RELAY, matchId: 'x', allowTakeback: true });
    assert(b.allowTakeback === true, 'le lien l’ouvre tant que le fichier ne dit rien');
}

// ── 7. PeerChannel : même aiguillage ─────────────────────────────────────────
{
    const handlers = {};
    const sent = [];
    const chan = new PeerChannel({
        localNbTurns: 6,
        invokeImpl: async (cmd, args) => { if (cmd === 'peer_send') sent.push(args.line); return null; },
        listenImpl: async (name, fn) => { handlers[name] = fn; return () => {}; },
        allowTakeback: true,
    });
    assert(new PeerChannel({ invokeImpl: async () => null, listenImpl: async () => () => {} }).allowTakeback === false,
        'pair-à-pair, par défaut : interdite');
    let moved = 0, takenBack = null;
    chan.onRemoteMove(() => { moved++; });
    chan.onRemoteTakeback(p => { takenBack = p; });
    await chan.start();
    handlers['tabulon-peer://message']({ payload: encodeEnvelope({ nbTurns: 4, state: { s: 4 } }) });
    assert(takenBack?.nbTurns === 4 && moved === 0, 'une baisse reçue en pair-à-pair est une annulation');
    await chan.push({ nbTurns: 5, state: {} });
    assert(JSON.parse(sent.at(-1)).allowTakeback === true, 'le réglage part avec chaque enveloppe');
}

console.log(`\n${passed} assertions passées.`);
