// test-remote-channel.mjs — HttpRelayChannel contre un relai fileio.php
// mocké en mémoire (mêmes règles que le vrai script PHP : stockage texte
// brut par gameid, aucune validation de structure). Seul window.__TAURI__
// est mocké, comme dans tests/test-hub-integration.mjs.
//
// Le test contre une VRAIE instance jocly-simple-match (biscandine.fr) est
// séparé : scripts/check-remote-relay.mjs (a besoin du réseau, pas lancé
// par la suite automatisée).
//
// Usage : node tests/test-remote-channel.mjs

// ── Mock relai (équivalent en mémoire de fileio.php) ─────────────────────────
const store = new Map(); // gameid -> texte brut
async function mockFetch(url, init) {
    const params = new URLSearchParams(init.body);
    const action = params.get('gameioaction');
    const gameid = params.get('gameid');
    if (action === 'save') {
        store.set(gameid, params.get('gamedata'));
        return { status: 200, text: async () => 'ok' };
    }
    if (action === 'load') {
        return { status: 200, text: async () => store.get(gameid) ?? '' };
    }
    return { status: 400, text: async () => '' };
}

// ── window.__TAURI__ minimal (httpFetch en passe par window().http.fetch) ────
globalThis.window = { __TAURI__: { http: { fetch: mockFetch } } };

const { HttpRelayChannel } = await import('../app/content/remote-channel.js');

let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 1. Une partie inexistante ne déclenche aucun callback ────────────────────
{
    const chan = new HttpRelayChannel({
        relayUrl: 'https://relai.test/fileio.php',
        matchId: 'partie-inexistante',
        pollIntervalMs: 20,
    });
    let called = false;
    chan.onRemoteMove(() => { called = true; });
    await chan.start();
    await sleep(60);
    chan.stop();
    assert(!called, 'aucun coup adverse détecté sur une partie qui n’existe pas encore côté relai');
}

// ── 2. push() écrit dans le relai, un pair qui pollait le reçoit ─────────────
{
    const matchId = 'partie-1';
    const a = new HttpRelayChannel({ relayUrl: 'https://relai.test/fileio.php', matchId, pollIntervalMs: 20 });
    const b = new HttpRelayChannel({ relayUrl: 'https://relai.test/fileio.php', matchId, pollIntervalMs: 20 });

    let received = null;
    b.onRemoteMove(payload => { received = payload; });
    await b.start();

    await a.push({ nbTurns: 1, lastMove: { from: 'e2', to: 'e4' }, state: { fen: 'après-e4' } });

    // laisse à b le temps d'un cycle de polling
    await sleep(80);
    a.stop(); b.stop();

    assert(received !== null, 'B détecte le coup poussé par A');
    assert(received?.lastMove?.to === 'e4', 'B reçoit le bon lastMove');
    assert(received?.state?.fen === 'après-e4', 'B reçoit le bon state');
}

// ── 3. Pas de callback en double pour le même coup ────────────────────────────
{
    const matchId = 'partie-2';
    const a = new HttpRelayChannel({ relayUrl: 'https://relai.test/fileio.php', matchId, pollIntervalMs: 15 });
    const b = new HttpRelayChannel({ relayUrl: 'https://relai.test/fileio.php', matchId, pollIntervalMs: 15 });

    let calls = 0;
    b.onRemoteMove(() => { calls++; });
    await a.push({ nbTurns: 1, lastMove: 'm1' });
    await b.start();
    await sleep(90); // plusieurs cycles de polling, un seul nouveau coup
    a.stop(); b.stop();

    assert(calls === 1, `un seul callback pour un seul coup poussé (obtenu: ${calls})`);
}

// ── 4. stop() arrête bien le polling ─────────────────────────────────────────
{
    const matchId = 'partie-3';
    const chan = new HttpRelayChannel({ relayUrl: 'https://relai.test/fileio.php', matchId, pollIntervalMs: 15 });
    let calls = 0;
    chan.onRemoteMove(() => { calls++; });
    await chan.start();
    chan.stop();
    const before = calls;
    await sleep(60);
    assert(calls === before, 'aucun polling après stop()');
}

// ── 5. panne réseau ponctuelle : pas d'exception, lastError renseigné ────────
{
    globalThis.window.__TAURI__.http.fetch = async () => { throw new Error('réseau HS'); };
    const chan = new HttpRelayChannel({ relayUrl: 'https://relai.test/fileio.php', matchId: 'partie-4', pollIntervalMs: 15 });
    await chan.start();
    await sleep(40);
    chan.stop();
    assert(chan.lastError instanceof Error, 'une panne réseau est capturée dans lastError, pas jetée');
    globalThis.window.__TAURI__.http.fetch = mockFetch; // restaure pour la suite éventuelle
}

<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> b4517b4 (robustesse)
// ── 6. resetBaseline() évite un faux positif après une action locale
//     qui n'a rien poussé au relai (takeback/restart/load) ────────────────────
{
    const matchId = 'partie-5';
    const a = new HttpRelayChannel({ relayUrl: 'https://relai.test/fileio.php', matchId, pollIntervalMs: 15 });
    const b = new HttpRelayChannel({ relayUrl: 'https://relai.test/fileio.php', matchId, pollIntervalMs: 15 });

    await a.push({ nbTurns: 3, lastMove: 'm3' });   // le relai est déjà à 3

    let calls = 0;
    b.onRemoteMove(() => { calls++; });
    // B a localement rechargé une position à 3 coups (takeback/restart) sans
    // rien pousser au relai -- resetBaseline() aligne sa reference sur 3
    // sans passer par push() (qui, lui, ecrirait au relai).
    b.resetBaseline(3);
    await b.start();
    await sleep(60);
    a.stop(); b.stop();

    assert(calls === 0, 'aucun faux "coup adverse" après resetBaseline() alignée sur le relai');
}

<<<<<<< HEAD
// ── 7. Codec 'jocly-simple-match' : interop avec un VRAI client
//     jocly-simple-match (pas une autre instance de Tabulon) ────────────────────
{
    const matchId = 'partie-6';
    // Simule ce qu'écrirait control.js lui-même (saveGameIfNecessary), sans
    // passer par notre encodeur -- c'est bien l'interop qu'on teste ici.
    store.set(matchId, JSON.stringify({
        matchDetails: { matchId, gameName: 'classic-chess', nbTurns: 1, a: { pseudo: 'Alice' }, b: { pseudo: '' } },
        matchdata: { playedMoves: [{ from: 'e2', to: 'e4' }], board: 'après 1.e4' },
        time: Date.now(),
        key: 'myverypreciouskey',
    }));

    const me = new HttpRelayChannel({
        relayUrl: 'https://relai.test/fileio.php', matchId, pollIntervalMs: 20,
        codec: 'jocly-simple-match', gameName: 'classic-chess',
    });
    let received = null;
    me.onRemoteMove(payload => { received = payload; });
    await me.start();
    await sleep(60);
    me.stop();

    assert(received !== null, 'un coup écrit au format control.js est bien détecté');
    assert(received?.lastMove?.to === 'e4', 'lastMove extrait de matchdata.playedMoves (dernier élément)');
    assert(received?.state?.board === 'après 1.e4', 'state = matchdata complet (pour un load() intégral côté nous)');
}
{
    // Et dans l'autre sens : ce que NOUS écrivons doit être lisible par un
    // vrai client control.js -- on vérifie juste la forme exacte des octets
    // qu'il attend (voir index.php: matchDetails = {matchId,gameName,nbTurns,...}).
    const matchId = 'partie-7';
    const me = new HttpRelayChannel({
        relayUrl: 'https://relai.test/fileio.php', matchId, pollIntervalMs: 20,
        codec: 'jocly-simple-match', gameName: 'go',
    });
    await me.push({ nbTurns: 1, state: { playedMoves: [{ pt: [3, 3] }] } });
    const raw = JSON.parse(store.get(matchId));
    assert(raw.matchDetails.matchId === matchId && raw.matchDetails.gameName === 'go' && raw.matchDetails.nbTurns === 1,
        'ce que nous écrivons a la forme exacte attendue par control.js (matchDetails.{matchId,gameName,nbTurns})');
    assert(Array.isArray(raw.matchdata.playedMoves), 'ce que nous écrivons expose matchdata.playedMoves (lu par control.js/loadMatchFromID)');
}

=======
>>>>>>> 2d01ed4 (remotechannel)
=======
>>>>>>> b4517b4 (robustesse)
console.log(`\n${passed} assertions passées.`);
