// test-remote-peer-channel.mjs — PeerChannel (remote-peer-channel.js) contre
// un "Rust" mocké en mémoire : deux sessions pontées (ce que peer_send de
// l'une émet arrive comme event tabulon-peer://message de l'autre), avec le
// même comportement de rattrapage (peer_last_message) que peer_cmds.rs.
// Le transport TCP réel est testé de son côté par `cargo test`
// (src-tauri/src/commands/peer_cmds.rs) — ici on valide la couche JS :
// interface RemoteChannel, filtre nbTurns, rattrapage, arrêt propre.
//
// Usage : node tests/test-remote-peer-channel.mjs

// ── Mock : deux extrémités pontées ───────────────────────────────────────────
// makeEndpoint(name) -> {invokeImpl, listenImpl, ...} ; bridge(a, b) relie les
// deux (send de a => message chez b, et inversement).
function makeEndpoint() {
    const ep = {
        listeners: new Map(),           // eventName -> Set<cb>
        lastMessage: null,
        peer: null,                     // l'autre extrémité, posée par bridge()
        stopped: 0,
        emitLocal(event, payload) {
            for (const cb of ep.listeners.get(event) ?? []) cb({ payload });
        },
        receiveLine(line) {             // ce que ferait le forwarder Rust
            ep.lastMessage = line;
            ep.emitLocal('tabulon-peer://message', line);
        },
        async invokeImpl(cmd, args) {
            if (cmd === 'peer_send') {
                if (!ep.peer) throw new Error('aucune session pair-a-pair active');
                ep.peer.receiveLine(args.line);
                return null;
            }
            if (cmd === 'peer_last_message') return ep.lastMessage;
            if (cmd === 'peer_stop') { ep.stopped++; return null; }
            throw new Error('commande inattendue: ' + cmd);
        },
        async listenImpl(event, cb) {
            if (!ep.listeners.has(event)) ep.listeners.set(event, new Set());
            ep.listeners.get(event).add(cb);
            return () => ep.listeners.get(event).delete(cb);
        },
    };
    return ep;
}
function bridge(a, b) { a.peer = b; b.peer = a; }

// window.__TAURI__ minimal : remote-channel.js importe tauri-bridge (accès
// paresseux), il suffit que l'objet existe.
globalThis.window = { __TAURI__: {} };

const { PeerChannel, hostPeerMatch } = await import('../app/content/remote-peer-channel.js');
const { decodePeerCode } = await import('../app/content/remote-peer-protocol.js');
const { RemoteChannel } = await import('../app/content/remote-channel.js');
const { encodeEnvelope } = await import('../app/content/remote-relay-protocol.js');

let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 1. Interface + échange nominal dans les deux sens ───────────────────────
{
    const epA = makeEndpoint(), epB = makeEndpoint();
    bridge(epA, epB);
    const chanA = new PeerChannel({ invokeImpl: epA.invokeImpl, listenImpl: epA.listenImpl });
    const chanB = new PeerChannel({ invokeImpl: epB.invokeImpl, listenImpl: epB.listenImpl });
    assert(chanA instanceof RemoteChannel, 'PeerChannel implémente RemoteChannel');

    const gotB = [], gotA = [];
    chanA.onRemoteMove(p => gotA.push(p));
    chanB.onRemoteMove(p => gotB.push(p));
    await chanA.start();
    await chanB.start();

    await chanA.push({ nbTurns: 1, lastMove: 'e2e4', state: { fake: 1 } });
    await sleep(5);
    assert(gotB.length === 1 && gotB[0].nbTurns === 1 && gotB[0].lastMove === 'e2e4',
        'coup A -> B reçu avec nbTurns et lastMove');
    assert(gotB[0].state?.fake === 1, 'state transporté intact');

    await chanB.push({ nbTurns: 2, lastMove: 'e7e5' });
    await sleep(5);
    assert(gotA.length === 1 && gotA[0].nbTurns === 2 && gotA[0].lastMove === 'e7e5',
        'coup B -> A reçu');
    assert(gotB.length === 1, 'A n\'a pas reçu en écho son propre coup');
    chanA.stop(); chanB.stop();
}

// ── 2. Filtre nbTurns : pas de re-signalement, pas de coups anciens ─────────
{
    const epA = makeEndpoint(), epB = makeEndpoint();
    bridge(epA, epB);
    const chanB = new PeerChannel({ localNbTurns: 3, invokeImpl: epB.invokeImpl, listenImpl: epB.listenImpl });
    const got = [];
    chanB.onRemoteMove(p => got.push(p));
    await chanB.start();

    epB.receiveLine(encodeEnvelope({ nbTurns: 3, lastMove: 'vieux' }));   // déjà connu
    epB.receiveLine(encodeEnvelope({ nbTurns: 2, lastMove: 'plus vieux' }));
    await sleep(5);
    assert(got.length === 0, 'nbTurns <= baseline ignoré');

    epB.receiveLine(encodeEnvelope({ nbTurns: 4, lastMove: 'nouveau' }));
    epB.receiveLine(encodeEnvelope({ nbTurns: 4, lastMove: 'nouveau' }));  // doublon (event + rattrapage)
    await sleep(5);
    assert(got.length === 1 && got[0].lastMove === 'nouveau', 'nouveau coup signalé UNE fois malgré le doublon');

    chanB.resetBaseline(10);
    epB.receiveLine(encodeEnvelope({ nbTurns: 5, lastMove: 'périmé après reset' }));
    await sleep(5);
    assert(got.length === 1, 'resetBaseline recale bien la référence');
    chanB.stop();
}

// ── 3. Rattrapage : coup arrivé AVANT l'abonnement (peer_last_message) ──────
{
    const epA = makeEndpoint(), epB = makeEndpoint();
    bridge(epA, epB);
    // le pair envoie pendant que "la fenêtre de jeu n'existe pas encore"
    epB.receiveLine(encodeEnvelope({ nbTurns: 1, lastMove: 'premier coup' }));
    const chanB = new PeerChannel({ invokeImpl: epB.invokeImpl, listenImpl: epB.listenImpl });
    const got = [];
    chanB.onRemoteMove(p => got.push(p));
    await chanB.start();
    await sleep(5);
    assert(got.length === 1 && got[0].lastMove === 'premier coup',
        'coup reçu avant start() rattrapé via peer_last_message');
    chanB.stop();
}

// ── 4. Messages illisibles ignorés sans casser le canal ─────────────────────
{
    const ep = makeEndpoint();
    ep.peer = ep; // pas besoin de pont ici
    const chan = new PeerChannel({ invokeImpl: ep.invokeImpl, listenImpl: ep.listenImpl });
    const got = [];
    chan.onRemoteMove(p => got.push(p));
    await chan.start();
    ep.receiveLine('pas du JSON');
    ep.receiveLine('{"autre":"forme"}');
    ep.receiveLine(encodeEnvelope({ nbTurns: 1, lastMove: 'ok' }));
    await sleep(5);
    assert(got.length === 1 && got[0].lastMove === 'ok', 'contenus illisibles ignorés, le canal survit');
    chan.stop();
}

// ── 5. stop() : désabonne et termine la session Rust ─────────────────────────
{
    const ep = makeEndpoint();
    ep.peer = ep;
    const chan = new PeerChannel({ invokeImpl: ep.invokeImpl, listenImpl: ep.listenImpl });
    const got = [];
    chan.onRemoteMove(p => got.push(p));
    await chan.start();
    chan.stop();
    await sleep(5);
    assert(ep.stopped === 1, 'stop() appelle peer_stop (libération de la session TCP)');
    ep.receiveLine(encodeEnvelope({ nbTurns: 1, lastMove: 'trop tard' }));
    await sleep(5);
    assert(got.length === 0, 'plus aucun coup signalé après stop()');
}

// ── 6. Statut de session (déconnexion du pair) ───────────────────────────────
{
    const ep = makeEndpoint();
    ep.peer = ep;
    const chan = new PeerChannel({ invokeImpl: ep.invokeImpl, listenImpl: ep.listenImpl });
    const statuses = [];
    chan.onStatusChange(s => statuses.push(s));
    await chan.start();
    ep.emitLocal('tabulon-peer://status', { connected: false, role: 'host', error: 'connexion perdue' });
    await sleep(5);
    assert(statuses.length === 1 && statuses[0].connected === false,
        'onStatusChange signale la déconnexion');
    assert(String(chan.lastError?.message).includes('connexion perdue'), 'lastError renseigné');
    chan.stop();
}

// ── 7. hostPeerMatch (étape 8c) : port fixe + adresses publiques en tête ────
{
    const calls = [];
    const invokeImpl = async (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === 'peer_host_start') return { port: args.port ?? 40123, ips: ['192.168.1.42', '127.0.0.1'] };
        throw new Error('commande inattendue: ' + cmd);
    };
    // sans options : port null transmis (= éphémère côté Rust), adresses locales seules
    const r1 = await hostPeerMatch('classic-chess', { invokeImpl });
    assert(calls[0][1].port === null, 'sans option, port null (éphémère) transmis à peer_host_start');
    assert(JSON.stringify(decodePeerCode(r1.code).ips) === JSON.stringify(['192.168.1.42', '127.0.0.1']),
        'sans option, le code ne contient que les adresses locales');
    // avec port fixe + adresses publiques
    const r2 = await hostPeerMatch('classic-chess', {
        port: 40000,
        extraAddresses: [' mon-nom.dyndns.example ', '203.0.113.7', '192.168.1.42'],  // espaces + doublon local
        invokeImpl,
    });
    assert(calls[1][1].port === 40000, 'le port fixe est transmis à peer_host_start');
    const ips = decodePeerCode(r2.code).ips;
    assert(ips[0] === 'mon-nom.dyndns.example' && ips[1] === '203.0.113.7',
        'adresses publiques EN TÊTE du code (essayées en premier), espaces nettoyés');
    assert(ips.filter(a => a === '192.168.1.42').length === 1,
        'une adresse saisie qui doublonne une locale n\'apparaît qu\'une fois');
    assert(ips.includes('127.0.0.1'), 'les adresses locales restent dans le code, en secours');
}

console.log(`\ntest-remote-peer-channel: ${passed} assertions OK`);
