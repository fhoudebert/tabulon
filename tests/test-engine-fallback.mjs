// test-engine-fallback.mjs — le bandeau qui dit qu'un moteur n'a pas démarré.
//
// LE BUG D'ORIGINE. Aux dames internationales, le niveau « Champion » est
// adossé au moteur Scan. Tant que jocly.scan.js n'avait pas de repli, un
// binaire absent — le cas par défaut — laissait la recherche revenir SANS
// COUP : play.js rendait alors la main au joueur, qui se retrouvait à jouer
// les deux couleurs sans qu'aucun message ne lui dise pourquoi. Seule la
// console en portait la trace.
//
// CE QUI EST VÉRIFIÉ ICI, côté Tabulon : que le repli signalé par jocly
// produise bien un bandeau, qu'il NOMME LES DEUX NIVEAUX (celui que le joueur
// a choisi reste affiché dans la liste déroulante : ne citer que le remplaçant
// laisserait croire à un bug d'affichage) et que le conseil qui suit soit
// celui de la vraie cause — un binaire manquant et une page sans isolation
// cross-origin demandent deux gestes opposés, et le motif rendu par le moteur
// est un texte libre qu'on ne va pas analyser. play.js interroge donc l'écran
// d'installation ; c'est cet appel qu'on observe.
//
// Le mock ne dépend d'aucun moteur : il pose le drapeau que jocly poserait,
// dans la forme que jocly.scan.js / jocly.kata.js / jocly.fairy.js
// remplissent tous les trois (tests/core/scan-fallback.test.js garde ce
// contrat de l'autre côté).
//
// Usage : node tests/test-engine-fallback.mjs   (depuis tabulon/)
import { JSDOM } from '../app/node_modules/jsdom/lib/api.js';
process.chdir(new URL('..', import.meta.url).pathname);
import { readFileSync } from 'fs';

const PLAYER_A = 1, PLAYER_B = -1;
const CHAMPION = { label: 'Champion', ai: 'scan', moveTimeMs: 1000 };

// ── Mock Tauri ───────────────────────────────────────────────────────────────
const bus = {};
const invokeCalls = [];
const storeData = new Map();
// Le binaire Scan n'est pas installé : c'est l'état par défaut d'une machine
// qui n'a rien téléchargé, et donc le cas que le joueur rencontre.
// Le second passage (voir la relance en fin de fichier) rejoue la meme partie
// avec le binaire EN PLACE : le repli a alors une autre cause, et le conseil
// doit changer avec elle. C'est tout l'interet d'aller demander plutot que de
// deviner, donc les deux branches se testent.
const scanPresent = process.env.TABULON_FALLBACK_PRESENT === '1';
const mockTauri = {
  core: { invoke: async (cmd) => {
      invokeCalls.push(cmd);
      if (cmd === 'is_favorite') return false;
      if (cmd === 'install_status') return { items: [
        { id: 'dist',   present: true },
        { id: 'engine', present: true },
        { id: 'scan',   present: scanPresent },
      ] };
      return null;
  } },
  event: {
    listen: async (name, fn) => { (bus[name] ??= []).push(fn); return () => {}; },
    emit:   async (name, payload) => { (bus[name] || []).forEach(fn => fn({ payload })); },
  },
  window:{ getCurrentWindow: () => ({ label: 'play-5', close: () => {} }) },
  os:    { platform: async () => 'linux' },
  shell: { open: async () => {} },
  dialog:{ save: async () => null },
  store: { Store: class { static async load() { return {
      get: async (k) => storeData.get(k), set: async (k, v) => { storeData.set(k, v); },
      delete: async () => {},
  }; } } },
};

// ── Match factice : A humain, B au niveau « Champion » ───────────────────────
let searches = 0;
const match = {
  turn: PLAYER_A,
  playedMoves: [],
  pendingUserTurn: null,
  async getConfig()      { return { model: { levels: [CHAMPION] }, view: { skins: [] } }; },
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
  async getBoardState()  { return 'W31-50:B1-20'; },
  async save()           { return { game: 'draughts', playedMoves: [...this.playedMoves] }; },
  async viewControl()    { return null; },
  userTurn() {
    return new Promise((resolve, reject) => { this.pendingUserTurn = { resolve, reject }; });
  },
  // Ce que jocly renvoie quand le moteur n'a pas démarré : UN COUP QUAND MÊME
  // (joué par l'IA native) et le drapeau qui dit que le niveau a été dégradé.
  async machineSearch() {
    searches++;
    return {
      move: { m: 'auto' + searches },
      fairyFallback: {
        engine: 'scan',
        reason: 'moteur de dames introuvable — cherche : /opt/tabulon/engine/scan',
        requested: 'Champion',
        level: 'Expert',
      },
    };
  },
  async playMove(move) {
    this.playedMoves.push(move);
    this.turn = -this.turn;
    return { finished: false, winner: null };
  },
};

// ── DOM : le vrai play.html, le vrai play.js ─────────────────────────────────
const html = readFileSync('./app/content/play.html', 'utf-8')
  .replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/play.html?game=draughts&id=5' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.FileReader = dom.window.FileReader;
dom.window.__TAURI__ = mockTauri;
globalThis.Jocly = {
  PLAYER_A, PLAYER_B,
  getGameConfig: async () => ({ model: { 'title-en': 'Draughts', levels: [CHAMPION] }, view: {} }),
  createMatch:   async () => match,
};

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

const warningText = () => document.getElementById('play-warning-text').textContent;
const warningShown = () =>
  !document.getElementById('play-warning').classList.contains('hidden');

// 1. A joue, B enchaîne avec son niveau « Champion » — qui se replie.
await waitFor(() => match.pendingUserTurn, 'boucle de jeu démarrée');
{
  const p = match.pendingUserTurn;
  match.pendingUserTurn = null;
  match.playedMoves.push({ m: 'human' });
  match.turn = PLAYER_B;
  p.resolve({ move: {}, finished: false, winner: null });
}
await waitFor(() => searches >= 1, 'le niveau IA a lancé une recherche');

// 2. LE POINT PRINCIPAL : la partie continue et le joueur est prévenu.
await waitFor(() => warningShown(), 'un bandeau est affiché');
assert(match.playedMoves.length >= 2, 'le coup de repli est bien joué (pas de main rendue au joueur)');

// 3. Les deux niveaux sont nommés.
const txt = warningText();
assert(txt.includes('Champion'), 'le bandeau nomme le niveau demandé : ' + JSON.stringify(txt));
assert(txt.includes('Expert'), 'et celui qui joue réellement');

// 4. Le conseil vient de l'état réel de l'installation, pas d'une devinette.
await waitFor(() => invokeCalls.includes('install_status'),
  "l'écran d'installation a été interrogé");
if (scanPresent) {
  // Binaire en place et moteur qui ne démarre pas : ce n'est pas un problème
  // d'installation, et y renvoyer ferait chercher le joueur au mauvais endroit.
  assert(/cross-origin|multi-thread/.test(txt),
    'binaire présent -> le bandeau parle de l\'environnement');
  assert(!/nstallation/.test(txt), 'et ne renvoie pas à l\'installation');
} else {
  assert(/nstall/.test(txt), 'binaire absent -> le bandeau renvoie à l\'installation');
  assert(!/cross-origin|multi-thread/.test(txt),
    'et ne parle pas d\'isolation ni de multi-thread, hors sujet pour un binaire manquant');
}

// 5. Une seule fois par partie : jocly repose le drapeau à CHAQUE coup, et un
//    bandeau qui se réécrit à chaque tour finirait par ne plus être lu.
const before = invokeCalls.filter(c => c === 'install_status').length;
await waitFor(() => match.pendingUserTurn, 'la main revient au joueur humain');
{
  const p = match.pendingUserTurn;
  match.pendingUserTurn = null;
  match.playedMoves.push({ m: 'human2' });
  match.turn = PLAYER_B;
  p.resolve({ move: {}, finished: false, winner: null });
}
await waitFor(() => searches >= 2, 'un deuxième coup du moteur');
await sleep(120);
assert(invokeCalls.filter(c => c === 'install_status').length === before,
  'le deuxième repli ne réinterroge pas l\'installation');
assert(warningText() === txt, 'et le bandeau reste celui du premier');

console.log(`\n${passed} assertions OK — bandeau de repli moteur (binaire ${scanPresent ? 'présent' : 'absent'}).`);

// Le bandeau ne s'affiche qu'une fois par partie et le module ne se recharge
// pas : la seconde branche ne peut pas se jouer dans ce processus-ci. On le
// relance donc une fois, plutôt que de laisser la moitié du choix sans test.
if (!scanPresent) {
  const { spawnSync } = await import('child_process');
  const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname], {
    env: { ...process.env, TABULON_FALLBACK_PRESENT: '1' },
    encoding: 'utf-8',
  });
  process.stdout.write((r.stdout || '').split('\n').filter(l => /✓|✗|assertions/.test(l))
    .map(l => '  ' + l.trim()).join('\n') + '\n');
  if (r.status !== 0) {
    console.error('  ✗ seconde passe (binaire présent) en échec');
    process.stderr.write(r.stderr || '');
    process.exit(1);
  }
}
process.exit(0);
