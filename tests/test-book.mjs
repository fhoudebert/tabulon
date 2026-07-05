// tests/test-book.mjs — valide "Ouvrir un livre" de bout en bout côté JS :
//   1. ExtractMoves : nettoyage des coups SAN (commentaires, variantes,
//      numéros, \r\n Windows, résultat) — la partie fragile du parsing
//   2. book.js : store → parse_pjn (mock Rust) → liste → clic → fork book
//   3. play.js : rejeu du livre via pickMove/playMove (match Jocly factice),
//      partie en pause, footer "White vs Black"
// Usage : npm test  (ou node tests/test-book.mjs)
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
const storeData = new Map();
const PGN_TEXT = '[White "Kasparov"]\r\n[Black "Topalov"]\r\n[Result "1-0"]\r\n\r\n' +
  '1. e4 {le meilleur coup} e5 2. Nf3 (2. f4 exf4) Nc6 3. Bb5+ $1 1-0\r\n';

const mockTauri = {
  core: { invoke: async (cmd, payload = {}) => {
      invokeCalls.push({ cmd, payload });
      if (cmd === 'parse_pjn') return [{
        label: 'Kasparov vs Topalov - 1-0 #1',
        text: PGN_TEXT.replace(/\r\n/g, '\n'),
        playerA: 'Kasparov', playerB: 'Topalov',
        tags: { White: 'Kasparov', Black: 'Topalov', Result: '1-0' },
      }];
      return null;
  } },
  event: { listen: async () => () => {}, emit: async () => {} },
  window:{ getCurrentWindow: () => ({ label: 'book', close: () => {} }) },
  os:    { platform: async () => 'linux' },
  shell: { open: async () => {} },
  dialog:{ save: async () => null },
  store: { Store: class { static async load() { return {
      get: async (k) => storeData.get(k), set: async (k, v) => { storeData.set(k, v); },
      delete: async (k) => { storeData.delete(k); },
  }; } } },
};

// ═══ 1 + 2 : fenêtre book (vrai book.html + vrai book.js) ═══
{
  const html = readFileSync('./app/content/book.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/book.html?game=classic-chess&file=test.pgn' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  dom.window.__TAURI__ = mockTauri;
  globalThis.Jocly = { getGameConfig: async () => ({ model: { 'title-en': 'Chess' } }) };

  storeData.set('book:classic-chess', { fileName: 'test.pgn', data: PGN_TEXT });

  const mod = await import('../app/content/book.js');
  document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));

  // 1. ExtractMoves — cœur du parsing des coups
  const mv = mod.ExtractMoves(PGN_TEXT);
  assert(JSON.stringify(mv) === JSON.stringify(['e4','e5','Nf3','Nc6','Bb5+']),
    'ExtractMoves : \\r\\n, commentaires {}, variantes (), numéros collés, NAG et résultat filtrés → ' + mv.join(' '));
  assert(mod.ExtractMoves('1.d4 d5 2.c4 *').join(' ') === 'd4 d5 c4', 'ExtractMoves sans tags ni décorations');

  // Fichier réel remonté par l'utilisateur (notation longue Jocly, produit
  // par "Save book") : 8 coups dont une prise 'e5xd4'
  const real = readFileSync('./tests/fixtures-classic-chess2.pjn', 'utf-8');
  const fromFile = mod.ExtractMoves(real);
  assert(fromFile.join(' ') === 'e2-e4 Ng8-f6 Nb1-c3 Nb8-c6 Ng1-f3 e7-e5 d2-d4 e5xd4',
    'pjn réel : 8 coups en notation longue extraits (' + fromFile.join(' ') + ')');

  // 2. Fenêtre : parse_pjn appelé, partie listée, clic → fork book + new_match
  await waitFor(() => document.querySelectorAll('.book-content li').length === 1, 'partie listée');
  assert(invokeCalls.some(c => c.cmd === 'parse_pjn' && c.payload.data === PGN_TEXT),
    'contenu du store transmis à la commande Rust parse_pjn');
  const li = document.querySelector('.book-content li');
  assert(li.textContent.includes('Kasparov vs Topalov'), 'libellé de partie affiché');
  li.click();
  await waitFor(() => invokeCalls.some(c => c.cmd === 'new_match'), 'new_match lancé');
  const nm = invokeCalls.find(c => c.cmd === 'new_match');
  const forkKey = 'fork:' + nm.payload.forkId;
  const fork = storeData.get(forkKey);
  assert(fork?.book?.moves?.length === 5 && fork.book.playerA === 'Kasparov',
    'payload book (5 coups + joueurs) déposé sous ' + forkKey);
  assert(typeof nm.payload.forkId === 'string',
    'forkId envoyé en String (contrat Rust fork_id: Option<String> — un u32 rejetait l\'invoke en silence)');
}

// ═══ 3 : rejeu dans play.js (vrai play.js, match Jocly factice) ═══
{
  const PLAYER_A = 1, PLAYER_B = -1;
  const match = {
    turn: PLAYER_A, playedMoves: [], picked: [],
    async getConfig()      { return { model: { levels: [] }, view: { skins: [] } }; },
    async attachElement()  {},
    async getTurn()        { return this.turn; },
    async getPlayedMoves() { return [...this.playedMoves]; },
    async getViewOptions() { return {}; },
    async setViewOptions() {},
    async abortUserTurn()  { const p = this.pendingUserTurn; this.pendingUserTurn = null; p?.reject(new Error('User input aborted')); },
    async abortMachineSearch() {},
    userTurn() { return new Promise((resolve, reject) => { this.pendingUserTurn = { resolve, reject }; }); },
    async pickMove(tok) {
      // 'Bb5+' n'est résolu qu'une fois la décoration retirée (teste le retry)
      if (/[+#!?]$/.test(tok)) return null;
      this.picked.push(tok);
      return { san: tok };
    },
    async playMove(m) { this.playedMoves.push(m.san); this.turn = -this.turn; },
    async save() { return {}; }, async load() {},
    async viewControl() {}, async getBoardState() { return 'FEN'; },
  };

  const bookId = 'book-test';
  storeData.set('fork:' + bookId, { book: { moves: ['e4','e5','Nf3','Nc6','Bb5+'], playerA: 'Kasparov', playerB: 'Topalov' } });

  const html = readFileSync('./app/content/play.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { url: `https://tauri.localhost/content/play.html?game=classic-chess&id=9&fork=${bookId}` });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.FileReader = dom.window.FileReader;
  dom.window.__TAURI__ = mockTauri;
  globalThis.Jocly = {
    PLAYER_A, PLAYER_B,
    getGameConfig: async () => ({ model: { 'title-en': 'Chess', levels: [] }, view: {} }),
    createMatch:   async () => match,
  };

  await import('../app/content/play.js');
  document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));

  await waitFor(() => match.playedMoves.length === 5, 'rejeu terminé');
  assert(match.playedMoves.join(' ') === 'e4 e5 Nf3 Nc6 Bb5',
    'les 5 coups rejoués via pickMove/playMove (décoration + retirée au retry)');
  assert(!storeData.has('fork:' + bookId), 'payload book nettoyé du store après rejeu');
  await waitFor(() => document.getElementById('board-footer-text').textContent.includes('Kasparov'), 'footer');
  assert(document.getElementById('board-footer-text').textContent === 'Kasparov vs Topalov',
    'footer "White vs Black" affiché, partie en pause pour navigation via History');
}

console.log(`\n${passed} assertions OK — flux livre validé.`);
process.exit(0);
