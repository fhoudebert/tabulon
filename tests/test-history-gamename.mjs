// tests/test-history-gamename.mjs — le jeu ecrit par "Save book".
//
// Regression : la commande Rust open_history construisait l'URL
// "history.html?id={n}" SANS le jeu, et history.js retombait sur un defaut
// 'classic-chess'. Apres avoir charge une solution de chu-shogi, "Save book"
// proposait "classic-chess.pjn" et ecrivait [JoclyGame "classic-chess"] :
// le fichier obtenu tentait ensuite de s'ouvrir dans les echecs et les coups
// etaient refuses des le premier.
//
// On verifie ici le chemin qui fait AUTORITE et ne depend pas d'un rebuild
// Rust : le jeu annonce par play.js dans sa reponse get-played-moves. L'URL
// est volontairement laissee sans parametre "game" — la fenetre doit quand
// meme sauvegarder au bon nom.
// Usage : npm test  (ou node tests/test-history-gamename.mjs)
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
const saveDialogArgs = [];
const bus = {};

const mockTauri = {
  core:  { invoke: async (cmd, payload = {}) => { invokeCalls.push({ cmd, payload }); return null; } },
  event: {
    listen: async (name, fn) => { (bus[name] ??= []).push(fn); return () => {}; },
    emit:   async (name, payload) => { (bus[name] || []).forEach(fn => fn({ payload })); },
  },
  window: { getCurrentWindow: () => ({ label: 'history-7', close: () => {} }) },
  os:     { platform: async () => 'linux', locale: async () => 'en-US' },
  shell:  { open: async () => {} },
  dialog: { save: async (opts) => { saveDialogArgs.push(opts); return '/tmp/es3.pjn'; } },
  store:  { Store: class { static async load() { return { get: async () => undefined, set: async () => {} }; } } },
};

// Le probleme de chu-shogi charge depuis es3-solution.json, tel que play.js
// le rapporte : les coups, la position de depart, et le jeu du match.
const FEN = '8+lc1l/7+h2ok/4+H3Q3/9Fg1/11p/9D2/12/12/12/12/4+L7/10K1 w - - 0 1';
await mockTauri.event.listen('play-req:7:get-played-moves', () =>
  mockTauri.event.emit('play-rep:7:get-played-moves', {
    moves: ['FLj9-k10+', 'Gk9xk10', 'DKj7-j9=+DK+'],
    initialBoard: FEN,
    gameName: 'chu-shogi',
  }));

const html = readFileSync('./app/content/history.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
// URL SANS "game=" : c'est le scenario de la regression.
const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/history.html?id=7' });
globalThis.window   = dom.window;
globalThis.document = dom.window.document;
dom.window.__TAURI__ = mockTauri;
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
globalThis.Jocly = { getGameConfig: async () => ({ model: { 'title-en': 'Chu Shogi' } }) };

await import('../app/content/history.js');
document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));

const btn = (a) => document.querySelector(`.toolbar-actions button[data-action=${a}]`);
await waitFor(() => document.querySelectorAll('#moves .move').length === 3, 'coups affichés');

btn('save').click();
await waitFor(() => invokeCalls.some(c => c.cmd === 'save_text_file'), 'save_text_file invoqué');
const sv = invokeCalls.find(c => c.cmd === 'save_text_file');

// Nom proposé SANS extension : c'est le dialogue natif qui ajoute celle du
// filtre choisi, et qui la remplace quand on passe de PJN à PGN. La figer ici
// obligeait à la corriger à la main après avoir changé de format.
assert(saveDialogArgs[0]?.defaultPath === 'chu-shogi',
  'nom de fichier proposé = le jeu du match, sans extension — trouvé : ' + saveDialogArgs[0]?.defaultPath);
assert(saveDialogArgs[0]?.filters?.length === 2,
  'deux filtres distincts, PJN et PGN — c\'est là que le format se choisit');
assert(sv.payload.contents.includes('[JoclyGame "chu-shogi"]'),
  'tag [JoclyGame] = le jeu du match, pas le defaut classic-chess');
assert(!sv.payload.contents.includes('classic-chess'),
  'aucune trace du defaut historique dans le fichier');
assert(sv.payload.contents.includes('[FEN "' + FEN + '"]') && sv.payload.contents.includes('[SetUp "1"]'),
  'la position du probleme est ecrite — sans elle les coups seraient introuvables au rechargement');

// Les fenetres de position doivent viser le meme jeu.
btn('position').click();
btn('showpos').click();
await sleep(50);
assert(invokeCalls.some(c => c.cmd === 'open_position' && c.payload.gameName === 'chu-shogi'),
  '"Load board state" ouvre le bon jeu');
assert(invokeCalls.some(c => c.cmd === 'open_show_position' && c.payload.gameName === 'chu-shogi'),
  '"Display board state" ouvre le bon jeu');

// Tags d'identification : les deux cotes sont humains (solution rejouee), donc
// [White]/[Black] sont omis -- "Human vs Human" masquerait [Event] a la
// relecture sans rien apprendre. [Event] porte le nom du fichier choisi.
assert(sv.payload.contents.includes('[Event "es3"]'),
  '[Event] = nom du fichier choisi dans le dialogue');
assert(!/\[(White|Black)\b/.test(sv.payload.contents),
  'deux humains -> pas de tag [White]/[Black] sans information');
assert(!sv.payload.contents.includes('[Result'),
  'partie non terminee -> pas de [Result] invente');

// Aller-retour : ce que "Save book" ecrit doit se relire comme du chu-shogi.
{
  const { BookGame, BookFen, ExtractMoves } = await import('../app/content/book-format.js');
  const tags = {};
  for (const line of sv.payload.contents.split('\n')) {
    const m = /^\s*\[(\S+)\s+(.*)\]\s*$/.exec(line.trim());
    if (m) tags[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  assert(BookGame(tags) === 'chu-shogi', 'le hub rouvrirait ce fichier en chu-shogi');
  assert(BookFen(tags) === FEN, 'la position relue est identique');
  assert(ExtractMoves(sv.payload.contents).join(' ') === 'FLj9-k10+ Gk9xk10 DKj7-j9=+DK+',
    'les coups relus sont identiques');
  const { BookLabel } = await import('../app/content/book-format.js');
  assert(BookLabel(tags, { pliesLabel: 'coups' }) === 'es3 — 3 coups',
    'la fenetre livre l\'annoncerait "es3 — 3 coups", plus jamais "? vs ?"');
}

console.log(`\n${passed} assertions OK — jeu correct dans le PJN sauvegardé.`);
process.exit(0);
