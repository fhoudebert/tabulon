// tests/test-problem-view.mjs — fenêtre « Voir » d'un exemple.
//
// L'écran de chargement ne montrait d'un exemple qu'une vignette de 42 px et
// un nom de fichier. Tout ce que le fichier contient d'explicatif — le titre
// donné par l'auteur, l'énoncé, le commentaire coup par coup — était jeté par
// ExtractMoves et invisible. Cette fenêtre l'affiche : titre, image en grand,
// puis commentaire.
//
// On exécute le vrai problem.js contre le vrai problem.html (jsdom), sur le
// contenu RÉEL de tests/fixtures-problems.
// Usage : npm test  (ou node tests/test-problem-view.mjs)
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

// Découpage identique à la commande Rust parse_pjn.
function parsePjn(data) {
  const blocks = String(data).replace(/\r\n?/g, '\n').split('\n\n')
    .map(b => b.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < blocks.length; ) {
    if (!blocks[i].startsWith('[')) { i++; continue; }
    const tags = {};
    for (const line of blocks[i].split('\n')) {
      const m = /^\s*\[(\S+)\s+(.*)\]\s*$/.exec(line.trim());
      if (m) tags[m[1]] = m[2].replace(/^"|"$/g, '');
    }
    out.push({ label: '', text: blocks[i] + '\n\n' + (blocks[i + 1] || ''), tags });
    i += 2;
  }
  return out;
}

const storeData = new Map();
const deleted   = [];

const mockTauri = {
  core: { invoke: async (cmd, payload = {}) => {
      if (cmd === 'parse_pjn') return parsePjn(payload.data);
      return null;
  } },
  event:  { listen: async () => () => {}, emit: async () => {} },
  window: { getCurrentWindow: () => ({
      label: 'problem-1', close: () => {},
      show: async () => {}, isVisible: async () => true,
  }) },
  os:     { platform: async () => 'linux', locale: async () => 'fr-FR' },
  shell:  { open: async () => {} },
  store:  { Store: class { static async load() { return {
      get:    async (k) => storeData.get(k),
      set:    async (k, v) => { storeData.set(k, v); },
      delete: async (k) => { deleted.push(k); storeData.delete(k); },
  }; } } },
};

// Le hub dépose l'exemple sous problem:{id} ; ici, le vrai fichier de fixture.
const IMG = 'data:image/jpeg;base64,'
  + readFileSync('./tests/fixtures-problems/classic-chess/matOpera-thumb.jpg').toString('base64');
storeData.set('problem:v1', {
  group: 'classic-chess',
  file:  'matOpera.pgn',
  text:  readFileSync('./tests/fixtures-problems/classic-chess/matOpera.pgn', 'utf-8'),
  thumbnail: IMG,
});

const html = readFileSync('./app/content/problem.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/problem.html?id=v1' });
globalThis.window   = dom.window;
globalThis.document = dom.window.document;
dom.window.__TAURI__ = mockTauri;

await import('../app/content/problem.js');
document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));
await waitFor(() => document.querySelector('.problem-move'), 'contenu rendu');

const text = (s) => (document.querySelector(s)?.textContent || '').trim();

// ── 1. Titre : celui que l'auteur a donné, pas le nom de fichier ───────────
console.log('Titre');
{
  assert(text('#problem-title') === "Cours Mat types - Cahiers Débutants FFE: Le Mat de l'Opéra 2",
    '[Event] sert de titre — ' + text('#problem-title'));
  assert(text('#problem-title') !== 'matOpera.pgn',
    'le nom de fichier n\'est qu\'un repli : il n\'apprend rien');
  // twu.init() met document.title hors macOS (une titlebar HTML sinon).
  assert(document.title === text('#problem-title'),
    'le titre de la fenêtre est mis à jour une fois le fichier lu — ' + document.title);
}

// ── 2. Image en grand, avant le texte ──────────────────────────────────────
console.log('Image');
{
  const img = document.querySelector('#problem-image img');
  assert(img, 'la vignette du dossier est affichée');
  assert(img.src === IMG, 'c\'est bien matOpera-thumb.jpg, transmis par le hub');
  const order = [...document.querySelectorAll('.problem-content > *')].map(e => e.id || e.className);
  assert(order.indexOf('problem-image') < order.indexOf('problem-body'),
    'ordre demandé : titre, puis image, puis complément — ' + order.join(' > '));
  assert(order[0] === 'problem-title', 'le titre ouvre la fenêtre');
}

// ── 3. Complément : énoncé puis commentaire coup par coup ──────────────────
console.log('Complément');
{
  assert(/Paul Morphy fit mat contre le Duc Karl/.test(text('.problem-intro')),
    'l\'énoncé, écrit avant le premier coup, est mis en avant');
  assert(/Mat en 2 ici/.test(text('.problem-intro')), 'et en entier');

  const moves = [...document.querySelectorAll('.problem-move')];
  assert(moves.length === 3, `3 coups affichés (${moves.length})`);
  const first = moves[0];
  assert(first.querySelector('.problem-num').textContent === '16.', 'numéro du coup');
  assert(first.querySelector('.problem-san').textContent === 'Qb8+', 'notation du coup');
  assert(/sacrifice d'attraction/.test(first.querySelector('.problem-note').textContent),
    'commentaire rattaché à SON coup');
  assert(moves[2].querySelector('.problem-san').textContent === 'Rd8#'
      && /Bien joué/.test(moves[2].textContent), 'dernier coup et son commentaire');

  const body = text('#problem-body');
  assert(!/%csl|Gd8,Ge7/.test(body),
    'les annotations machine [%csl …] ne sont pas affichées');
  assert(/starts from a given position|position donnée/i.test(body),
    'le fait que la partie démarre d\'un FEN est signalé');
  const link = document.querySelector('.problem-link');
  assert(link && link.href.includes('lichess.org/study'),
    'le lien vers l\'étude source est cliquable — c\'est là qu\'est le cours complet');
  assert(!/UTCTime|Annotator/.test(body), 'les tags sans intérêt pour un lecteur sont écartés');
}

// ── 4. Le dépôt est à usage unique ─────────────────────────────────────────
console.log('Nettoyage du store');
{
  assert(deleted.includes('problem:v1'),
    'le contenu est retiré du store après lecture : il porte une image en base64');
}

console.log(`\n${passed} assertions OK — fenêtre « Voir » validée.`);
process.exit(0);
