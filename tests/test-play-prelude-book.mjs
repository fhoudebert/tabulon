// test-play-prelude-book.mjs — un fichier qui PORTE la reponse au prelude doit
// se relire telle qu'il a ete joue.
//
// Tabulon ecrit le choix d'ouverture dans ses propres fichiers. Une partie de
// MiniChess 5x5, dont le prelude choisit entre Gardner, Baby et Malett,
// commence ainsi :
//
//     1. #0 -- 2. c2-c3 a4-a3 3. b2xa3 d4xc3 ...
//
// « #0 » nomme l'arrangement et « -- » le passage de trait. Ce ne sont pas des
// coups a rejouer, et les traiter comme tels avait deux consequences, l'une
// visible et l'autre pas :
//
//   - ReplayBookMoves butait sur « #0 » des le premier jeton -- il ne designe
//     aucun coup legal une fois le prelude franchi -- donc zero coup joue et
//     le fichier declare illisible. C'est le symptome rapporte ;
//   - AnswerPrelude recevait « #0 » comme jeton de departage. Sa methode est
//     d'essayer chaque arrangement et de garder celui sous lequel le premier
//     coup du fichier se resout ; « #0 » ne se resolvant sous aucun, elle se
//     rabattait sur le premier de la liste. Une partie de Malett se serait
//     donc rechargee en Gardner, silencieusement, si la lecture etait allee au
//     bout.
//
// Le paradoxe vaut d'etre garde : AnswerPrelude devine parce que les fichiers
// des AUTRES producteurs n'enregistrent pas le choix. C'est l'information en
// plus, propre a nos fichiers, qui cassait la devinette.
//
// Les jetons ne sont pas ecrits a la main ici : ils sortent du vrai
// ExtractMoves applique au vrai fichier de fixtures, pour que le test porte
// sur ce que le format produit et pas sur l'idee qu'on s'en fait.
//
// Le match est factice, mais il refuse ce que jocly refuse : pendant le
// prelude, seuls les noms d'arrangement sont legaux ; ensuite, seuls les coups
// de la partie. C'est ce refus qui fait echouer « #0 » au mauvais moment, donc
// c'est lui qui donne sa valeur au test.
//
// Usage : node tests/test-play-prelude-book.mjs   (depuis tabulon/)
import { JSDOM } from '../app/node_modules/jsdom/lib/api.js';
process.chdir(new URL('..', import.meta.url).pathname);
import { readFileSync } from 'fs';
import { ExtractMoves } from '../app/content/book-format.js';

const PLAYER_A = 1, PLAYER_B = -1;
const SETUPS = ['#0', '#1', '#2'];

const tokens = ExtractMoves(readFileSync('./tests/fixtures/jocly/minichess5x5.pjn', 'utf-8'));

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
  console.log('  ✓ ' + msg); passed++;
}

// Ce que le test suppose du fichier, verifie plutot que suppose : sans ces
// deux jetons en tete il ne prouverait rien.
assert(SETUPS.includes(tokens[0]) && tokens[1] === '--',
  'le fichier de fixtures porte bien le prelude en tete : ' + tokens.slice(0, 2).join(' '));
const recorded = tokens.slice(0, 2);
const gameMoves = tokens.slice(2);

// ── Mock Tauri ───────────────────────────────────────────────────────────────
const bus = {};
const storeData = new Map();
const mockTauri = {
  core:  { invoke: async () => null },
  event: {
    listen: async (name, fn) => { (bus[name] ??= []).push(fn); return () => {}; },
    emit:   async (name, payload) => { (bus[name] || []).forEach(fn => fn({ payload })); },
  },
  window:{ getCurrentWindow: () => ({ label: 'play-7', close: () => {} }) },
  os:    { platform: async () => 'linux' },
  shell: { open: async () => {} },
  dialog:{ save: async () => null },
  store: { Store: class { static async load() { return {
      get: async (k) => storeData.get(k),
      set: async (k, v) => { storeData.set(k, v); },
      delete: async (k) => { storeData.delete(k); },
  }; } } },
};

// ── Match factice : un prelude a deux etapes, puis la partie ─────────────────
const match = {
  turn: PLAYER_A,
  stage: 0,          // 0 = le choix, 1 = le passage de trait, 2 = la partie
  chosen: null,
  ply: 0,            // ou l'on en est dans les coups du fichier
  playedMoves: [],
  async getConfig()      { return { model: { levels: [] }, view: { skins: [] } }; },
  async attachElement()  {},
  async getTurn()        { return this.turn; },
  async getPlayedMoves() { return [...this.playedMoves]; },
  async getViewOptions() { return {}; },
  async setViewOptions() {},
  async getFinished()    { return { finished: false, winner: null }; },
  async getBoardState()  { return 'rnbqk/ppppp/5/PPPPP/RNBQK w KQkq - 0 1'; },
  async save()           { return { game: 'minichess5x5-chess', playedMoves: [...this.playedMoves] }; },
  async load(data)       { this.playedMoves = [...(data.playedMoves || [])];
                           this.stage = 0; this.chosen = null; this.ply = 0; },
  async viewControl()    { return null; },
  async userTurn()       { return new Promise(() => {}); },
  async rollback()       {},

  async getPossibleMoves() {
    if (this.stage === 0) return SETUPS.map((s, i) => ({ setup: i }));
    if (this.stage === 1) return [{}];
    // Un seul coup legal a la fois : la partie du fichier. Cela suffit au
    // test et garde le mock honnete -- il ne peut pas resoudre « #0 » ici.
    return this.ply < gameMoves.length ? [{ move: gameMoves[this.ply] }] : [];
  },
  async getMoveString(moves) {
    const one = (m) => m.setup !== undefined ? SETUPS[m.setup]
                     : m.move !== undefined ? m.move : '--';
    return Array.isArray(moves) ? moves.map(one) : one(moves);
  },
  async pickMove(str) {
    const moves = await this.getPossibleMoves();
    const names = await this.getMoveString(moves);
    const i = names.indexOf(str);
    if (i < 0) throw new Error('no such move: ' + str);
    return moves[i];
  },
  async playMove(move) {
    if (this.stage === 0) { this.chosen = SETUPS[move.setup]; this.stage = 1; }
    else if (this.stage === 1) this.stage = 2;
    else this.ply++;
    this.playedMoves.push(move);
    this.turn = -this.turn;
    return { finished: false, winner: null };
  },
};

// ── DOM : le vrai play.html, et le vrai play.js ──────────────────────────────
const html = readFileSync('./app/content/play.html', 'utf-8')
  .replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/play.html?game=minichess5x5-chess&id=7&fork=42' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.FileReader = dom.window.FileReader;
dom.window.__TAURI__ = mockTauri;
globalThis.Jocly = {
  PLAYER_A, PLAYER_B,
  getGameConfig: async () => ({ model: { 'title-en': 'MiniChess 5x5', levels: [] }, view: {} }),
  createMatch:   async () => match,
};

// C'est par la que book.js depose un fichier ouvert.
storeData.set('fork:42', { book: {
  game: 'minichess5x5-chess',
  moves: tokens.slice(),
  label: 'minichess5x5-chess',
} });

await import('../app/content/play.js');
document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return; await sleep(20); }
  throw new Error('timeout: ' + what);
}

// Le compte attendu : les deux jetons de prelude, plus tous les coups.
const expected = recorded.length + gameMoves.length;
await waitFor(() => match.playedMoves.length >= expected,
  'les ' + gameMoves.length + ' coups du fichier sont rejoués');

assert(match.chosen === recorded[0],
  'l\'arrangement du fichier (' + recorded[0] + ') est celui qui est joué, pas le premier de la liste');
assert(match.ply === gameMoves.length,
  'tous les coups sont joués : ' + match.ply + '/' + gameMoves.length);
const names = await match.getMoveString(match.playedMoves);
assert(names.join(' ') === tokens.join(' '),
  'la partie rejouée est exactement celle du fichier');

console.log(`\ntest-play-prelude-book : ${passed} assertions OK`);
// Sans cette sortie explicite le processus ne rend jamais la main : la boucle
// de jeu attend un userTurn() qui ne se resout pas, et jsdom garde de toute
// facon des minuteries en vol. Les autres suites a DOM finissent toutes
// ainsi ; celle-ci l'avait oublie, et comme run-tests.mjs lance chaque suite
// en spawnSync sans delai maximal, elle bloquait la campagne entiere -- sans
// qu'aucune assertion ait echoue.
process.exit(0);
