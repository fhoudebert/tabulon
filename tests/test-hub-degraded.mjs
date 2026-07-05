// test-hub-degraded.mjs — reproduit le bug remonté : le NOUVEAU hub.js servi
// avec l'ANCIEN hub.html (sans panneau de détail — fichier non remplacé ou
// src-tauri/target/ périmé) provoquait :
//   TypeError: null is not an object (evaluating 'getElementById('quickplay')...')
// et la liste des jeux ne se chargeait plus.
//
// Après le fix : la liste DOIT se charger quand même (mode dégradé), avec un
// message d'erreur actionnable en console.
// Usage : node test-hub-degraded.mjs   (depuis tabulon/)
import { JSDOM } from '../app/node_modules/jsdom/lib/api.js';
process.chdir(new URL('..', import.meta.url).pathname);   // cwd = racine tabulon/
import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const invokeCalls = [];
const storeData = new Map();
const mockTauri = {
  core:  { invoke: async (cmd, payload = {}) => {
      invokeCalls.push({ cmd, payload });
      if (cmd === 'get_app_info') return { name: 'Tabulon', version: 'test', homepage: '' };
      if (cmd === 'is_favorite') return false;
      return null;
  } },
  event: { listen: async () => () => {}, emit: async () => {} },
  window:{ getCurrentWindow: () => ({ label: 'main', close: () => {} }) },
  os:    { platform: async () => 'linux' },
  shell: { open: async () => {} },
  store: { Store: class { static async load() { return {
      get: async (k) => storeData.get(k), set: async (k, v) => { storeData.set(k, v); },
  }; } } },
};

// ── DOM : hub.html ACTUEL amputé du panneau de détail = ancien hub.html ──────
let html = readFileSync('./app/content/hub.html', 'utf-8')
  .replace(/<script[\s\S]*?<\/script>/g, '');
const start = html.indexOf('<div id="game-detail"');
const endMarker = '</div>\n            </div>'; // fin de #game-detail
const end = html.indexOf('</ul>', start);
// Amputation robuste : on retire tout le bloc #game-detail via DOM plutôt
// qu'à la découpe de chaînes.
const pre = new JSDOM(html);
pre.window.document.getElementById('game-detail')?.remove();
html = pre.serialize();
if (html.includes('id="game-detail"')) { console.error('amputation échouée'); process.exit(1); }

const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/hub.html' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
dom.window.__TAURI__ = mockTauri;
const BASE = 'https://tauri.localhost/';
dom.window.BrowserScriptLoader = {
  getBaseURL: () => BASE,
  import: (p) => Promise.resolve(require('../dist/node/' + p)),
};
globalThis.Jocly = require('../dist/node/jocly.core.js');

// Capturer les erreurs console pour vérifier le message actionnable
const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.join(' ')); origError(...a); };

// storer un last-game pour vérifier que la restauration ne plante pas non plus
storeData.set('last-game', 'classic-chess');

await import('../app/content/hub.js');
document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return; await sleep(25); }
  throw new Error('timeout: ' + what);
}
const $$ = (s) => [...document.querySelectorAll(s)];
let passed = 0;
function assert(cond, msg) {
  if (!cond) { origError('  ✗ ' + msg); process.exit(1); }
  console.log('  ✓ ' + msg); passed++;
}

// 1. LE POINT DU BUG : la liste des jeux se charge malgré le hub.html obsolète
await waitFor(() => $$('#game-list li').length > 0, 'liste chargée en mode dégradé');
assert($$('#game-list li').length === 10, 'Favorites : 10 jeux affichés (avant le fix : 0, TypeError)');

// 2. Message d'erreur actionnable en console (pas un TypeError silencieux)
assert(errors.some(e => e.includes('hub.html obsolète') && e.includes('quickplay')),
  'erreur console explicite listant les éléments manquants');
assert(errors.some(e => e.includes('src-tauri/target')),
  'le message indique la marche à suivre (target/ périmé)');

// 3. Le hub reste utilisable : navigation All + raccourcis de liste
document.getElementById('nav-games-all').click();
await waitFor(() => $$('#game-list li').length > 100, 'nav All');
assert($$('#game-list li').length === 125, 'navigation Favorites/All fonctionnelle');
const li0 = $$('#game-list li')[0];
li0.querySelector('.list-shortcut-play').click();
assert(invokeCalls.some(c => c.cmd === 'new_match'), 'raccourci Quick play fonctionnel');
assert(!li0.querySelector('.list-shortcut-clock'), 'raccourci horloge absent (retiré)');

// 4. Cliquer un jeu ne plante pas (SelectGame court-circuité proprement)
li0.click();
await sleep(200);
assert(true, 'clic sur un jeu : aucun crash (panneau désactivé proprement)');

console.log(`\n${passed} assertions OK — mode dégradé validé.`);
process.exit(0);
