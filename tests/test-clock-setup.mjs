// test-clock-setup.mjs — reproduit puis valide le fix du bouton Play grisé.
//
// Exécute le VRAI clock-setup.js contre le VRAI clock-setup.html (jsdom),
// avec le vrai dist jocly2 et window.__TAURI__ mocké.
// Usage : node test-clock-setup.mjs   (depuis tabulon/)
import { JSDOM } from '../app/node_modules/jsdom/lib/api.js';
process.chdir(new URL('..', import.meta.url).pathname);   // cwd = racine tabulon/
import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const invokeCalls = [];
const storeData = new Map();
let windowClosed = false;

const mockTauri = {
  core:  { invoke: async (cmd, payload = {}) => { invokeCalls.push({ cmd, payload }); return null; } },
  event: { listen: async () => () => {}, emit: async () => {} },
  window:{ getCurrentWindow: () => ({ label: 'clock-setup', close: () => { windowClosed = true; } }) },
  os:    { platform: async () => 'linux' },
  store: { Store: class { static async load() { return {
      get:  async (k) => storeData.get(k),
      set:  async (k, v) => { storeData.set(k, v); },
      save: async () => {},
  }; } } },
};

const html = readFileSync('./app/content/clock-setup.html', 'utf-8')
  .replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/clock-setup.html?game=classic-chess' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
dom.window.__TAURI__ = mockTauri;
const BASE = 'https://tauri.localhost/';
dom.window.BrowserScriptLoader = {
  getBaseURL: () => BASE,
  import: (p) => Promise.resolve(require('../dist/node/' + p)),
};
globalThis.Jocly = require('../dist/node/jocly.core.js');

await import('../app/content/clock-setup.js');
document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return; await sleep(25); }
  throw new Error('timeout: ' + what);
}
const $ = (s) => document.querySelector(s);
let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
  console.log('  ✓ ' + msg); passed++;
}
const fire = (el, type) => el.dispatchEvent(new dom.window.Event(type, { bubbles: true }));

// 1. BUG D'ORIGINE : au chargement (valeurs par défaut 5 min valides),
//    le bouton Play doit être ACTIF — il restait grisé avant le fix.
await waitFor(() => $('.group-same input.time').value === '5', 'formulaire initialisé');
const play = $('#button-save');
assert(!play.classList.contains('disabled') && !play.disabled,
  'bouton Play actif au chargement avec les valeurs par défaut (bug corrigé)');

// 2. Clic Play → new_match(gameName, clock) avec le bon payload
play.click();
await waitFor(() => invokeCalls.some(c => c.cmd === 'new_match'), 'new_match envoyé');
const nm = invokeCalls.find(c => c.cmd === 'new_match');
assert(nm.payload.gameName === 'classic-chess', 'new_match sur le bon jeu');
const clock = nm.payload.clock;
assert(clock && clock.mode === 'countdown', 'clock.mode = countdown');
assert(clock['1'] === 300000 && clock['-1'] === 300000, '5 min × 60 → 300000 ms pour les deux joueurs');
assert(clock['xtrasec_1'] === 0 && clock['mps_1'] === 0, 'xtrasec/mps par défaut = 0');
await waitFor(() => windowClosed, 'fenêtre fermée après Play');
assert(true, 'fenêtre clock-setup fermée après lancement');
assert(storeData.get('clock')?.symmetry === 'same', 'réglages persistés dans le store');

// 3. Saisie invalide → Play regrisé ; saisie corrigée → réactivé
windowClosed = false;
$('.group-same input.time').value = 'abc';
fire($('.group-same input.time'), 'input');
assert(play.classList.contains('disabled') && play.disabled, 'time invalide → Play grisé');
play.click();
assert(invokeCalls.filter(c => c.cmd === 'new_match').length === 1, 'clic sur Play grisé : aucun new_match');
$('.group-same input.time').value = '30';
fire($('.group-same input.time'), 'input');
assert(!play.disabled, 'time corrigé → Play réactivé');

// 4. Mode "different" : horloges distinctes par joueur
$('.symmetry').value = 'different';
fire($('.symmetry'), 'change');
assert(!play.disabled, 'mode different : Play actif (défauts 5 min des deux joueurs)');
$('.group-different.player0 input.time').value = '10';   // A: 10 min
$('.group-different.player1 input.time').value = '3';    // B: 3 min
$('.group-different.player1 input.xtrasec').value = '2'; // B: +2 s/coup
fire($('.group-different.player1 input.xtrasec'), 'input');
play.click();
await waitFor(() => invokeCalls.filter(c => c.cmd === 'new_match').length === 2, '2e new_match');
const clock2 = invokeCalls.filter(c => c.cmd === 'new_match')[1].payload.clock;
assert(clock2['1'] === 600000, 'joueur A : 10 min = 600000 ms');
assert(clock2['-1'] === 180000, 'joueur B : 3 min = 180000 ms');
assert(clock2['xtrasec_-1'] === 2 && clock2['xtrasec_1'] === 0, 'xtrasec par joueur correct');

console.log(`\n${passed} assertions OK — clock-setup validé.`);
process.exit(0);
