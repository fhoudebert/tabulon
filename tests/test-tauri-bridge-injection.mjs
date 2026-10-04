// test-tauri-bridge-injection.mjs — prédicat pur isTauriInjected() du bridge
// (garde contre la course d'injection Windows, tauri-apps/tauri#12990).
// Et l'attente elle-même, SANS top-level await (refusé par WKWebView sous
// macOS : « Unexpected identifier 'waitForTauri' ») : le module s'évalue tout
// de suite, ce sont les appels asynchrones qui attendent l'injection.
//
// Usage : node tests/test-tauri-bridge-injection.mjs

import { isTauriInjected, isTauriPage } from '../app/content/tauri-bridge.js';

let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}

const full = { core: {}, event: {}, window: {}, webviewWindow: {},
               shell: {}, dialog: {}, store: {}, os: {} };

assert(isTauriInjected({ __TAURI__: full }) === true,
    'injection complète (tous les sous-objets des plugins de lib.rs) reconnue');
assert(isTauriInjected(undefined) === false, 'absence de window tolérée (false)');
assert(isTauriInjected({}) === false, '__TAURI__ absent → false');
assert(isTauriInjected({ __TAURI__: null }) === false, '__TAURI__ null → false');
assert(isTauriInjected({ __TAURI__: { core: {}, event: {} } }) === false,
    'injection PARTIELLE (core présent, plugins pas encore) → false — le cas de course réel');
for (const missing of Object.keys(full)) {
    const partial = { ...full }; delete partial[missing];
    assert(isTauriInjected({ __TAURI__: partial }) === false,
        `sous-objet manquant détecté : ${missing}`);
}

// ── isTauriPage : où l'attente d'injection est-elle légitime ? ──────────────
assert(isTauriPage({ location: { protocol: 'tauri:', hostname: 'localhost' } }) === true,
    'page tauri://localhost (Linux/macOS) reconnue');
assert(isTauriPage({ location: { protocol: 'http:', hostname: 'tauri.localhost' } }) === true,
    'page http://tauri.localhost (Windows) reconnue');
assert(isTauriPage({ location: { protocol: 'https:', hostname: 'tauri.localhost' } }) === true,
    'variante https (useHttpsScheme) reconnue');
assert(isTauriPage({ location: { protocol: 'http:', hostname: 'localhost' } }) === true,
    'devUrl http://localhost reconnu');
assert(isTauriPage({}) === false,
    'stub de test sans location → PAS d\'attente (comportement historique conservé)');
assert(isTauriPage({ location: { protocol: 'https:', hostname: 'example.com' } }) === false,
    'page web quelconque → pas d\'attente');
assert(isTauriPage(undefined) === false, 'absence de window → pas d\'attente');

// ── Aucun top-level await : rien dans le module ne suspend son évaluation ───
import { readFileSync } from 'fs';
const src = readFileSync(new URL('../app/content/tauri-bridge.js', import.meta.url), 'utf8');
// Un module qui n'a pas de top-level await se compile comme corps de
// fonction NON async une fois import/export retirés ; avec un await hors
// fonction, la compilation échoue. Pas besoin d'analyseur.
const asScript = src
    .replace(/^export\s+(const|function|async function|class|let)/gm, '$1')
    .replace(/^import .*$/gm, '');
let compiles = true;
try { new Function(asScript); } catch (e) { compiles = false; console.error(e.message); }
assert(compiles, 'tauri-bridge.js sans top-level await (compilable hors module async)');

// ── Comportement : page Tauri pas encore injectée (course Windows) ──────────
const full2 = { core: { invoke: async (c) => 'ok:' + c }, event: {}, window: {}, webviewWindow: {},
                shell: {}, dialog: {}, os: {},
                store: { Store: { load: async (f) => ({ file: f }) } } };
globalThis.window = { location: { protocol: 'tauri:', hostname: 'localhost' } };
const t0 = Date.now();
const B = await import('../app/content/tauri-bridge.js?course=' + Date.now());
assert(Date.now() - t0 < 1000, 'le module s\'évalue sans attendre l\'injection (aucune suspension)');
const pending = B.invoke('get_x');
const pendingStore = B.Store.load('tabulon.json');
let settled = false; pending.then(() => { settled = true; });
await new Promise(r => setTimeout(r, 60));
assert(!settled, 'invoke() ATTEND l\'injection au lieu de lever');
globalThis.window.__TAURI__ = full2;
assert(await pending === 'ok:get_x', 'invoke() part dès que l\'injection arrive');
assert((await pendingStore).file === 'tabulon.json', 'Store.load() (proxy de classe) attend lui aussi');
assert((await B.Store.load('x.json')).file === 'x.json', 'Store.load() après injection : appel direct');
delete globalThis.window;

console.log(`\ntest-tauri-bridge-injection: ${passed} assertions OK`);
