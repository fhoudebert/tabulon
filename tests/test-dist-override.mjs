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
    assert(s.getAttribute('src') === PROTO + 'browser/jocly.js',
      '<script src="../browser/jocly.js"> réécrit vers le dist externe');
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

console.log(`\n${passed} assertions OK — réécriture d'assets (dist externe) validée.`);
process.exit(0);
