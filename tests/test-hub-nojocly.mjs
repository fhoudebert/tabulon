// tests/test-hub-nojocly.mjs — reproduit le build Windows cassé : hub.js
// s'exécute mais window.Jocly n'existe pas (../browser/jocly.js absent des
// assets embarqués — dist/ manquant au build ou src-tauri/target périmé).
// Avant le fix : "Uncaught ReferenceError: Jocly is not defined" et liste
// vide muette. Après : message explicite dans la liste, About fonctionnel.
// Usage : npm test  (ou node tests/test-hub-nojocly.mjs)
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

const mockTauri = {
  core:  { invoke: async (cmd) => cmd === 'get_app_info'
      ? { name: 'Tabulon', version: 'test', homepage: '' } : null },
  event: { listen: async () => () => {}, emit: async () => {} },
  window:{ getCurrentWindow: () => ({ label: 'main', close: () => {} }) },
  os:    { platform: async () => 'linux' },
  shell: { open: async () => {} },
  store: { Store: class { static async load() { return { get: async () => undefined, set: async () => {} }; } } },
};

const html = readFileSync('./app/content/hub.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/hub.html' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
dom.window.__TAURI__ = mockTauri;
// PAS de globalThis.Jocly — c'est le scénario

const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.join(' ')); origError(...a); };

await import('../app/content/hub.js');
document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));

const $ = (s) => document.querySelector(s);

// 1. Plus de ReferenceError : un message explicite apparaît dans la liste
await waitFor(() => document.querySelectorAll('#game-list li').length === 1, 'message affiché');
assert($('#game-list li strong').textContent.includes('jocly.js'),
  'liste : cause affichée ("' + $('#game-list li strong').textContent + '")');
assert(/target/.test($('#game-list li p').textContent),
  'indice actionnable (dist au build / target périmé) affiché');
assert(errors.some(e => e.includes('src-tauri/target')),
  'console : diagnostic complet avec marche à suivre');

// 2. La fenêtre reste utilisable : titre posé (twu.ready atteint), About OK
await waitFor(() => document.title.startsWith('Tabulon'), 'init terminée malgré l\'absence de Jocly');
document.getElementById('nav-about').click();
await sleep(100);
assert(document.querySelector('.appName')?.textContent === 'Tabulon', 'panneau About fonctionnel');

console.log(`\n${passed} assertions OK — garde Jocly absent validée.`);
process.exit(0);
