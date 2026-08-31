// tests/test-hub-loadfile.mjs — chargement d'un fichier de partie depuis le hub.
//
// Regression : OpenGameFile() appelait g(), une fonction definie DANS
// InitDetailButtons() et donc invisible depuis la portee du module. Tout
// chargement de fichier echouait sur "ReferenceError: Can't find variable: g",
// avale par le catch du FileReader -> rien ne se passait a l'ecran.
//
// On execute le vrai app/content/hub.js contre le vrai app/content/hub.html
// (jsdom), avec un Jocly reduit a listGames() : ce test n'a pas besoin du
// dist/ de jocly2, seulement d'un catalogue pour que ResolveGame() puisse
// verifier que le jeu declare par le fichier existe.
// Usage : npm test  (ou node tests/test-hub-loadfile.mjs)
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

// ── Mock Tauri ────────────────────────────────────────────────────────────────
const invokeCalls = [];
const storeData   = new Map();

// parse_pjn : meme decoupage que la commande Rust (tags + bloc de coups),
// reduit a ce dont hub.js se sert — les tags du premier match.
function parsePjn(data) {
  const blocks = String(data).replace(/\r\n?/g, '\n').split('\n\n')
    .map(b => b.trim()).filter(Boolean);
  if (!blocks.length || !blocks[0].startsWith('[')) return [];
  const tags = {};
  for (const line of blocks[0].split('\n')) {
    const m = /^\s*\[(\S+)\s+(.*)\]\s*$/.exec(line.trim());
    if (m) tags[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  let j = 1;
  while (j < blocks.length && !blocks[j].startsWith('[')) j++;
  return [{ label: 'test #1', text: blocks.slice(0, j).join('\n\n'), tags }];
}

const mockTauri = {
  core: {
    invoke: async (cmd, payload = {}) => {
      invokeCalls.push({ cmd, payload });
      if (cmd === 'get_app_info') return { name: 'Tabulon', version: 'test', homepage: '' };
      if (cmd === 'parse_pjn')    return parsePjn(payload.data);
      return null;
    },
  },
  event:  { listen: async () => () => {}, emit: async () => {} },
  window: { getCurrentWindow: () => ({ label: 'main', close: () => {} }) },
  os:     { platform: async () => 'linux', locale: async () => 'en-US' },
  shell:  { open: async () => {} },
  store:  { Store: class { static async load() { return {
      get:    async (k) => storeData.get(k),
      set:    async (k, v) => { storeData.set(k, v); },
      delete: async (k) => { storeData.delete(k); },
  }; } } },
};

const html = readFileSync('./app/content/hub.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/hub.html' });
globalThis.window   = dom.window;
globalThis.document = dom.window.document;
// hub.js utilise FileReader sans prefixe : dans un navigateur c'est un global,
// sous Node il faut le republier depuis jsdom.
globalThis.FileReader = dom.window.FileReader;
globalThis.File       = dom.window.File;
dom.window.__TAURI__ = mockTauri;

// Catalogue minimal : ResolveGame() ne retient un jeu declare que s'il y figure.
const game = (title) => ({ title, summary: title, thumbnail: 'thumb.png' });
globalThis.Jocly = {
  listGames:     async () => ({ 'chu-shogi': game('Chu Shogi'), 'rocaille': game('Rocaille'),
                                'classic-chess': game('Chess') }),
  getGameConfig: async () => { throw new Error('non utilise dans ce test'); },
};

// On capture les erreurs console : le bug d'origine n'y laissait qu'une trace.
const errors = [];
const realError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); realError(...a); };

await import('../app/content/hub.js');
document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));
await waitFor(() => document.querySelectorAll('#game-list li.list-group-item').length > 0,
  'liste des jeux rendue');

// Depose un fichier dans #fileElem et declenche l'evenement change, comme le
// ferait le selecteur natif.
async function DropFile(name, text) {
  const before = invokeCalls.length;
  const input = document.getElementById('fileElem');
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new dom.window.File([text], name, { type: 'text/plain' })],
  });
  input.dispatchEvent(new dom.window.Event('change'));
  await waitFor(() => invokeCalls.length > before || errors.length,
    'reaction au chargement de ' + name);
  await sleep(30);
  return invokeCalls.slice(before);
}

const notifierText = () => document.querySelector('.hub-notifier-text')?.textContent || '';

// ── 1. Solution JSON : le fichier dit de quel jeu il s'agit ───────────────────
console.log('Solution JSON (es3-solution.json)');
{
  const calls = await DropFile('es3-solution.json', readFileSync('./tests/fixtures/jocly/es3-solution.json', 'utf-8'));
  assert(!errors.some(e => /ReferenceError/.test(e)),
    'aucune ReferenceError (regression : g() hors de portee dans OpenGameFile)');
  const nm = calls.find(c => c.cmd === 'new_match');
  assert(nm, 'new_match appele');
  assert(nm.payload.gameName === 'chu-shogi', 'jeu pris DANS le fichier, aucune fiche selectionnee');
  const forkId = nm.payload.forkId || nm.payload.fork || Object.values(nm.payload).find(v => /^sol-/.test(String(v)));
  assert(/^sol-/.test(String(forkId)), 'un identifiant de fork sol-… est transmis');
  const fork = storeData.get('fork:' + forkId);
  assert(fork?.solution?.playedMoves?.length === 9, 'les 9 coups sont deposes dans le store pour play.js');
  assert(typeof fork.solution.initialBoard === 'string', 'la position du probleme accompagne les coups');
}

// ── 2. PJN Tabulon : tag [JoclyGame] ─────────────────────────────────────────
console.log('PJN avec [JoclyGame] (es3.pjn)');
{
  const text  = readFileSync('./tests/fixtures/jocly/es3.pjn', 'utf-8');
  const calls = await DropFile('es3.pjn', text);
  const ob = calls.find(c => c.cmd === 'open_book');
  assert(ob, 'open_book appele (fenetre livre)');
  assert(ob.payload.gameName === 'chu-shogi', 'jeu lu dans les tags du PJN');
  assert(storeData.get('book:chu-shogi')?.data === text,
    'le texte integral est depose sous book:{jeu} — book.js le relit tel quel');
}

// ── 3. PGN tiers : tag [Game] court, sans guillemets ─────────────────────────
console.log('PGN tiers avec [Game] (classic-chess)');
{
  const pgn = '[Event "Puzzle"]\n[Game classic-chess]\n[FEN "r3r3/1p5p w - - 8 25"]\n[SetUp "1"]\n\n25. Rf1+ Kg7 *\n';
  const calls = await DropFile('puzzle.pgn', pgn);
  const ob = calls.find(c => c.cmd === 'open_book');
  assert(ob?.payload.gameName === 'classic-chess', '[Game] suffit, aucune fiche selectionnee');
}

// ── 4. Fichier muet : message a l'ecran, pas d'echec silencieux ──────────────
console.log('Fichier sans indication de jeu');
{
  const before = invokeCalls.length;
  await DropFile('mystere.pjn', '[Date "2026.1.1"]\n\n1. a2-a3\n');
  assert(!invokeCalls.slice(before).some(c => c.cmd === 'open_book' || c.cmd === 'new_match'),
    'aucune partie ouverte au hasard');
  assert(/select a game first/i.test(notifierText()),
    'la banniere explique quoi faire — trouve : "' + notifierText().slice(0, 60) + '"');
}

// ── 5. Jeu declare mais absent du catalogue ─────────────────────────────────
console.log('Jeu declare non installe');
{
  const before = invokeCalls.length;
  await DropFile('inconnu.pjn', '[JoclyGame "jeu-inexistant"]\n\n1. a2-a3\n');
  assert(!invokeCalls.slice(before).some(c => c.cmd === 'open_book'),
    'pas d\'ouverture dans un jeu au hasard');
  assert(/not installed/i.test(notifierText()), 'la banniere distingue ce cas du precedent');
}

console.error = realError;
console.log(`\n${passed} assertions OK — chargement de fichier depuis le hub valide.`);
process.exit(0);
