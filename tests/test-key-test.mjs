// test-key-test.mjs — la fenêtre « Test » d'une clé de communauté.
//
// CE QUI SE VÉRIFIE ICI : que l'écran dit VRAI. Un test qui annonce « même
// clé » alors que les clés diffèrent serait pire que pas de test du tout :
// on partirait jouer en croyant ses messages lisibles par l'autre.
//
// Le chiffrement lui-même est celui de seal_cmds.rs, couvert par ses tests
// Rust. Ici seal_text/open_text sont remplacés par un sceau FACTICE mais lié
// à la clé (ouvrir avec une autre clé échoue, comme en vrai) : c'est le
// câblage de l'écran qui est testé — quelle clé part vers Rust, ce qu'on
// affiche de la réponse.
//
// Usage : node tests/test-key-test.mjs   (depuis tabulon/)
import { JSDOM } from '../app/node_modules/jsdom/lib/api.js';
import { completeTauriInjection } from './helpers/tauri-mock.mjs';
process.chdir(new URL('..', import.meta.url).pathname);
import { readFileSync } from 'fs';

const KEY_A = 'a'.repeat(64);
const KEY_B = '0123456789abcdef'.repeat(4);

const storeData = new Map();
const invokeCalls = [];
const eventHandlers = {};

// Sceau factice : base64 de {clé, texte}. Ouvrir avec une autre clé, ou un
// texte abîmé, lève -- comme open_text, sans dire pourquoi.
const fakeSeal = (key, text) => Buffer.from(JSON.stringify({ k: key, t: text })).toString('base64');
function fakeOpen(key, sealed) {
    let o;
    try { o = JSON.parse(Buffer.from(sealed, 'base64').toString('utf8')); } catch { throw 'ouverture impossible'; }
    if (!o || o.k !== key) throw 'ouverture impossible';
    return o.t;
}

const mockTauri = {
    core: { invoke: async (cmd, args) => {
        invokeCalls.push({ cmd, args });
        switch (cmd) {
            case 'seal_text':   return fakeSeal(args.key, args.text);
            case 'open_text':   return fakeOpen(args.key, args.sealed);
            case 'chat_key_id': return args.master.slice(0, 16);
            default: return null;
        }
    } },
    event: {
        listen: async (name, fn) => { (eventHandlers[name] ??= []).push(fn); return () => {}; },
        emit: async () => {},
    },
    window: { getCurrentWindow: () => ({ label: 'key-test', close: () => {}, setTitle: async () => {} }) },
    os:     { platform: async () => 'linux', locale: async () => 'en-US' },
    store:  { Store: class { static async load() { return {
        get: async (k) => storeData.get(k), set: async (k, v) => { storeData.set(k, v); },
    }; } } },
};

storeData.set('community-keys', [
    { id: 'k-1', name: 'Club', key: KEY_A },
    { id: 'k-2', name: 'Famille', key: KEY_B },
    { id: 'k-3', name: 'Brouillon', key: '' },        // jamais remplie : pas testable
]);

const html = readFileSync('./app/content/key-test.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
// ?key= désigne la DEUXIÈME clé : c'est celle du bouton Test, pas la première.
const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/key-test.html?key=k-2' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Event = dom.window.Event;
dom.window.__TAURI__ = completeTauriInjection(mockTauri);

await import('../app/content/key-test.js');
document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return; await sleep(20); }
    throw new Error('timeout: ' + what);
}
let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}
const $ = (id) => document.getElementById(id);
const status = (id) => $(id).textContent;

// 1. Ouverture : la clé du bouton Test est choisie, avec son empreinte.
await waitFor(() => $('kt-fingerprint').textContent !== '', 'empreinte affichée');
assert($('kt-key').value === 'k-2', 'la clé désignée par ?key= est sélectionnée (pas la première)');
assert($('kt-fingerprint').textContent === KEY_B.slice(0, 16), 'empreinte calculée par chat_key_id sur CETTE clé');
assert([...$('kt-key').options].map(o => o.value).join() === 'k-1,k-2',
    'une clé vide n’est pas proposée — rien à tester');
assert(!dom.window.location.href.includes(KEY_B),
    'la clé elle-même ne passe pas dans l’URL, seul son identifiant');

// 2. Chiffrer : le texte part avec la clé choisie, et l'aller-retour est vérifié.
$('kt-plain').value = 'Bonjour, partie à 21 h ?';
$('kt-seal').click();
await waitFor(() => $('kt-sealed-out').value !== '', 'texte chiffré affiché');
const sealed = $('kt-sealed-out').value;
const sealCall = invokeCalls.find(c => c.cmd === 'seal_text');
assert(sealCall.args.key === KEY_B && sealCall.args.text === 'Bonjour, partie à 21 h ?',
    'seal_text reçoit la clé sélectionnée et le message');
await waitFor(() => /✓/.test(status('kt-seal-status')), 'aller-retour vérifié');
assert(invokeCalls.some(c => c.cmd === 'open_text' && c.args.sealed === sealed && c.args.key === KEY_B),
    'le sceau est aussitôt rouvert avec la même clé (contrôle d’aller-retour)');
assert($('kt-seal-status').classList.contains('key-test-ok'), 'succès affiché comme tel');

// 3. Déchiffrer ce qu'on vient de chiffrer, recollé avec des retours à la
//    ligne comme le fait un client mail : on retrouve le message.
$('kt-sealed-in').value = sealed.slice(0, 10) + '\n' + sealed.slice(10) + '\n';
$('kt-open').click();
await waitFor(() => $('kt-plain-out').value !== '', 'message déchiffré');
assert($('kt-plain-out').value === 'Bonjour, partie à 21 h ?', 'le message d’origine est retrouvé');
assert(/✓/.test(status('kt-open-status')), 'déchiffrement annoncé réussi');

// 4. Le cas qui compte : un texte chiffré avec une AUTRE clé.
$('kt-sealed-in').value = fakeSeal(KEY_A, 'secret du club');
$('kt-open').click();
await waitFor(() => /✗/.test(status('kt-open-status')), 'échec annoncé');
assert($('kt-plain-out').value === '', 'rien n’est affiché comme message déchiffré');
assert($('kt-open-status').classList.contains('key-test-bad'), 'échec affiché comme tel');

// 5. Changer de clé : ce même texte s'ouvre avec la bonne.
$('kt-key').value = 'k-1';
$('kt-key').dispatchEvent(new dom.window.Event('change'));
await waitFor(() => $('kt-fingerprint').textContent === KEY_A.slice(0, 16), 'empreinte de la clé Club');
assert($('kt-sealed-out').value === '' && status('kt-open-status') === '',
    'changer de clé efface les résultats de la précédente');
$('kt-open').click();
await waitFor(() => $('kt-plain-out').value === 'secret du club', 'ouvert avec la bonne clé');
assert(/✓/.test(status('kt-open-status')), 'avec la bonne clé, le déchiffrement réussit');

// 6. Texte abîmé, champs vides : un message, jamais une exception.
$('kt-sealed-in').value = 'pas du base64 !!';
$('kt-open').click();
await waitFor(() => /✗/.test(status('kt-open-status')), 'texte abîmé refusé');
$('kt-plain').value = '';
const sealsBefore = invokeCalls.filter(c => c.cmd === 'seal_text').length;
$('kt-seal').click();
await sleep(50);
assert(invokeCalls.filter(c => c.cmd === 'seal_text').length === sealsBefore,
    'message vide : rien n’est envoyé à chiffrer');
assert(status('kt-seal-status') !== '' && $('kt-seal-status').classList.contains('key-test-bad'),
    'message vide : on le dit');

// 7. Fenêtre déjà ouverte, nouveau clic « Test » sur une autre clé dans le
//    hub : l'événement relayé la sélectionne.
for (const fn of eventHandlers['keyTestSelect'] || []) await fn({ payload: { id: 'k-2' } });
await waitFor(() => $('kt-key').value === 'k-2' && $('kt-fingerprint').textContent === KEY_B.slice(0, 16),
    'keyTestSelect sélectionne la clé demandée');
assert(true, 'keyTestSelect : la fenêtre déjà ouverte suit le bouton Test du hub');

// 8. Une clé enregistrée PENDANT que la fenêtre est ouverte apparaît au
//    retour du focus (la fenêtre relit le store).
storeData.set('community-keys', [...storeData.get('community-keys'), { id: 'k-4', name: 'Tournoi', key: 'c'.repeat(64) }]);
dom.window.dispatchEvent(new dom.window.Event('focus'));
await waitFor(() => [...$('kt-key').options].some(o => o.value === 'k-4'), 'clé ajoutée visible');
assert($('kt-key').value === 'k-2', 'relire les clés ne change pas la sélection en cours');

// 9. Plus aucune clé : on le dit, et les boutons sont désactivés.
storeData.set('community-keys', []);
dom.window.dispatchEvent(new dom.window.Event('focus'));
await waitFor(() => $('kt-nokey').style.display !== 'none', 'message « aucune clé »');
assert($('kt-seal').disabled && $('kt-open').disabled, 'sans clé, Chiffrer et Déchiffrer sont désactivés');
assert($('kt-fingerprint').textContent === '', 'pas d’empreinte sans clé');

console.log(`\ntest-key-test: ${passed} assertions OK`);
process.exit(0);
