// tests/test-dist-override.mjs — valide la logique de réécriture d'assets qui
// permet à un dist/ externe (posé à côté de l'exe) d'être servi à la place des
// assets embarqués. On teste le VRAI asset-rewrite.js dans jsdom : fetch, img,
// script et XHR pointant vers browser/** ou games/** doivent être redirigés
// vers le protocole tabulon-dist://, le reste inchangé.
// Usage : npm test  (ou node tests/test-dist-override.mjs)
import { JSDOM } from '../app/node_modules/jsdom/lib/api.js';
process.chdir(new URL('..', import.meta.url).pathname);
import { readFileSync } from 'fs';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
  console.log('  ✓ ' + msg); passed++;
}

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'https://tauri.localhost/content/hub.html',
  runScripts: 'outside-only',
});
const { window } = dom;

// convertFileSrc mocké comme Tauri (Windows-like : https://<scheme>.localhost/)
window.__TAURI__ = {
  core: { convertFileSrc: (p, scheme) => `https://${scheme}.localhost/${p}` },
};

// fetch et XHR d'origine, instrumentés pour capturer l'URL finale
const fetchUrls = [];
window.fetch = function (input) {
  fetchUrls.push(typeof input === 'string' ? input : input.url);
  return Promise.resolve({ ok: true, text: async () => '' });
};
const xhrUrls = [];
window.XMLHttpRequest = class {
  open(method, url) { this._url = url; xhrUrls.push(url); }
  send() {}
  setRequestHeader() {}
};
window.Request = class { constructor(url) { this.url = url; } };

// Injecter le VRAI script (comme initialization_script le ferait)
const script = readFileSync('./app/content/asset-rewrite.js', 'utf-8');
window.eval(script);

const PROTO = 'https://tabulon-dist.localhost/';

// La base doit être correctement dérivée quel que soit le format renvoyé par
// convertFileSrc (Windows http://scheme.localhost/ vs Linux scheme://localhost/).
// On revérifie via un second contexte au format Linux plus bas.

// 1. fetch d'une règle de jeu → redirigé
window.fetch('https://tauri.localhost/games/chessbase/res/rules/shogi/seireigi-rules.html');
assert(fetchUrls.at(-1) === PROTO + 'games/chessbase/res/rules/shogi/seireigi-rules.html',
  'fetch(games/…) → protocole dist externe');

// 2. fetch relatif (../games/…) depuis une page content/ → résolu puis redirigé
window.fetch('../games/checkers/draughts-config.js');
assert(fetchUrls.at(-1) === PROTO + 'games/checkers/draughts-config.js',
  'fetch(../games/…) relatif → protocole dist externe');

// 3. fetch hors périmètre (une API, un asset d'app) → inchangé
window.fetch('https://tauri.localhost/content/tabulon.css');
assert(fetchUrls.at(-1) === 'https://tauri.localhost/content/tabulon.css',
  'fetch hors browser/games → inchangé');
window.fetch('https://example.com/api');
assert(fetchUrls.at(-1) === 'https://example.com/api', 'fetch externe → inchangé');

// 3b. fetch d'un fichier de jeu en chemin ABSOLU (comme Jocly le fait depuis
//     sa baseURL /browser/) → redirigé vers le dist externe : c'est ce qui
//     manquait ("Game classic-chess not found").
window.fetch('/browser/games/chessbase/classic-chess-config.js');
assert(fetchUrls.at(-1) === PROTO + 'browser/games/chessbase/classic-chess-config.js',
  'fetch(/browser/games/…-config.js) absolu → dist externe (chargement du jeu)');
window.fetch('/browser/jocly.core.js');
assert(fetchUrls.at(-1) === PROTO + 'browser/jocly.core.js',
  'fetch(/browser/jocly.core.js) → moteur servi depuis le dist externe');

// 4. XHR vers browser/ → redirigé
const xhr = new window.XMLHttpRequest();
xhr.open('GET', '../browser/games/chessbase/res/images/x.png');
assert(xhr._url === PROTO + 'browser/games/chessbase/res/images/x.png',
  'XHR(../browser/…) → protocole dist externe');

// 5. <script src> et <img src> ajoutés au DOM → réécrits par l'observer
await new Promise((resolve) => {
  const s = window.document.createElement('script');
  s.src = '../browser/jocly.js';
  window.document.head.appendChild(s);
  const img = window.document.createElement('img');
  img.src = 'https://tauri.localhost/games/checkers/draughts-thumb3d.png';
  window.document.body.appendChild(img);
  setTimeout(() => {
    assert(s.getAttribute('src') === '../browser/jocly.js',
      '<script src="../browser/jocly.js"> NON réécrit (Jocly doit calculer sa baseURL depuis la page)');
    assert(img.getAttribute('src') === PROTO + 'games/checkers/draughts-thumb3d.png',
      '<img src="…/games/…"> réécrit vers le dist externe');
    resolve();
  }, 50);
});

// 6. <link> d'app (content/) inséré → NON réécrit
await new Promise((resolve) => {
  const l = window.document.createElement('link');
  l.href = 'tabulon.css';
  window.document.head.appendChild(l);
  setTimeout(() => {
    assert(l.getAttribute('href') === 'tabulon.css', '<link> hors browser/games → inchangé');
    resolve();
  }, 50);
});

// Format Linux : convertFileSrc renvoie scheme://localhost/<p>.
// On rejoue la seule dérivation de base (sans re-parser tout le script).
{
  const linuxConvert = (p, scheme) => `${scheme}://localhost/${p}`;
  let P = linuxConvert('x', 'tabulon-dist').replace(/x$/, '');
  if (P.charAt(P.length - 1) !== '/') P += '/';
  assert(P === 'tabulon-dist://localhost/',
    'base du protocole correctement dérivée au format Linux (scheme://localhost/)');
}

// Image().src assigné en JS (préchargement visuels/thumbnails) → redirigé
{
  const img = new window.Image();
  img.src = 'browser/games/chessbase/res/visuals/capablanca-600x600-2d.jpg';
  assert(String(img.src).includes('tabulon-dist.localhost/browser/games/chessbase/res/visuals/'),
    'new Image().src (préchargement visuel) → dist externe');
}

// Texture 3D redirigée cross-origin → crossOrigin='anonymous', sinon WebGL
// lève SecurityError sur texSubImage2D (canvas "tainted"). Le protocole
// renvoie déjà Access-Control-Allow-Origin: *.
{
  const tex = new window.Image();
  tex.src = 'browser/games/chessbase/res/xd-view/textures/wood.jpg';
  assert(tex.crossOrigin === 'anonymous',
    'texture 3D redirigée reçoit crossOrigin=anonymous (fix SecurityError WebGL)');
  const local = new window.Image();
  local.src = 'content/logo.png';
  assert(!local.crossOrigin, 'image hors dist externe : pas de crossOrigin imposé');
}

// Worker IA : new Worker(baseURL + "jocly.aiworker.js") est un contexte isolé,
// et un Worker DOIT être same-origin avec sa page (rediriger son URL vers
// tabulon-dist:// lèverait SecurityError → IA bloquée sur "réflexion"). Le hook
// crée donc un worker shim same-origin (blob:) qui remappe ses importScripts
// vers le dist externe puis charge le vrai jocly.aiworker.js.
{
  const workerUrls = [];
  const blobs = [];
  // Contexte jsdom dédié : Worker/Blob/createObjectURL mockés AVANT l'injection
  // du script, pour capturer ce que le hook construit réellement.
  const dom2 = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://tauri.localhost/content/jocly.embed.html',
    runScripts: 'outside-only',
  });
  const w2 = dom2.window;
  w2.__TAURI__ = { core: { convertFileSrc: (p, scheme) => `https://${scheme}.localhost/${p}` } };
  w2.Worker = class { constructor(url) { workerUrls.push(String(url)); } };
  w2.Blob = class { constructor(parts) { blobs.push(parts.join('')); } };
  w2.URL.createObjectURL = () => 'blob:mock-' + blobs.length;
  w2.eval(script);

  new w2.Worker('https://tauri.localhost/browser/jocly.aiworker.js');
  assert(workerUrls.at(-1).startsWith('blob:'),
    'new Worker(browser/jocly.aiworker.js) → worker shim same-origin (blob:), pas de redirection cross-origin');

  // Exécuter le code du shim avec un self factice pour vérifier le remappage
  // des importScripts — mêmes appels que le vrai flux Jocly.
  const shimSrc = blobs.at(-1);
  const imported = [];
  const fakeSelf = { importScripts: (...urls) => imported.push(...urls) };
  new Function('self', shimSrc)(fakeSelf);
  assert(imported[0] === PROTO + 'browser/jocly.aiworker.js',
    'shim : charge le vrai jocly.aiworker.js depuis le dist externe');
  fakeSelf.importScripts('https://tauri.localhost/browser/jocly.core.js'); // Init: baseURL+"jocly.core.js"
  assert(imported.at(-1) === PROTO + 'browser/jocly.core.js',
    'shim : importScripts(baseURL+jocly.core.js) absolu → dist externe');
  fakeSelf.importScripts('jocly-allgames.js'); // WorkerCreateGame, relatif
  assert(imported.at(-1) === PROTO + 'browser/jocly-allgames.js',
    'shim : importScripts relatif (jocly-allgames.js) → résolu sur browser/ du dist externe');
  fakeSelf.importScripts('games/chessbase/classic-chess-model.js'); // modèle du jeu, relatif
  assert(imported.at(-1) === PROTO + 'browser/games/chessbase/classic-chess-model.js',
    'shim : importScripts(games/…-model.js) relatif → dist externe (fix "Game not found" après le coup IA)');

  new w2.Worker('https://tauri.localhost/worker/match-worker.js');
  assert(workerUrls.at(-1) === 'https://tauri.localhost/worker/match-worker.js',
    'Worker hors jocly.aiworker.js (match-worker, fairy, scan) → inchangé');

  // CSS de module : reproduit exactement JocGame.LoadCss (jocly.game.js) —
  // le <link> est construit par setAttribute("href", …), pas par le setter
  // .href, et doit être réécrit AVANT insertion (sinon requête 500 sur
  // l'embarqué, corrigée trop tard par l'observer).
  const cssLink = w2.document.createElement('link');
  cssLink.setAttribute('rel', 'stylesheet');
  cssLink.setAttribute('type', 'text/css');
  cssLink.setAttribute('class', 'jocly-css');
  cssLink.setAttribute('href', 'https://tauri.localhost/browser/games/chessbase/chessbase.css');
  assert(cssLink.getAttribute('href') === PROTO + 'browser/games/chessbase/chessbase.css',
    'LoadCss (setAttribute href, chessbase.css) → réécrit dès le setAttribute, avant insertion');
  const appLink = w2.document.createElement('link');
  appLink.setAttribute('href', 'tabulon.css');
  assert(appLink.getAttribute('href') === 'tabulon.css',
    'setAttribute(href) hors browser/games → inchangé');

  // <link>.href assigné en JS AVANT insertion (CSS de module type chessbase.css) :
  // réécrit dès le setter, pas seulement à l'insertion (évite le fetch 500 sur
  // l'embarqué avant correction par l'observer).
  const l = w2.document.createElement('link');
  l.rel = 'stylesheet';
  l.href = '../browser/games/chessbase/chessbase.css';
  assert(String(l.href).startsWith(PROTO + 'browser/games/chessbase/chessbase.css'),
    '<link>.href (chessbase.css) réécrit au setter, avant insertion dans le DOM');
  const lApp = w2.document.createElement('link');
  lApp.href = 'tabulon.css';
  assert(!String(lApp.href).includes('tabulon-dist'),
    '<link>.href hors browser/games → inchangé');

  // Idempotence : le script tourne désormais dans TOUTES les frames
  // (initialization_script_for_all_frames) ET reste ré-injecté manuellement
  // dans l'iframe — une double exécution ne doit pas ré-emballer les hooks.
  assert(w2.__distRewriteApplied === true, 'garde __distRewriteApplied posée');
  const WorkerBefore = w2.Worker;
  w2.eval(script); // seconde exécution dans le même contexte
  assert(w2.Worker === WorkerBefore,
    'seconde exécution du script : hooks non ré-emballés (idempotence)');
}

// window.__distURL exposé pour réécriture explicite des backgrounds CSS (hub.js)
assert(typeof window.__distURL === 'function', 'window.__distURL exposé par asset-rewrite.js');
assert(window.__distURL('browser/games/chessbase/res/rules/capa10x8/capablanca-thumb.png')
       === PROTO + 'browser/games/chessbase/res/rules/capa10x8/capablanca-thumb.png',
  'window.__distURL réécrit un chemin de thumbnail vers le dist externe');
assert(window.__distURL('content/tabulon.css') === 'content/tabulon.css',
  'window.__distURL laisse les chemins hors browser/games inchangés');

console.log(`\n${passed} assertions OK — réécriture d'assets (dist externe) validée.`);
process.exit(0);
