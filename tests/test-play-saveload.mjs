// test-play-saveload.mjs — valide les boutons Save/Load de play.js et détecte
// la régression "double gameLoop" au chargement d'une partie.
//
// Exécute le VRAI play.js contre le VRAI play.html (jsdom). Jocly est mocké
// par un match factice (humain vs humain) qui joue le rôle de l'iframe :
// il détecte notamment les appels userTurn() concurrents — la signature de
// l'ancien bug de double boucle au Load.
// Usage : node test-play-saveload.mjs   (depuis tabulon/)
import { JSDOM } from '../app/node_modules/jsdom/lib/api.js';
process.chdir(new URL('..', import.meta.url).pathname);   // cwd = racine tabulon/
import { readFileSync } from 'fs';

// ── Mock Tauri : bus d'events en mémoire + dialog.save pilotable ─────────────
const bus = {};
const invokeCalls = [];
const storeData = new Map();
let nextSavePath = '/tmp/partie.json';   // ce que "l'utilisateur" choisit
const mockTauri = {
  core:  { invoke: async (cmd, payload = {}) => {
      invokeCalls.push({ cmd, payload });
      if (cmd === 'is_favorite') return false;
      return null;
  } },
  event: {
    listen: async (name, fn) => { (bus[name] ??= []).push(fn); return () => {}; },
    emit:   async (name, payload) => { (bus[name] || []).forEach(fn => fn({ payload })); },
  },
  window:{ getCurrentWindow: () => ({ label: 'play-3', close: () => {} }) },
  os:    { platform: async () => 'linux' },
  shell: { open: async () => {} },
  dialog:{ save: async () => nextSavePath },
  store: { Store: class { static async load() { return {
      get: async (k) => storeData.get(k), set: async (k, v) => { storeData.set(k, v); },
      delete: async () => {},
  }; } } },
};

// ── Match Jocly factice (humain vs humain) ────────────────────────────────────
const PLAYER_A = 1, PLAYER_B = -1;
const match = {
  turn: PLAYER_A,
  playedMoves: [],
  loadedWith: null,
  pendingUserTurn: null,     // {resolve, reject} du userTurn en attente
  overlappingUserTurns: 0,   // détecteur de double boucle
  async getConfig()      { return { model: { levels: [] }, view: { skins: [] } }; },
  async attachElement()  {},
  async getTurn()        { return this.turn; },
  async getPlayedMoves() { return [...this.playedMoves]; },
  async getViewOptions() { return {}; },
  async setViewOptions() {},
  async abortUserTurn()  {
    if (this.pendingUserTurn) {
      const p = this.pendingUserTurn; this.pendingUserTurn = null;
      p.reject(new Error('User input aborted'));
    }
  },
  async abortMachineSearch() {},
  userTurn() {
    if (this.pendingUserTurn) this.overlappingUserTurns++;   // ← double boucle !
    return new Promise((resolve, reject) => { this.pendingUserTurn = { resolve, reject }; });
  },
  async save() { return { game: 'testgame', playedMoves: [...this.playedMoves] }; },
  async load(data) {
    if (data.game && data.game !== 'testgame')
      throw new Error(`Trying to load ${data.game} to testgame match`);
    this.playedMoves = [...(data.playedMoves || [])];
    this.turn = this.playedMoves.length % 2 === 0 ? PLAYER_A : PLAYER_B;
    this.loadedWith = data;
  },
};
// Le test joue un coup "humain" en résolvant le userTurn en attente
function playHumanMove() {
  const p = match.pendingUserTurn;
  if (!p) throw new Error('aucun userTurn en attente');
  match.pendingUserTurn = null;
  match.playedMoves.push('m' + (match.playedMoves.length + 1));
  match.turn = -match.turn;
  p.resolve({ move: {}, finished: false, winner: null });
}

// ── DOM : vrai play.html ──────────────────────────────────────────────────────
const html = readFileSync('./app/content/play.html', 'utf-8')
  .replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/play.html?game=testgame&id=3' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.FileReader = dom.window.FileReader;   // play.js l'utilise en global
dom.window.__TAURI__ = mockTauri;
globalThis.Jocly = {
  PLAYER_A, PLAYER_B,
  getGameConfig: async () => ({ model: { 'title-en': 'Test Game', levels: [] }, view: {} }),
  createMatch:   async () => match,
};

// Capturer les payloads d'horloge émis par play.js
const clockEvents = [];
await mockTauri.event.listen('play-event:3:update-clock', ({ payload }) => clockEvents.push(payload));

await import('../app/content/play.js');
document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));

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

// 1. Boucle démarrée : un userTurn en attente, horloge démarrée (tour de A)
await waitFor(() => match.pendingUserTurn, 'boucle de jeu démarrée');
assert(clockEvents.length >= 1 && clockEvents[0].clock.turn === PLAYER_A,
  'ClockTurn : horloge démarrée sur Player A');
playHumanMove();
await waitFor(() => match.pendingUserTurn && clockEvents.some(e => e.clock.turn === PLAYER_B),
  'tour suivant');
assert(clockEvents.at(-1).clock.mode === 'countup', 'sans clocked play : horloge countup par défaut (comme JoclyBoard)');

// 1b. Bouton '…' : bascule barre ⟷ sélecteurs de joueurs (persistée).
// Le couplage est en CSS pur (.bar-visible masque .player-select-wrap) :
// on vérifie la classe + la présence de la règle CSS d'exclusion mutuelle.
const actions = document.querySelector('.ephemeral-actions');
assert(!actions.classList.contains('bar-visible'), 'barre masquée par défaut → joueurs A/B visibles');
{
  const css = readFileSync('./app/content/tabulon.css', 'utf-8');
  assert(css.includes('.ephemeral-actions.bar-visible .player-select-wrap { display: none; }'),
    'règle CSS : barre visible → sélecteurs de joueurs masqués');
}
document.getElementById('button-toggle-bar').click();
assert(actions.classList.contains('bar-visible'), 'clic … → barre visible');
document.getElementById('button-toggle-bar').click();
assert(!actions.classList.contains('bar-visible'), '2e clic … → barre masquée');
document.getElementById('button-toggle-bar').click();   // laisser visible pour cliquer Save
await waitFor(() => storeData.get('play-footer-bar') === true, 'état de la barre persisté');

// 2. SAVE : dialogue natif + commande Rust save_text_file (plus de data: URI)
document.getElementById('button-save').click();
await waitFor(() => invokeCalls.some(c => c.cmd === 'save_text_file'), 'save_text_file invoqué');
const sv = invokeCalls.find(c => c.cmd === 'save_text_file');
assert(sv.payload.path === '/tmp/partie.json', 'fichier écrit au chemin choisi dans le dialogue');
const saved = JSON.parse(sv.payload.contents);
assert(saved.game === 'testgame' && saved.playedMoves.length === 1,
  'contenu = match.save() sérialisé (1 coup joué)');

// 3. SAVE annulé : dialogue → null → aucune écriture
nextSavePath = null;
const nWrites = invokeCalls.filter(c => c.cmd === 'save_text_file').length;
document.getElementById('button-save').click();
await sleep(150);
assert(invokeCalls.filter(c => c.cmd === 'save_text_file').length === nWrites,
  'dialogue annulé : aucune écriture');

// 4. LOAD : charge une partie de 5 coups, la boucle CONTINUE sans se dédoubler
const fileElem = document.getElementById('fileElem');
const gameFile = new dom.window.File(
  [JSON.stringify({ game: 'testgame', playedMoves: ['a','b','c','d','e'] })],
  'partie.json', { type: 'application/json' });
Object.defineProperty(fileElem, 'files', { value: [gameFile], configurable: true });
fileElem.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

await waitFor(() => match.loadedWith?.playedMoves?.length === 5, 'partie chargée');
await waitFor(() => match.pendingUserTurn, 'boucle repartie sur la position chargée');
assert(match.turn === PLAYER_B, 'après 5 coups chargés : trait à Player B');
assert(document.getElementById('board-footer-text').textContent === '', 'footer nettoyé');

// On joue 3 coups pour laisser une éventuelle double boucle se manifester
for (let i = 0; i < 3; i++) { playHumanMove(); await waitFor(() => match.pendingUserTurn, 'coup ' + i); }
assert(match.overlappingUserTurns === 0,
  'AUCUN userTurn concurrent : pas de double gameLoop après Load (bug corrigé)');
assert(match.playedMoves.length === 8, 'la partie continue normalement (5 chargés + 3 joués)');

// 5. LOAD d'un fichier du mauvais jeu : message d'erreur, boucle intacte
const wrongFile = new dom.window.File(
  [JSON.stringify({ game: 'autrejeu', playedMoves: [] })], 'x.json');
Object.defineProperty(fileElem, 'files', { value: [wrongFile], configurable: true });
fileElem.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await waitFor(() => document.getElementById('board-footer-text').textContent.includes('Load failed'),
  'message d\'erreur affiché');
assert(match.playedMoves.length === 8, 'position intacte après échec du load');
await waitFor(() => match.pendingUserTurn, 'boucle toujours vivante');
assert(match.overlappingUserTurns === 0, 'toujours une seule boucle');

console.log(`\n${passed} assertions OK — save/load de play.js validés.`);
process.exit(0);
