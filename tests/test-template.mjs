// tests/test-template.mjs — valide "Save template" : la fenêtre récupère les
// données réelles de la partie auprès de play.js (satellite get-template-data)
// et les transmet à la commande Rust save_template avec un matchId NUMÉRIQUE
// (une String faisait échouer la désérialisation u32 en silence — même classe
// de bug que fork_id). L'ancien flux Rust stockait un placeholder {matchId}.
// Usage : npm test  (ou node tests/test-template.mjs)
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
let takenNames = new Set(['Deja-pris']);
const mockTauri = {
  core: { invoke: async (cmd, payload = {}) => {
      invokeCalls.push({ cmd, payload });
      if (cmd === 'is_template_name_valid') return !takenNames.has(payload.name);
      return null;
  } },
  event: {
    listen: async (name, fn) => { (bus[name] ??= []).push(fn); return () => {}; },
    emit:   async (name, payload) => { (bus[name] || []).forEach(fn => fn({ payload })); },
  },
  window:{ getCurrentWindow: () => ({ label: 'tpl-6', close: () => {} }) },
  os:    { platform: async () => 'linux' },
  shell: { open: async () => {} },
  store: { Store: class { static async load() { return { get: async () => undefined, set: async () => {} }; } } },
};

// Côté play.js simulé : répond avec les données complètes de la partie
await mockTauri.event.listen('play-req:6:get-template-data', () =>
  mockTauri.event.emit('play-rep:6:get-template-data', {
    gameName: 'classic-chess',
    gameData: { game: 'classic-chess', playedMoves: ['e2-e4', 'e7-e5'] },
    clock: null,
  }));

const html = readFileSync('./app/content/save-template.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/save-template.html?id=6&name=MaPartie' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
dom.window.__TAURI__ = mockTauri;

await import('../app/content/save-template.js');
document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));

const input = () => document.querySelector('input');
const btnSave = () => document.getElementById('button-save');

// 1. Les données arrivent de play.js et le nom initial est validé sans frappe
// (attendre l'init réelle : le bouton HTML n'est pas désactivé par défaut)
await waitFor(() => input().value === 'MaPartie', 'init : nom initial posé');
await waitFor(() => !btnSave().disabled, 'bouton Save activé');
assert(input().value === 'MaPartie', 'nom initial depuis l\'URL');
assert(invokeCalls.some(c => c.cmd === 'is_template_name_valid' && c.payload.name === 'MaPartie'),
  'nom initial validé au chargement (aucun événement input nécessaire)');

// 2. Nom déjà pris → bouton grisé
input().value = 'Deja-pris';
input().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await waitFor(() => btnSave().disabled, 'nom pris → grisé');
assert(true, 'nom déjà pris → Save désactivé');
input().value = 'MaPartie';
input().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await waitFor(() => !btnSave().disabled, 'nom libre → réactivé');

// 3. Save → save_template(matchId NUMÉRIQUE, nom, données réelles + lastUsed)
btnSave().click();
await waitFor(() => invokeCalls.some(c => c.cmd === 'save_template'), 'save_template invoqué');
const sv = invokeCalls.find(c => c.cmd === 'save_template');
assert(typeof sv.payload.matchId === 'number' && sv.payload.matchId === 6,
  'matchId en Number (contrat Rust u32 — une String rejetait l\'invoke en silence)');
assert(sv.payload.name === 'MaPartie', 'nom transmis');
assert(sv.payload.data?.gameData?.playedMoves?.length === 2 && sv.payload.data.gameName === 'classic-chess',
  'données réelles de la partie transmises (fini le placeholder {matchId})');
assert(typeof sv.payload.data.lastUsed === 'number', 'lastUsed horodaté');

console.log(`\n${passed} assertions OK — Save template validé.`);
process.exit(0);
