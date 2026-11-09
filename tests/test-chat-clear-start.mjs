// test-chat-clear-start.mjs — le bouton « clé barrée » de la fenêtre de conversation.
//
// LE CAS : la partie porte une clé (celle de la communauté choisie, ou celle
// de l'invitation), mais le correspondant n'en a échangé aucune avec nous.
// Le bouton permet d'écrire sans protection d'emblée, au lieu d'attendre
// qu'il écrive en clair le premier. Discret, à côté de la liste des clés, et
// seulement quand il a un sens.
//
// La fenêtre n'affiche que ce que play.js lui pousse : on lui envoie ici les
// états possibles et on regarde ce qu'elle montre et ce qu'elle demande.
//
// Usage : node tests/test-chat-clear-start.mjs   (depuis tabulon/)
import { JSDOM } from '../app/node_modules/jsdom/lib/api.js';
import { completeTauriInjection } from './helpers/tauri-mock.mjs';
process.chdir(new URL('..', import.meta.url).pathname);
import { readFileSync } from 'fs';

const bus = {};
const emitted = [];
const mockTauri = {
    core: { invoke: async () => null },
    event: {
        listen: async (name, fn) => { (bus[name] ??= []).push(fn); return () => {}; },
        emit:   async (name, payload) => { emitted.push({ name, payload }); },
    },
    window: { getCurrentWindow: () => ({ label: 'chat-5', close: () => {}, setTitle: async () => {} }) },
    os:     { platform: async () => 'linux', locale: async () => 'en-US' },
};

const html = readFileSync('./app/content/chat.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/chat.html?id=5' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
dom.window.__TAURI__ = completeTauriInjection(mockTauri);
let confirmAnswer = true, confirmText = null;
dom.window.confirm = (msg) => { confirmText = msg; return confirmAnswer; };

await import('../app/content/chat.js');
document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));
const { t } = await import('../app/content/tabulon-i18n.js');

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
const shown = (id) => $(id).style.display !== 'none';
await waitFor(() => bus['play-event:5:chat'], 'la fenêtre écoute play.js');
const push = (p) => bus['play-event:5:chat'].forEach(fn => fn({ payload: {
    conversation: [], canWrite: true, keyring: [], keyringId: null, chatKey: null, ...p } }));
const KEYRING = [{ id: 'f1f1f1f1f1f1f1f1', name: 'Club' }];
const KEY = 'a'.repeat(64);

// 1. Partie protégée par une clé de communauté : le bouton est là, à côté
//    de la liste, discret (une icône, une infobulle).
push({ keyring: KEYRING, keyringId: 'f1f1f1f1f1f1f1f1', chatKey: KEY, canClearStart: true });
assert(shown('chat-keyring-row') && shown('chat-keyring'), 'la liste des clés est affichée');
assert(shown('chat-clear-start'), 'le bouton « clé barrée » est affiché');
assert($('chat-clear-start').parentElement === $('chat-keyring-row'), 'à côté de la liste des clés');
assert(!!$('chat-clear-start').querySelector('.icon-key-off') && $('chat-clear-start').textContent.trim() === '',
    'discret : une icône seule, sans libellé');
assert($('chat-clear-start').title === t('chat.clearStartHint'), 'son infobulle dit à quoi il sert');

// 2. Un clic demande confirmation ; refuser ne fait rien.
confirmAnswer = false;
$('chat-clear-start').click();
await sleep(30);
assert(confirmText === t('chat.clearStartConfirm'), 'la confirmation dit ce qu’on perd');
assert(!emitted.some(e => e.name === 'play-req:5:chat-allow-clear'), 'refusée : rien n’est demandé à la partie');

// 3. Accepter demande la bascule à play.js — la même que « Continuer sans protection ».
confirmAnswer = true;
$('chat-clear-start').click();
await waitFor(() => emitted.some(e => e.name === 'play-req:5:chat-allow-clear'), 'bascule demandée');
assert(true, 'acceptée : play-req:chat-allow-clear est envoyé');

// 4. Bascule faite : le bouton disparaît, et la fenêtre dit que la conversation n'est plus protégée.
push({ keyring: KEYRING, keyringId: 'f1f1f1f1f1f1f1f1', chatKey: KEY, canClearStart: false, clearOn: true });
assert(!shown('chat-clear-start'), 'après la bascule, le bouton n’est plus proposé');
assert($('chat-key-hint').textContent === t('chat.clearOn'), 'et l’aide dit « conversation sans protection »');

// 5. Clé d'invitation, AUCUNE clé de communauté : bouton seul sur sa ligne,
//    et la saisie manuelle d'une clé reste disponible (elle était cachée à
//    tort dès qu'une liste, même vide, existait).
push({ keyring: [], chatKey: KEY, canClearStart: true });
assert(shown('chat-keyring-row') && !shown('chat-keyring') && shown('chat-clear-start'),
    'sans trousseau : le bouton est là, sans liste vide à côté');
assert(shown('chat-key-row'), 'sans trousseau, la saisie manuelle d’une clé est affichée');

// 6. Partie déjà en clair (aucune clé) : rien à abandonner, pas de bouton.
push({ keyring: [], chatKey: null, canClearStart: false });
assert(!shown('chat-clear-start') && !shown('chat-keyring-row'), 'partie sans clé : ni bouton ni ligne vide');
assert(shown('chat-key-row'), 'la saisie manuelle reste proposée');

// 7. Fil plein : plus rien à régler, la ligne reste fermée.
push({ keyring: KEYRING, chatKey: KEY, canClearStart: false, canWrite: false, chatFull: true });
assert(!shown('chat-keyring-row'), 'fil plein : la ligne des clés reste fermée');

console.log(`\ntest-chat-clear-start: ${passed} assertions OK`);
process.exit(0);
