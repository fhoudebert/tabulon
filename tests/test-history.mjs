// tests/test-history.mjs — valide les boutons de la fenêtre History qui ne
// marchaient pas : "Save book" (data: URI mort sous Tauri → dialogue natif +
// save_text_file), "Load board state" (mapping rpc fantôme → open_position)
// et "Display board state" (aucun handler → open_show_position), plus les
// nouveaux satellites get-board-state / load-board-state côté play (simulé).
// Usage : npm test  (ou node tests/test-history.mjs)
import { JSDOM } from '../app/node_modules/jsdom/lib/api.js';
process.chdir(new URL('..', import.meta.url).pathname);
import { readFileSync } from 'fs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return; await sleep(20); }
  throw new Error('timeout: ' + what);
}
let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
  console.log('  ✓ ' + msg); passed++;
}

const invokeCalls = [];
const bus = {};
let nextSavePath = '/tmp/livre.pjn';
const mockTauri = {
  core: { invoke: async (cmd, payload = {}) => { invokeCalls.push({ cmd, payload }); return null; } },
  event: {
    listen: async (name, fn) => { (bus[name] ??= []).push(fn); return () => {}; },
    emit:   async (name, payload) => { (bus[name] || []).forEach(fn => fn({ payload })); },
  },
  window:{ getCurrentWindow: () => ({ label: 'history-4', close: () => {} }) },
  os:    { platform: async () => 'linux' },
  shell: { open: async () => {} },
  dialog:{ save: async () => nextSavePath },
  store: { Store: class { static async load() { return { get: async () => undefined, set: async () => {} }; } } },
};

// Côté play.js simulé : répond à get-played-moves avec 3 coups
await mockTauri.event.listen('play-req:4:get-played-moves', () =>
  mockTauri.event.emit('play-rep:4:get-played-moves', { moves: ['e2-e4', 'e7-e5', 'Ng1-f3'] }));

const html = readFileSync('./app/content/history.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/history.html?game=classic-chess&id=4' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
dom.window.__TAURI__ = mockTauri;
dom.window.HTMLElement.prototype.scrollIntoView = function () {};   // absent de jsdom
globalThis.Jocly = { getGameConfig: async () => ({ model: { 'title-en': 'Chess' } }) };

await import('../app/content/history.js');
document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));

const btn = (a) => document.querySelector(`.toolbar-actions button[data-action=${a}]`);

// 0. Historique chargé (les autres boutons dépendent de moveCount)
await waitFor(() => document.querySelectorAll('#moves .move').length === 3, 'coups affichés');

// 1. Save book : dialogue natif + save_text_file, coups numérotés
btn('save').click();
await waitFor(() => invokeCalls.some(c => c.cmd === 'save_text_file'), 'save_text_file invoqué');
const sv = invokeCalls.find(c => c.cmd === 'save_text_file');
assert(sv.payload.path === '/tmp/livre.pjn', 'fichier écrit au chemin choisi (plus de data: URI)');
assert(sv.payload.contents.includes('1. e2-e4 e7-e5 2. Ng1-f3'),
  'coups numérotés PJN (relisibles par parse_pjn/pickMove)');
assert(sv.payload.contents.includes('[JoclyGame "classic-chess"]'), 'tags PJN présents');

// 2. Save annulé : aucune écriture
nextSavePath = null;
const n = invokeCalls.filter(c => c.cmd === 'save_text_file').length;
btn('save').click();
await sleep(150);
assert(invokeCalls.filter(c => c.cmd === 'save_text_file').length === n, 'dialogue annulé → rien écrit');

// 3. Load board state → open_position(game, matchId)
btn('position').click();
assert(invokeCalls.some(c => c.cmd === 'open_position' && c.payload.gameName === 'classic-chess' && c.payload.matchId === 4),
  '"Load board state" → open_position (fenêtre de saisie)');

// 4. Display board state → open_show_position(game, matchId)
btn('showpos').click();
assert(invokeCalls.some(c => c.cmd === 'open_show_position' && c.payload.matchId === 4),
  '"Display board state" → open_show_position');

// 5. show-position.js : récupère l'état via le satellite get-board-state
{
  await mockTauri.event.listen('play-req:4:get-board-state', () =>
    mockTauri.event.emit('play-rep:4:get-board-state', { state: 'rnbqkbnr/... w KQkq - 0 1' }));
  const shtml = readFileSync('./app/content/show-position.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
  const sdom = new JSDOM(shtml, { url: 'https://tauri.localhost/content/show-position.html?game=classic-chess&id=4' });
  globalThis.window = sdom.window;
  globalThis.document = sdom.window.document;
  sdom.window.__TAURI__ = mockTauri;
  await import('../app/content/show-position.js');
  sdom.window.document.dispatchEvent(new sdom.window.Event('DOMContentLoaded', { bubbles: true }));
  await waitFor(() => sdom.window.document.querySelector('textarea')?.value.startsWith('rnbqkbnr'), 'état affiché');
  assert(true, 'show-position affiche l\'état obtenu de play.js (satellite get-board-state)');
}

// 6. open-position.js : envoie load-board-state à play.js (match existant)
{
  let received = null;
  await mockTauri.event.listen('play-req:4:load-board-state', ({ payload }) => { received = payload; });
  const ohtml = readFileSync('./app/content/open-position.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
  const odom = new JSDOM(ohtml, { url: 'https://tauri.localhost/content/open-position.html?game=classic-chess&id=4' });
  globalThis.window = odom.window;
  globalThis.document = odom.window.document;
  odom.window.__TAURI__ = mockTauri;
  await import('../app/content/open-position.js');
  odom.window.document.dispatchEvent(new odom.window.Event('DOMContentLoaded', { bubbles: true }));
  // le <title> statique du HTML n'est pas vide : on attend la valeur
  // posée par twu.init, signe que le handler du bouton est attaché
  await waitFor(() => odom.window.document.title === 'Chess', 'init terminée (handler attaché)');
  odom.window.document.querySelector('input').value = '8/8/8/8/8/8/8/8 w - - 0 1';
  odom.window.document.getElementById('button-save').click();
  await waitFor(() => received, 'état transmis');
  assert(received.state === '8/8/8/8/8/8/8/8 w - - 0 1',
    'open-position → satellite load-board-state (le rpc fantôme est remplacé)');
}

// 7. open-position SANS match (bouton "État du plateau" du hub) : nouvelle
//    partie depuis l'état, via fork 'pos-…' (String) + new_match — le cas
//    "le bouton Open ne fait rien" (fork_id: Option<u32> rejetait l'id).
{
  const storeData = new Map();
  mockTauri.store.Store = class { static async load() { return {
      get: async (k) => storeData.get(k), set: async (k, v) => { storeData.set(k, v); },
  }; } };
  const ohtml = readFileSync('./app/content/open-position.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
  const odom = new JSDOM(ohtml, { url: 'https://tauri.localhost/content/open-position.html?game=classic-chess&id=' });
  globalThis.window = odom.window;
  globalThis.document = odom.window.document;
  odom.window.__TAURI__ = mockTauri;
  await import('../app/content/open-position.js?nomatch');   // module distinct (query)
  odom.window.document.dispatchEvent(new odom.window.Event('DOMContentLoaded', { bubbles: true }));
  await waitFor(() => odom.window.document.title === 'Chess', 'init');
  odom.window.document.querySelector('input').value = 'r1bqkb1r/pppp1ppp/2n2n2/8/3pP3/2N2N2/PPP2PPP/R1BQKB1R w KQkq - 0 5';
  const before = invokeCalls.length;
  odom.window.document.getElementById('button-save').click();
  await waitFor(() => invokeCalls.slice(before).some(c => c.cmd === 'new_match'), 'new_match');
  const nm = invokeCalls.slice(before).find(c => c.cmd === 'new_match');
  assert(typeof nm.payload.forkId === 'string' && nm.payload.forkId.startsWith('pos-'),
    'bouton Open (hub, sans match) → new_match avec forkId String "pos-…"');
  const fork = storeData.get('fork:' + nm.payload.forkId);
  assert(fork?.initialBoard?.startsWith('r1bqkb1r') && fork.game === 'classic-chess',
    'état FEN déposé sous fork:{id} ({game, playedMoves: [], initialBoard})');
}

console.log(`\n${passed} assertions OK — boutons History validés.`);
process.exit(0);
