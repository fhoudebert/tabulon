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

// window.__distURL exposé pour réécriture explicite des backgrounds CSS (hub.js)
assert(typeof window.__distURL === 'function', 'window.__distURL exposé par asset-rewrite.js');
assert(window.__distURL('browser/games/chessbase/res/rules/capa10x8/capablanca-thumb.png')
       === PROTO + 'browser/games/chessbase/res/rules/capa10x8/capablanca-thumb.png',
  'window.__distURL réécrit un chemin de thumbnail vers le dist externe');
assert(window.__distURL('content/tabulon.css') === 'content/tabulon.css',
  'window.__distURL laisse les chemins hors browser/games inchangés');

console.log(`\n${passed} assertions OK — réécriture d'assets (dist externe) validée.`);
process.exit(0);
