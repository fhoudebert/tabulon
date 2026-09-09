// tests/test-engine-native.mjs
//
// Verifie que le pont vers le moteur NATIF respecte exactement le protocole
// que jocly.fairy.js attend de son worker fairy-stockfish. C'est tout l'enjeu
// du montage : Jocly n'est pas modifie, donc le shim doit se comporter comme
// le worker qu'il remplace, y compris dans les chemins d'echec.
//
// Aucun binaire ni webview requis : le RPC est injecte.

import { installInWindow, NativeFairyWorker, NativeScanWorker, NativeKataWorker } from '../app/content/engine-native.js';

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };

// RPC de test : enregistre les appels et rend des reponses programmables.
function makeRpc(responses = {}) {
    const calls = [];
    return {
        calls,
        call(method, ...args) {
            calls.push({ method, args });
            const r = responses[method];
            if (typeof r === 'function') return r(...args);
            if (r instanceof Error) return Promise.reject(r);
            return Promise.resolve(r === undefined ? null : r);
        },
    };
}

// Collecte les messages postes par le shim vers jocly.
function listen(worker) {
    const seen = [];
    worker.onmessage = (e) => seen.push(e.data);
    return seen;
}
const settle = () => new Promise((r) => setTimeout(r, 10));

console.log('Test 1 - Init');
{
    const rpc = makeRpc({ engine_probe: () => Promise.resolve('Fairy-Stockfish 14') });
    const w = new NativeFairyWorker(rpc);
    const seen = listen(w);
    w.postMessage({ type: 'Init' });
    ok(seen.length === 0, 'aucune reponse SYNCHRONE (contrat d\'un vrai Worker)');
    await settle();
    ok(seen.length === 1 && seen[0].type === 'Ready', 'moteur present -> Ready');
    ok(rpc.calls[0].method === 'engine_probe', 'Init interroge engine_probe');
}

console.log('Test 2 - moteur absent : chemin de repli');
{
    const rpc = makeRpc({ engine_probe: new Error('moteur natif introuvable') });
    const w = new NativeFairyWorker(rpc);
    const seen = listen(w);
    w.postMessage({ type: 'Init' });
    await settle();
    // C'est CE message qui fait basculer jocly sur son IA native
    // (err.engineUnavailable -> FallbackToNativeAI) et declenche le bandeau.
    ok(seen.length === 1 && seen[0].type === 'Error', 'moteur absent -> Error (et non un silence)');
    ok(/introuvable/.test(seen[0].error), 'la cause est transmise');
}

console.log('Test 3 - Search');
{
    const result = { bestMoveUci: 'e2e4', ponderUci: 'e7e5', lastInfo: 'info depth 12' };
    const rpc = makeRpc({ engine_search: () => Promise.resolve(result) });
    const w = new NativeFairyWorker(rpc);
    const seen = listen(w);
    w.postMessage({
        type: 'Search', variant: 'chess', fen: 'FEN', depth: 12,
        moveTimeMs: 1000, skillLevel: 5, chess960: true, customVariantIni: 'ini',
        evalFile: 'nnue/chess.nnue',
    });
    await settle();
    ok(seen.length === 1 && seen[0].type === 'Done', 'recherche -> Done');
    ok(seen[0].data && seen[0].data.bestMoveUci === 'e2e4', 'le coup est transmis tel quel');
    const sent = rpc.calls[0].args[0];
    ok(rpc.calls[0].method === 'engine_search', 'appelle engine_search');
    ok(sent.variant === 'chess' && sent.fen === 'FEN' && sent.moveTimeMs === 1000 &&
       sent.skillLevel === 5 && sent.chess960 === true && sent.customVariantIni === 'ini' &&
       sent.depth === 12,
       'tous les champs de niveau sont relayes sans traduction');
    ok(sent.evalFile === 'nnue/chess.nnue',
       'evalFile est relaye (resolu cote Rust, relatif au binaire)');
}

console.log('Test 4 - Stop pendant une recherche');
{
    let reject;
    const rpc = makeRpc({
        engine_search: () => new Promise((_, rj) => { reject = rj; }),
        engine_stop: () => Promise.resolve(null),
    });
    const w = new NativeFairyWorker(rpc);
    const seen = listen(w);
    w.postMessage({ type: 'Search', variant: 'chess', fen: 'FEN' });
    w.postMessage({ type: 'Stop' });
    ok(rpc.calls.some((c) => c.method === 'engine_stop'), 'Stop interrompt cote Rust');
    // Le processus tue fait echouer la recherche : jocly doit voir Aborted,
    // surtout pas Error (qui serait journalise comme un vrai echec).
    reject(new Error('engine exited unexpectedly'));
    await settle();
    ok(seen.length === 1 && seen[0].type === 'Aborted', 'echec consecutif a Stop -> Aborted');
}

console.log('Test 5 - Stop hors recherche');
{
    const rpc = makeRpc({ engine_stop: () => Promise.resolve(null) });
    const w = new NativeFairyWorker(rpc);
    const seen = listen(w);
    w.postMessage({ type: 'Stop' });
    await settle();
    ok(rpc.calls.length === 0, 'aucun appel inutile quand rien ne tourne');
    ok(seen.length === 0, 'aucun message parasite');
}

console.log('Test 6 - recherche en echec (moteur present)');
{
    const rpc = makeRpc({ engine_search: new Error('engine timed out') });
    const w = new NativeFairyWorker(rpc);
    const seen = listen(w);
    w.postMessage({ type: 'Search', variant: 'chess', fen: 'FEN' });
    await settle();
    ok(seen.length === 1 && seen[0].type === 'Error', 'echec de recherche -> Error');
}

console.log('Test 7 - interception de Worker');
{
    // Fenetre simulee : seul `Worker` compte.
    class FakeWorker { constructor(url) { this.url = url; } }
    const created = [];
    const win = { Worker: function (url) { created.push(url); return new FakeWorker(url); } };
    const rpc = makeRpc();

    ok(installInWindow(win, rpc) === true, 'installation reussie');
    ok(installInWindow(win, rpc) === false, 'idempotent (pas de double enveloppe)');

    const fairy = new win.Worker('/browser/jocly.fairyworker.js');
    ok(fairy instanceof NativeFairyWorker, 'jocly.fairyworker.js -> shim natif');
    ok(created.length === 0, 'aucun vrai Worker cree pour fairy');

    // L'autre worker de jocly ne doit surtout PAS etre intercepte : c'est
    // asset-rewrite.js qui le redirige vers le dist externe.
    const ai = new win.Worker('/browser/jocly.aiworker.js');
    ok(!(ai instanceof NativeFairyWorker) && created.length === 1,
       'jocly.aiworker.js passe au Worker precedent (hook asset-rewrite)');

    const abs = new win.Worker('http://tauri.localhost/browser/jocly.fairyworker.js?v=2');
    ok(abs instanceof NativeFairyWorker, 'URL absolue avec parametre reconnue aussi');
}

console.log('Test 8 - compte rendu NNUE dans la console');
{
    const logs = [];
    const realInfo = console.info;
    console.info = (...a) => logs.push(a.join(' '));
    try {
        // Reseau charge
        let rpc = makeRpc({ engine_search: () => Promise.resolve({ bestMoveUci: 'e2e4', evalFileUsed: '/opt/engine/nnue/shako.nnue' }) });
        let w = new NativeFairyWorker(rpc); listen(w);
        w.postMessage({ type: 'Search', variant: 'shako', fen: 'F', evalFile: 'nnue/shako.nnue' });
        await settle();
        ok(logs.some(l => /shako.*reseau NNUE.*shako\.nnue/.test(l)),
           'reseau charge -> trace visible dans la console');

        // Meme variante : on ne repete pas a chaque coup.
        const before = logs.length;
        w.postMessage({ type: 'Search', variant: 'shako', fen: 'F', evalFile: 'nnue/shako.nnue' });
        await settle();
        ok(logs.length === before, 'une seule trace par variante (pas a chaque coup)');

        // Demande mais introuvable : le joueur doit savoir qu'il joue sans.
        rpc = makeRpc({ engine_search: () => Promise.resolve({ bestMoveUci: 'e2e4', evalFileUsed: null }) });
        w = new NativeFairyWorker(rpc); listen(w);
        w.postMessage({ type: 'Search', variant: 'shogi', fen: 'F', evalFile: 'nnue/shogi.nnue' });
        await settle();
        ok(logs.some(l => /shogi.*evaluation classique/.test(l)),
           'reseau demande mais absent -> trace explicite');

        // Aucun reseau demande : rien a signaler.
        const before2 = logs.length;
        rpc = makeRpc({ engine_search: () => Promise.resolve({ bestMoveUci: 'e2e4', evalFileUsed: null }) });
        w = new NativeFairyWorker(rpc); listen(w);
        w.postMessage({ type: 'Search', variant: 'chess', fen: 'F' });
        await settle();
        ok(logs.length === before2, 'aucun reseau demande -> aucune trace');
    } finally {
        console.info = realInfo;
    }
}

console.log('Test 9 - moteur de dames (scan)');
{
    // Init : moteur present
    let rpc = makeRpc({ scan_probe: () => Promise.resolve('Scan 3.1') });
    let w = new NativeScanWorker(rpc);
    let seen = listen(w);
    w.postMessage({ type: 'Init' });
    await settle();
    ok(seen.length === 1 && seen[0].type === 'Ready', 'scan present -> Ready');
    ok(rpc.calls[0].method === 'scan_probe', 'Init interroge scan_probe');

    // Init : moteur absent -> repli, comme pour fairy
    rpc = makeRpc({ scan_probe: new Error('moteur Scan introuvable') });
    w = new NativeScanWorker(rpc); seen = listen(w);
    w.postMessage({ type: 'Init' });
    await settle();
    ok(seen.length === 1 && seen[0].type === 'Error',
       'scan absent -> Error (jocly se rabat sur son IA native)');

    // Search : le coup remonte sous data.bestMove (PAS bestMoveUci)
    rpc = makeRpc({ scan_search: () => Promise.resolve({ bestMove: '33-28', lastInfo: 'info depth=21' }) });
    w = new NativeScanWorker(rpc); seen = listen(w);
    w.postMessage({ type: 'Search', fen: 'W:W31-50:B1-20', moveTimeMs: 1000, bookEnabled: false });
    await settle();
    ok(seen.length === 1 && seen[0].type === 'Done', 'recherche -> Done');
    ok(seen[0].data && seen[0].data.bestMove === '33-28',
       'le coup est rendu sous data.bestMove (contrat de jocly.scan.js)');
    const sent = rpc.calls[0].args[0];
    ok(sent.fen === 'W:W31-50:B1-20' && sent.moveTimeMs === 1000 && sent.bookEnabled === false,
       'les champs de niveau sont relayes sans traduction');

    // Position terminale : « done » sans coup n'est pas une erreur.
    rpc = makeRpc({ scan_search: () => Promise.resolve({ bestMove: null }) });
    w = new NativeScanWorker(rpc); seen = listen(w);
    w.postMessage({ type: 'Search', fen: 'W:W50:B1' });
    await settle();
    ok(seen.length === 1 && seen[0].type === 'Done' && seen[0].data.bestMove === null,
       'position terminale -> Done sans coup, pas Error');

    // Stop pendant une recherche -> Aborted
    let reject;
    rpc = makeRpc({
        scan_search: () => new Promise((_, rj) => { reject = rj; }),
        scan_stop: () => Promise.resolve(null),
    });
    w = new NativeScanWorker(rpc); seen = listen(w);
    w.postMessage({ type: 'Search', fen: 'W:W31-50:B1-20' });
    w.postMessage({ type: 'Stop' });
    ok(rpc.calls.some((c) => c.method === 'scan_stop'), 'Stop interrompt cote Rust');
    reject(new Error('engine exited unexpectedly'));
    await settle();
    ok(seen.length === 1 && seen[0].type === 'Aborted', 'echec consecutif a Stop -> Aborted');
}

console.log('Test 10 - KataGo : ce que l\'Init doit retenir');
{
    // Ce que jocly.kata.js envoie : le reseau et la taille du goban arrivent
    // a l'Init, pas a la recherche -- KataGo en a besoin AU LANCEMENT. Un
    // shim qui ne les retient pas laisse le cote Rust sans rien pour demarrer
    // le moteur, et l'echec ne se voit qu'au premier coup.
    const rpc = makeRpc({
        katago_probe: () => Promise.resolve('KataGo v1.13'),
        katago_search: () => Promise.resolve({ bestMove: 40, resigned: false }),
    });
    const w = new NativeKataWorker(rpc);
    const seen = listen(w);
    w.postMessage({ type: 'Init', net: 'katago-nnetwork.bin.gz', boardSize: 9 });
    await settle();
    ok(seen.length === 1 && seen[0].type === 'Ready', 'moteur present -> Ready');
    ok(rpc.calls[0].method === 'katago_probe', 'Init interroge katago_probe');
    ok(rpc.calls[0].args[0].net === 'katago-nnetwork.bin.gz',
       'la sonde recoit le reseau, seul moyen de savoir s\'il est la');

    w.postMessage({
        type: 'Search',
        moves: [{ loc: 40, col: 1 }], toPlay: 2, komi: 5.5,
        rules: 'chinese-ogs',
        visits: 64, moveTimeMs: 3000,
    });
    await settle();
    const req = rpc.calls[1].args[0];
    ok(rpc.calls[1].method === 'katago_search', 'Search interroge katago_search');
    ok(req.net === 'katago-nnetwork.bin.gz' && req.boardSize === 9,
       'le reseau et le goban de l\'Init accompagnent la recherche');
    ok(JSON.stringify(req.moves) === JSON.stringify([{ loc: 40, col: 1 }]),
       'la position part telle quelle : une suite de coups, pas un FEN');
    ok(req.toPlay === 2 && req.komi === 5.5, 'le trait et le komi suivent');
    ok(req.visits === 64 && req.moveTimeMs === 3000, 'le budget du niveau suit');
    // Les regles voyagent avec la position. Sans elles KataGo joue sous celles
    // de son katago.cfg -- que Tabulon ne fournit pas, et dont le modele livre
    // par KataGo porte tromp-taylor : le moteur proposerait alors des suicides
    // multi-pierres que jocly refuse.
    ok(req.rules === 'chinese-ogs',
       'les regles arbitrees par le jeu accompagnent la recherche');
    ok(seen.length === 2 && seen[1].type === 'Done' && seen[1].data.bestMove === 40,
       'la reponse porte l\'index de l\'intersection');
}

console.log('Test 11 - KataGo : reseau absent, repli silencieux');
{
    // KataGo ne joue pas sans reseau -- contrairement a Fairy-Stockfish, pour
    // qui un NNUE manquant n'est qu'une evaluation classique. C'est donc un
    // Error, celui qui fait basculer jocly sur son IA native.
    const rpc = makeRpc({ katago_probe: new Error('reseau KataGo introuvable a cote du binaire') });
    const w = new NativeKataWorker(rpc);
    const seen = listen(w);
    w.postMessage({ type: 'Init', net: 'katago-nnetwork.bin.gz', boardSize: 19 });
    await settle();
    ok(seen.length === 1 && seen[0].type === 'Error', 'reseau absent -> Error (et non un silence)');
    ok(/reseau/.test(seen[0].error), 'la cause est transmise');
}

console.log('Test 12 - KataGo : passe, abandon et interruption');
{
    // -1 est aussi bien une passe qu'un abandon : les deux sont un « pas de
    // coup » pour jocly, et c'est `resigned` qui les distingue pour le log.
    let rpc = makeRpc({ katago_search: () => Promise.resolve({ bestMove: -1, resigned: false }) });
    let w = new NativeKataWorker(rpc);
    let seen = listen(w);
    w.postMessage({ type: 'Search', moves: [], toPlay: 1, komi: 7.5 });
    await settle();
    ok(seen.length === 1 && seen[0].data.bestMove === -1, 'une passe remonte comme -1');

    rpc = makeRpc({ katago_search: () => Promise.resolve({ bestMove: -1, resigned: true }) });
    w = new NativeKataWorker(rpc); seen = listen(w);
    w.postMessage({ type: 'Search', moves: [], toPlay: 1, komi: 7.5 });
    await settle();
    ok(seen.length === 1 && seen[0].type === 'Done', 'un abandon reste un Done, pas une erreur');

    let reject;
    rpc = makeRpc({ katago_search: () => new Promise((_, rj) => { reject = rj; }) });
    w = new NativeKataWorker(rpc); seen = listen(w);
    w.postMessage({ type: 'Search', moves: [], toPlay: 1, komi: 7.5 });
    w.postMessage({ type: 'Stop' });
    ok(rpc.calls.some((c) => c.method === 'katago_stop'), 'Stop interrompt cote Rust');
    reject(new Error('killed'));
    await settle();
    ok(seen.length === 1 && seen[0].type === 'Aborted', 'echec consecutif a Stop -> Aborted');
}

console.log('Test 13 - les trois moteurs cohabitent');
{
    class FakeWorker { constructor(url) { this.url = url; } }
    const created = [];
    const win = { Worker: function (url) { created.push(url); return new FakeWorker(url); } };
    installInWindow(win, makeRpc());

    ok(new win.Worker('/browser/jocly.fairyworker.js') instanceof NativeFairyWorker,
       'fairyworker -> shim echecs');
    ok(new win.Worker('/browser/jocly.scanworker.js') instanceof NativeScanWorker,
       'scanworker -> shim dames');
    ok(new win.Worker('/browser/jocly.kataworker.js') instanceof NativeKataWorker,
       'kataworker -> shim go');
    // Le worker d'IA native reste au hook d'asset-rewrite.
    const ai = new win.Worker('/browser/jocly.aiworker.js');
    ok(!(ai instanceof NativeFairyWorker) && !(ai instanceof NativeScanWorker)
       && !(ai instanceof NativeKataWorker) && created.length === 1,
       'aiworker passe au Worker precedent');
}

console.log('');
console.log(`RESULTAT engine-native: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
