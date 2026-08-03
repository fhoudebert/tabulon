// tests/test-engine-native.mjs
//
// Verifie que le pont vers le moteur NATIF respecte exactement le protocole
// que jocly.fairy.js attend de son worker fairy-stockfish. C'est tout l'enjeu
// du montage : Jocly n'est pas modifie, donc le shim doit se comporter comme
// le worker qu'il remplace, y compris dans les chemins d'echec.
//
// Aucun binaire ni webview requis : le RPC est injecte.

import { installInWindow, NativeFairyWorker } from '../app/content/engine-native.js';

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

console.log('');
console.log(`RESULTAT engine-native: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
