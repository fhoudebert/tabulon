// test-tauri-bridge-injection.mjs — prédicat pur isTauriInjected() du bridge
// (garde contre la course d'injection Windows, tauri-apps/tauri#12990).
// L'import du bridge sous Node est sûr : le top-level await est gardé par
// `typeof window !== 'undefined'` — ce test vérifie aussi cela, de fait.
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

console.log(`\ntest-tauri-bridge-injection: ${passed} assertions OK`);
