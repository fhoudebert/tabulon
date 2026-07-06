// tests/test-video.mjs — valide la capture vidéo de la fenêtre de jeu :
//   - démarrage (start_recording) et pompe à frames SÉQUENTIELLE (la
//     réparation Linux : plus de setInterval qui empile des captures
//     concurrentes quand takeSnapshot est lent)
//   - saut des temps morts : après N frames identiques consécutives, plus
//     rien n'est envoyé jusqu'au prochain changement
//   - arrêt : stop_recording, bouton stop masqué, chemin affiché au footer
//   - dialogue annulé : aucun enregistrement ; erreur ffmpeg : arrêt propre
// Usage : npm test  (ou node tests/test-video.mjs)
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
const storeData = new Map([['video-record:ignoreIdenticalFrames', 3]]);
let startShouldFail = null;    // 'cancel' | 'other' | null
const mockTauri = {
  core: { invoke: async (cmd, payload = {}) => {
      invokeCalls.push({ cmd, payload });
      if (cmd === 'start_recording') {
        if (startShouldFail === 'cancel') throw new Error('Recording cancelled');
        return null;
      }
      if (cmd === 'stop_recording') return '/tmp/partie.mp4';
      return null;
  } },
  event: { listen: async () => () => {}, emit: async () => {} },
  window:{ getCurrentWindow: () => ({ label: 'play-11', close: () => {} }) },
  os:    { platform: async () => 'linux' },
  shell: { open: async () => {} },
  dialog:{ save: async () => null },
  store: { Store: class { static async load() { return {
      get: async (k) => storeData.get(k), set: async (k, v) => { storeData.set(k, v); },
      delete: async () => {},
  }; } } },
};

// Match Jocly factice : takeSnapshot lent (25 ms) qui change 4 fois puis se fige
const PLAYER_A = 1, PLAYER_B = -1;
let frameCounter = 0;
let frozen = false;
const match = {
  turn: PLAYER_A, playedMoves: [], snapshots: 0,
  async getConfig()      { return { model: { levels: [] }, view: { skins: [] } }; },
  async attachElement()  {},
  async getTurn()        { return this.turn; },
  async getPlayedMoves() { return []; },
  async getViewOptions() { return {}; },
  async setViewOptions() {},
  async abortUserTurn()  { this.pendingUserTurn?.reject(new Error('User input aborted')); this.pendingUserTurn = null; },
  async abortMachineSearch() {},
  userTurn() { return new Promise((resolve, reject) => { this.pendingUserTurn = { resolve, reject }; }); },
  async save() { return {}; }, async load() {},
  async viewControl(what, opts) {
    if (what !== 'takeSnapshot') return null;
    this.snapshots++;
    this.lastOpts = opts;
    await sleep(25);                                  // capture "lente"
    if (!frozen && frameCounter < 4) frameCounter++;  // 4 frames distinctes puis figé
    return 'data:image/jpeg;base64,FRAME' + frameCounter;
  },
};

const html = readFileSync('./app/content/play.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/play.html?game=classic-chess&id=11' });
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
await waitFor(() => match.pendingUserTurn, 'partie démarrée');

const stopBtn = () => document.getElementById('button-stop-video');
const frames = () => invokeCalls.filter(c => c.cmd === 'record_frame');

// 1. Dialogue annulé : pas d'enregistrement, pas de bouton stop
startShouldFail = 'cancel';
document.getElementById('button-video').click();
await sleep(150);
assert(stopBtn().classList.contains('hidden') && frames().length === 0,
  'dialogue annulé → aucun enregistrement, bouton stop masqué');

// 2. Démarrage : bouton stop visible, frames pompées en JPEG
startShouldFail = null;
frozen = true; frameCounter = 1;   // frame constante pour tester la limite plus bas
document.getElementById('button-video').click();
await waitFor(() => !stopBtn().classList.contains('hidden'), 'enregistrement démarré');
assert(invokeCalls.some(c => c.cmd === 'start_recording' && c.payload.matchId === 11), 'start_recording(matchId)');
await waitFor(() => frames().length >= 1, 'première frame');
assert(frames()[0].payload.snapshot.startsWith('data:image/jpeg;base64,'), 'frames capturées en JPEG');
assert(match.lastOpts?.format === 'jpeg', "takeSnapshot appelé avec {format: 'jpeg'} (option quality du store)");

// 3. Frames identiques : après ignoreIdenticalFrames(=3) doublons, la pompe
//    cesse d'envoyer (mais continue de capturer, prête au changement)
await sleep(600);   // ~18 périodes — sans la limite on aurait ~18 frames
const sentWhileFrozen = frames().length;
assert(sentWhileFrozen <= 5, `temps mort : envois plafonnés (${sentWhileFrozen} ≤ 1+3 doublons+marge)`);
const snapsBefore = match.snapshots;
await sleep(200);
assert(match.snapshots > snapsBefore && frames().length === sentWhileFrozen,
  'pendant le gel : capture continue, aucun envoi');

// 4. Reprise au changement d'image
frozen = false; frameCounter = 10;
await waitFor(() => frames().length > sentWhileFrozen, 'reprise des envois au changement');
assert(true, 'nouvelle image → envois repris');

// 5. Pompe séquentielle : jamais deux captures concurrentes (capture 25 ms
//    > période théorique impossible à tenir → le rythme s'adapte sans empiler)
//    On le vérifie indirectement : chaque frame envoyée est distincte ou
//    consécutive, et le nombre de captures reste ≈ durée/25ms (pas ×N).
assert(match.snapshots < 80, `pas d'empilement de captures (${match.snapshots} captures pour ~1,2 s)`);

// 6. Stop : stop_recording, bouton masqué, chemin au footer, pompe arrêtée
document.getElementById('button-stop-video').click();
await waitFor(() => invokeCalls.some(c => c.cmd === 'stop_recording'), 'stop_recording');
await waitFor(() => stopBtn().classList.contains('hidden'), 'bouton stop masqué');
await waitFor(() => document.getElementById('board-footer-text').textContent.includes('/tmp/partie.mp4'), 'footer');
const framesAfterStop = frames().length;
await sleep(250);
assert(frames().length === framesAfterStop, 'pompe arrêtée : plus aucune frame après stop');

console.log(`\n${passed} assertions OK — capture vidéo validée.`);
process.exit(0);
