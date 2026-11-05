// test-key-test-prefs.mjs — le bouton « Tester » des clés, dans les Préférences.
//
// LA RÈGLE QUI SE VÉRIFIE ICI : on ne teste que ce qui servira en partie,
// c'est-à-dire la clé ENREGISTRÉE. Une clé tapée, collée ou générée mais pas
// encore enregistrée n'est pas celle qu'utiliseront les parties : la tester
// rassurerait à tort. Le bouton le dit, et n'ouvre rien.
//
// Vrai hub.html + vrai hub.js (jsdom), avec le vrai dist/ de jocly2 comme
// test-hub-integration ; seul window.__TAURI__ est simulé.
//
// Usage : node tests/test-key-test-prefs.mjs   (depuis tabulon/)
import { JSDOM } from '../app/node_modules/jsdom/lib/api.js';
import { completeTauriInjection } from './helpers/tauri-mock.mjs';
process.chdir(new URL('..', import.meta.url).pathname);
import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const KEY_A = 'a'.repeat(64);

const invokeCalls = [];
const storeData = new Map([
    ['community-keys', [{ id: 'k-1', name: 'Club', key: KEY_A }]],
    ['community-key-current', 'k-1'],
]);

const mockTauri = {
    core: { invoke: async (cmd, payload = {}) => {
        invokeCalls.push({ cmd, payload });
        if (cmd === 'get_app_info') return { name: 'Tabulon', version: 'test', homepage: 'https://example.org' };
        return null;
    } },
    event:  { listen: async () => () => {}, emit: async () => {} },
    window: { getCurrentWindow: () => ({ label: 'main', close: () => {} }) },
    os:     { platform: async () => 'linux', locale: async () => 'en-US' },
    shell:  { open: async () => {} },
    store:  { Store: class { static async load() { return {
        get: async (k) => storeData.get(k), set: async (k, v) => { storeData.set(k, v); },
    }; } } },
};

const html = readFileSync('./app/content/hub.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/hub.html' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
dom.window.__TAURI__ = completeTauriInjection(mockTauri);
dom.window.BrowserScriptLoader = {
    getBaseURL: () => 'https://tauri.localhost/',
    import: (p) => Promise.resolve(require('../dist/node/' + p)),
};
globalThis.Jocly = require('../dist/node/jocly.core.js');

await import('../app/content/hub.js');
document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));
const { t } = await import('../app/content/tabulon-i18n.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return; await sleep(25); }
    throw new Error('timeout: ' + what);
}
let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}
const $ = (id) => document.getElementById(id);
const opened = () => invokeCalls.filter(c => c.cmd === 'open_key_test');
const status = () => $('prefs-key-status').textContent;

// Les préférences sont remplies depuis le store au démarrage du hub.
await waitFor(() => $('prefs-community-key')?.value === KEY_A, 'clé enregistrée affichée');
assert(!!$('prefs-key-test'), 'bouton Tester présent à côté des clés');
assert($('prefs-key-test').parentElement === $('prefs-key-save').parentElement,
    'sur la même ligne que Générer / Enregistrer');

// 1. Clé enregistrée : la fenêtre de test s'ouvre sur CETTE clé (son
//    identifiant, jamais la clé), et une fenêtre déjà ouverte est prévenue.
$('prefs-key-test').click();
await waitFor(() => opened().length === 1, 'open_key_test appelé');
assert(opened()[0].payload.keyId === 'k-1', 'open_key_test reçoit l’identifiant de la clé sélectionnée');
assert(!JSON.stringify(invokeCalls).includes('"keyId":"' + KEY_A),
    'la clé elle-même n’est pas transmise à l’ouverture');
await waitFor(() => invokeCalls.some(c => c.cmd === 'relay_to_window'
        && c.payload.target === 'key-test' && c.payload.event === 'keyTestSelect'
        && c.payload.payload?.id === 'k-1'), 'keyTestSelect relayé');
assert(true, 'keyTestSelect relayé à la fenêtre key-test (cas déjà ouverte)');

// 2. Clé modifiée dans le champ mais pas enregistrée : on le dit, rien ne s'ouvre.
$('prefs-community-key').value = 'b'.repeat(64);
$('prefs-key-test').click();
await sleep(50);
assert(opened().length === 1, 'clé modifiée non enregistrée : la fenêtre ne s’ouvre pas');
assert(status() === t('prefs.keyTestUnsaved'), 'et le message demande d’enregistrer d’abord');

// 3. Même règle pour une clé tout juste générée.
$('prefs-key-new').click();
await waitFor(() => $('prefs-community-key').value !== 'b'.repeat(64), 'clé générée');
$('prefs-key-test').click();
await sleep(50);
assert(opened().length === 1 && status() === t('prefs.keyTestUnsaved'),
    'clé générée mais non enregistrée : refusée de même');

// 4. Une fois enregistrée, elle se teste.
$('prefs-key-save').click();
await waitFor(() => storeData.get('community-keys')[0].key === $('prefs-community-key').value, 'clé enregistrée');
$('prefs-key-test').click();
await waitFor(() => opened().length === 2, 'ouverture après enregistrement');
assert(status() === '', 'aucun message d’avertissement quand le test s’ouvre');

// 5. Nouvelle entrée encore vide : rien à tester.
$('prefs-key-add').click();
await waitFor(() => $('prefs-community-key').value === '', 'nouvelle entrée vide');
$('prefs-key-test').click();
await sleep(50);
assert(opened().length === 2 && status() === t('prefs.keyTestNone'),
    'clé vide : message « enregistrez d’abord une clé », pas de fenêtre');

console.log(`\ntest-key-test-prefs: ${passed} assertions OK`);
process.exit(0);
