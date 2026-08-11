// tests/test-hub-loadscreen.mjs — ecran "Charger une partie" du hub.
//
// Avant : l'entree de la barre laterale ouvrait DIRECTEMENT le selecteur de
// fichier natif. Rien ne disait quels formats passent, ni qu'un meme bouton
// accepte un livre de plusieurs parties, une partie complete ou un probleme,
// ni que la fenetre Historique sert a naviguer dans les coups.
//
// On execute le vrai hub.js contre le vrai hub.html (jsdom) avec un Jocly
// reduit au catalogue : ce test n'a pas besoin du dist/ de jocly2.
// Usage : npm test  (ou node tests/test-hub-loadscreen.mjs)
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
const storeData   = new Map();
let nextSavePath  = '/tmp/exemple.pjn';
const saveDialogArgs = [];

const mockTauri = {
  core: { invoke: async (cmd, payload = {}) => {
      invokeCalls.push({ cmd, payload });
      if (cmd === 'get_app_info') return { name: 'Tabulon', version: 'test', homepage: '' };
      if (cmd === 'parse_pjn') {
        // Meme decoupage que la commande Rust, reduit au premier bloc de tags.
        const blocks = String(payload.data).replace(/\r\n?/g, '\n').split('\n\n')
          .map(b => b.trim()).filter(Boolean);
        if (!blocks.length || !blocks[0].startsWith('[')) return [];
        const tags = {};
        for (const line of blocks[0].split('\n')) {
          const m = /^\s*\[(\S+)\s+(.*)\]\s*$/.exec(line.trim());
          if (m) tags[m[1]] = m[2].replace(/^"|"$/g, '');
        }
        return [{ label: '', text: blocks.slice(0, 2).join('\n\n'), tags }];
      }
      return null;
  } },
  event:  { listen: async () => () => {}, emit: async () => {} },
  window: { getCurrentWindow: () => ({ label: 'main', close: () => {} }) },
  os:     { platform: async () => 'linux', locale: async () => 'en-US' },
  shell:  { open: async () => {} },
  dialog: { save: async (opts) => { saveDialogArgs.push(opts); return nextSavePath; } },
  store:  { Store: class { static async load() { return {
      get: async (k) => storeData.get(k), set: async (k, v) => { storeData.set(k, v); },
      delete: async (k) => { storeData.delete(k); },
  }; } } },
};

const html = readFileSync('./app/content/hub.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/hub.html' });
globalThis.window     = dom.window;
globalThis.document   = dom.window.document;
globalThis.FileReader = dom.window.FileReader;
globalThis.File       = dom.window.File;
dom.window.__TAURI__  = mockTauri;

// Catalogue : les jeux des exemples livres, plus un jeu sans equivalent
// Fairy-Stockfish pour verifier qu'il n'entre pas dans l'index.
const game = (title, levels) => ({ title, summary: title, thumbnail: 'thumb.png', levels });
const catalog = {
  'chu-shogi':     game('Chu Shogi'),
  'classic-chess': game('Chess'),
  'rocaille':      game('Rocaille'),
  'shako-chess':   game('Shako'),
};
globalThis.Jocly = {
  listGames: async () => catalog,
  getGameConfig: async (n) => ({ model: { levels:
    n === 'shako-chess'   ? [{ ai: 'uct' }, { ai: 'fairy-stockfish', variant: 'shako' }] :
    n === 'classic-chess' ? [{ ai: 'fairy-stockfish', variant: 'chess' }] : [{ ai: 'uct' }] } }),
};

await import('../app/content/hub.js');
document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));
await waitFor(() => document.querySelectorAll('#game-list li.list-group-item').length > 0, 'liste rendue');

const $ = (s) => document.querySelector(s);
const text = (s) => ($(s)?.textContent || '').trim();

// ── 1. Le clic ouvre un ECRAN, plus le selecteur natif ──────────────────────
console.log('Ouverture de l\'ecran');
{
  $('#nav-loadgame').click();
  await waitFor(() => $('#loadgame-pane').style.display === '', 'panneau affiche');
  assert($('#nav-loadgame').classList.contains('active'), 'l\'entree de nav devient active');
  assert($('#game-list-pane').style.display === 'none', 'la liste des jeux cede la place');
}

// ── 2. Le texte explique les formats, les trois usages, et l'Historique ─────
console.log('Texte explicatif');
{
  const formats = text('.loadgame-formats');
  for (const ext of ['.pjn', '.pgn', '.json'])
    assert(formats.includes(ext), 'format ' + ext + ' annonce');
  assert(/\bplies?\b/i.test(formats),
    'la longueur est donnee en coups (plies), avec la paire numerotee expliquee');
  assert(/two plies/i.test(formats), '"1. e4 e5" = deux coups, dit explicitement');

  const kinds = text('.loadgame-kinds');
  assert(/several games/i.test(kinds), 'cas du livre a plusieurs parties');
  assert(/complete game/i.test(kinds), 'cas de la partie complete');
  assert(/board position/i.test(kinds) && /FEN/.test(kinds), 'cas du probleme, avec le tag FEN nomme');

  const hist = text('.loadgame-history');
  assert(/History window/i.test(hist), 'la fenetre Historique est citee');
  assert(/human/i.test(hist), 'et le fait que rien ne joue pendant la navigation');
  assert(!text('.loadgame-container').includes('load.'),
    'aucune cle i18n non traduite laissee a l\'ecran');
}

// ── 3. Le bouton ouvre le selecteur, dont l'input accepte les bons formats ──
console.log('Choix du fichier');
{
  let clicked = false;
  $('#fileElem').click = () => { clicked = true; };
  $('#loadgame-choose').click();
  assert(clicked, 'le bouton declenche bien le selecteur natif');
  const accept = $('#fileElem').getAttribute('accept');
  for (const ext of ['.pjn', '.pgn', '.json', '.ini'])
    assert(accept.includes(ext), 'le selecteur accepte ' + ext);
}

// ── 4. Vignettes d'exemples : lancer et enregistrer ─────────────────────────
console.log('Exemples');
{
  const cards = [...document.querySelectorAll('.loadgame-sample')];
  assert(cards.length >= 4, `${cards.length} vignettes affichees`);
  assert(cards.every(c => c.querySelector('img')?.getAttribute('src')),
    'chaque vignette porte la miniature de son jeu');
  const names = cards.map(c => c.querySelector('.loadgame-sample-name').textContent);
  assert(names.some(n => n.endsWith('.pjn')) && names.some(n => n.endsWith('.json'))
      && names.some(n => n.endsWith('.pgn')),
    'les trois formats sont illustres — ' + names.join(', '));

  // Lancer : meme circuit qu'un fichier choisi a la main.
  const json = cards[names.findIndex(n => n.endsWith('.json'))];
  const before = invokeCalls.length;
  json.querySelector('.sample-play').click();
  await waitFor(() => invokeCalls.slice(before).some(c => c.cmd === 'new_match'), 'exemple lance');
  const nm = invokeCalls.slice(before).find(c => c.cmd === 'new_match');
  assert(nm.payload.gameName === 'chu-shogi', 'jeu pris dans l\'exemple lui-meme');
  const fork = storeData.get('fork:' + nm.payload.forkId);
  assert(fork?.solution?.playedMoves?.length === 9, 'les 9 coups du probleme sont transmis a play.js');

  // Enregistrer : dialogue natif puis save_text_file, contenu tel quel.
  const pjn = cards[names.findIndex(n => n === 'es3.pjn')];
  pjn.querySelector('.sample-save').click();
  await waitFor(() => invokeCalls.some(c => c.cmd === 'save_text_file'), 'save_text_file invoque');
  const sv = invokeCalls.find(c => c.cmd === 'save_text_file');
  assert(saveDialogArgs[0].defaultPath === 'es3.pjn', 'nom de fichier propose');
  assert(sv.payload.contents.includes('[JoclyGame "chu-shogi"]')
      && sv.payload.contents.includes('[FEN'),
    'le fichier ecrit est rechargeable : jeu et position de depart presents');
}

// ── 5. variants.ini : un fichier de REGLES, pas une partie ─────────────────
console.log('variants.ini de Fairy-Stockfish');
{
  const ini = `[shako]
maxRank = 10
maxFile = 10
startFen = c8c/ernbqkbnre/pppppppppp/10/10/10/10/PPPPPPPPPP/ERNBQKBNRE/C8C w KQkq - 0 1

[bidule]
maxRank = 19
maxFile = 19
startFen = 19/19 w - - 0 1
`;
  const before = invokeCalls.length;
  const input = document.getElementById('fileElem');
  Object.defineProperty(input, 'files', { configurable: true,
    value: [new dom.window.File([ini], 'variants.ini', { type: 'text/plain' })] });
  input.dispatchEvent(new dom.window.Event('change'));
  await waitFor(() => (text('#loadgame-status') || '').length > 0, 'resume affiche');

  assert(!invokeCalls.slice(before).some(c => c.cmd === 'new_match' || c.cmd === 'open_book'),
    'aucune partie ouverte : un variants.ini n\'en contient pas');
  const status = text('#loadgame-status');
  assert(status.includes('variants.ini') && status.includes('2') && status.includes('1'),
    '2 variantes lues, 1 jouable — ' + status);
  assert(/rules for the Fairy-Stockfish engine/i.test(status),
    'le resume dit que ce fichier decrit des regles, pas des parties');

  const cards = [...document.querySelectorAll('.loadgame-sample')];
  assert(cards.length === 1, 'seule la variante jouable donne une vignette');
  assert(cards[0].querySelector('.loadgame-sample-name').textContent === 'shako.pjn',
    'la vignette porte le nom de la variante');
  const before2 = invokeCalls.length;
  cards[0].querySelector('.sample-play').click();
  await waitFor(() => invokeCalls.slice(before2).some(c => c.cmd === 'open_book'), 'position ouvrable');
  assert(invokeCalls.slice(before2).find(c => c.cmd === 'open_book').payload.gameName === 'shako-chess',
    'la variante "shako" est routee vers le jeu Jocly "shako-chess"');
}

console.log(`\n${passed} assertions OK — ecran "Charger une partie" valide.`);
process.exit(0);
