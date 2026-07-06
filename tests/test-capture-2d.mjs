// tests/test-capture-2d.mjs — valide sur le vrai play.js :
//   - skin 2D courant → boutons Take snapshot et Record video GRISÉS avec un
//     tooltip explicatif (jocly rejette "Snapshot only available on 3D views";
//     avant : clic sans effet et erreur console, dialogue jamais ouvert)
//   - bascule vers un skin 3D → boutons réactivés (et retour 2D → regrisés)
//   - boutons rapides Take back / Restart à côté des skins (barre masquée) :
//     proxys vers les handlers de la barre (rollback observé sur le match)
// Usage : npm test  (ou node tests/test-capture-2d.mjs)
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
const mockTauri = {
  core: { invoke: async (cmd, payload = {}) => { invokeCalls.push({ cmd, payload }); return null; } },
  event: { listen: async () => () => {}, emit: async () => {} },
  window:{ getCurrentWindow: () => ({ label: 'play-12', close: () => {} }) },
  os:    { platform: async () => 'linux' },
  shell: { open: async () => {} },
  dialog:{ save: async () => null },
  store: { Store: class { static async load() { return {
      get: async () => undefined, set: async () => {}, delete: async () => {},
  }; } } },
};

const PLAYER_A = 1, PLAYER_B = -1;
const match = {
  turn: PLAYER_A, playedMoves: ['a', 'b'], rollbacks: [],
  async getConfig() { return { model: { levels: [] }, view: { skins: [
      { name: 'flat',  title: 'Classic 2D' },              // pas de '3d' → 2D
      { name: 'glass', title: 'Glass 3D', '3d': true },
  ] } }; },
  async attachElement()  {},
  async getTurn()        { return this.turn; },
  async getPlayedMoves() { return [...this.playedMoves]; },
  async getViewOptions() { return { skin: 'flat' }; },
  async setViewOptions() {},
  async rollback(n)      { this.rollbacks.push(n); this.playedMoves = this.playedMoves.slice(0, n); },
  async abortUserTurn()  { this.pendingUserTurn?.reject(new Error('User input aborted')); this.pendingUserTurn = null; },
  async abortMachineSearch() {},
  userTurn() { return new Promise((resolve, reject) => { this.pendingUserTurn = { resolve, reject }; }); },
  async save() { return {}; }, async load() {}, async viewControl() { return null; },
};

// WebGL "supporté" pour que le skin 3D reste dans la liste
const html = readFileSync('./app/content/play.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/play.html?game=classic-chess&id=12' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.FileReader = dom.window.FileReader;
dom.window.__TAURI__ = mockTauri;
dom.window.WebGLRenderingContext = function () {};
dom.window.HTMLCanvasElement.prototype.getContext = () => ({});
globalThis.Jocly = {
  PLAYER_A, PLAYER_B,
  getGameConfig: async () => ({ model: { 'title-en': 'Chess', levels: [] }, view: {} }),
  createMatch:   async () => match,
};

await import('../app/content/play.js');
document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));
await waitFor(() => match.pendingUserTurn, 'partie démarrée');

const snap  = () => document.getElementById('button-snapshot');
const video = () => document.getElementById('button-video');
const skinSel = () => document.getElementById('select-skin');

// 0. Le bouton Record video existe dans la barre (hunk perdu à l'intégration)
assert(!!video() && video().querySelector('.icon-video'),
  'bouton Record video présent dans la barre (régression corrigée)');

// 1. Skin courant 2D ('flat') → capture et vidéo grisées, tooltip explicatif
await waitFor(() => snap().disabled, 'garde 2D appliquée');
assert(snap().disabled && video().disabled, 'skin 2D → Take snapshot et Record video désactivés');
assert(snap().title === video().title && /3D/.test(snap().title),
  `tooltip explicatif ("${snap().title}") au lieu d'une erreur au clic`);

// 2. Sélecteur peuplé (2 skins) et bascule vers la 3D → réactivés
assert(skinSel().options.length === 2, 'sélecteur de skins peuplé (2D + 3D)');
skinSel().value = 'glass';
skinSel().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await waitFor(() => !snap().disabled, 'skin 3D → boutons réactivés');
assert(!video().disabled, 'vidéo réactivée en 3D');

// 3. Retour 2D → regrisés
skinSel().value = 'flat';
skinSel().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await waitFor(() => snap().disabled, 'retour 2D → regrisés');
assert(video().disabled, 'garde suivie sur chaque changement de skin');

// 4. Boutons rapides à côté des skins (masqués avec la barre, comme les selects)
const wrap = document.getElementById('quick-actions-wrap');
assert(wrap && wrap.classList.contains('player-select-wrap'),
  'actions rapides dans un player-select-wrap (exclusion barre/footer héritée)');
document.getElementById('quick-restart').click();
await waitFor(() => match.rollbacks.includes(0), 'restart');
assert(match.rollbacks.at(-1) === 0, 'quick Restart → rollback(0) via le handler de la barre');
match.playedMoves = ['a', 'b'];
document.getElementById('quick-takeback').click();
await waitFor(() => match.rollbacks.length >= 2, 'takeback');
assert(match.rollbacks.at(-1) === 1, 'quick Take back → rollback (reprise du dernier coup)');

console.log(`\n${passed} assertions OK — garde 2D + actions rapides validées.`);
process.exit(0);
