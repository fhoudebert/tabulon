// test-clock.mjs — valide la fenêtre clock (était vide : RPC get_clock inexistant).
//
// Exécute le VRAI clock.js contre le VRAI clock.html (jsdom). Le côté play.js
// est simulé par un répondeur branché sur un bus d'events en mémoire qui
// reproduit le contrat émis par play.js (play-rep/play-event get-clock).
// Usage : node test-clock.mjs   (depuis tabulon/)
import { JSDOM } from './app/node_modules/jsdom/lib/api.js';
import { readFileSync } from 'fs';

// ── Bus d'events en mémoire (remplace le bus Tauri) ──────────────────────────
const bus = {};   // eventName -> [fn]
const mockTauri = {
  core:  { invoke: async () => null },
  event: {
    listen: async (name, fn) => { (bus[name] ??= []).push(fn); return () => {}; },
    emit:   async (name, payload) => { (bus[name] || []).forEach(fn => fn({ payload })); },
  },
  window:{ getCurrentWindow: () => ({ label: 'clock-7', close: () => {} }) },
  os:    { platform: async () => 'linux' },
  shell: { open: async () => {} },
  store: { Store: class { static async load() { return { get: async () => undefined, set: async () => {} }; } } },
};

// ── Côté play.js simulé : même contrat que ClockPayload()/EmitClock() ────────
const PLAYER_A = 1, PLAYER_B = -1;
let clock = { mode: 'countdown', 1: 300000, '-1': 300000, turn: PLAYER_A, t0: Date.now() };
const payload = () => ({
  players: { 1: { name: 'Player A' }, '-1': { name: 'Player B' } },
  clock,
});

const html = readFileSync('./app/content/clock.html', 'utf-8')
  .replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/clock.html?id=7' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
dom.window.__TAURI__ = mockTauri;
globalThis.Jocly = { PLAYER_A, PLAYER_B };

// Le répondeur play.js doit être branché AVANT que clock.js n'émette sa requête
await mockTauri.event.listen('play-req:7:get-clock', () =>
  mockTauri.event.emit('play-rep:7:get-clock', payload()));

await import('./app/content/clock.js');
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

// 1. La fenêtre n'est plus vide : noms + temps rendus après la réponse
await waitFor(() => $('#clock-player1')?.textContent === 'Player A', 'réponse get-clock appliquée');
assert($('#clock-player-1').textContent === 'Player B', 'noms des deux joueurs affichés');
assert($('#clock-time1').textContent.startsWith('4:5') || $('#clock-time1').textContent === '5:00',
  `temps A affiché en m:ss (${$('#clock-time1').textContent})`);
assert($('#clock-time-1').textContent === '5:00', 'temps B figé à 5:00 (pas au trait)');

// 2. Joueur au trait marqué (.turn sur son nom ET son temps)
assert($('#clock-player1').classList.contains('turn') && $('#clock-time1').classList.contains('turn'),
  'Player A au trait : classes .turn posées');
assert(!$('#clock-player-1').classList.contains('turn'), 'Player B pas au trait');

// 3. Compte à rebours en direct : le temps de A décroît via setInterval(100ms)
const before = $('#clock-time1').textContent;
await sleep(1200);
const after = $('#clock-time1').textContent;
assert(before !== after, `countdown vivant : ${before} → ${after}`);
assert(after < before || after.length < before.length, 'le temps décroît (countdown)');

// 4. Push update-clock (changement de tour émis par play.js) : B passe au trait
clock = { ...clock, 1: 287000, turn: PLAYER_B, t0: Date.now() };
await mockTauri.event.emit('play-event:7:update-clock', payload());
await waitFor(() => $('#clock-player-1').classList.contains('turn'), 'bascule de trait');
assert(!$('#clock-player1').classList.contains('turn'), 'A n\'est plus au trait');
assert($('#clock-time1').textContent === '4:47', 'temps de A figé à la valeur débitée (287000 → 4:47)');
const bBefore = $('#clock-time-1').textContent;
await sleep(1200);
assert($('#clock-time-1').textContent !== bBefore, 'le temps de B décroît maintenant');

// 5. Fin de partie : plus de turn → les deux temps figés, aucun .turn
clock = { mode: 'countdown', 1: 287000, '-1': 250000 };
await mockTauri.event.emit('play-event:7:update-clock', payload());
await sleep(300);
assert(!$('.players .turn') && !$('.times .turn'), 'fin de partie : aucun joueur au trait');
assert($('#clock-time-1').textContent === '4:10', 'temps B soldé (250000 → 4:10)');

// 6. CSS présent : les règles .clock-content existent dans tabulon.css
const css = readFileSync('./app/content/tabulon.css', 'utf-8');
assert(css.includes('.clock-content .times > div') && css.includes('"7segment"'),
  'styles .clock-content (police 7segment, layout table) présents dans tabulon.css');
assert(css.includes('.clock-content .players > div.turn'), 'style pastille noire du joueur au trait présent');

console.log(`\n${passed} assertions OK — fenêtre clock validée.`);
process.exit(0);
