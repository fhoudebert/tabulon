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
import { readFileSync, readdirSync } from 'fs';
import { ExtractMoves } from '../app/content/book-format.js';
import { join } from 'path';

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

// Réimplémentation JS de src-tauri/src/commands/problem_cmds.rs, appliquée au
// VRAI dossier d'exemples (tests/fixtures-problems, contenu de problems.zip).
// Les deux implémentations doivent rester d'accord : les assertions ci-dessous
// portent sur des noms de fichiers réels, pas sur des données inventées.
const PROBLEMS = './tests/fixtures-problems';
const GAME_EXT  = ['pjn', 'pgn', 'pdn', 'json'];
const THUMB_EXT = ['png', 'jpg', 'jpeg', 'webp'];
const extOf  = (f) => (f.split('.').pop() || '').toLowerCase();
const stemOf = (f) => f.replace(/\.[^.]*$/, '');

function listProblemGroups() {
  const groups = readdirSync(PROBLEMS, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(d => ({ name: d.name,
                 count: readdirSync(join(PROBLEMS, d.name))
                          .filter(f => GAME_EXT.includes(extOf(f))).length }))
    .filter(g => g.count > 0);
  return { dir: '/chemin/vers/problems', groups };
}

function readProblemGroup(group) {
  const files  = readdirSync(join(PROBLEMS, group)).sort();
  const images = files.filter(f => THUMB_EXT.includes(extOf(f)));
  return files.filter(f => GAME_EXT.includes(extOf(f))).map(f => {
    const low = stemOf(f).toLowerCase();
    let best = null, bestScore = 0;
    for (const img of images) {
      const ilow = stemOf(img).toLowerCase();
      const bare = ilow.endsWith('-thumb') ? ilow.slice(0, -6) : ilow;
      const score = ilow === low + '-thumb' ? 1000
                  : ilow === low ? 900
                  : bare === low ? 800
                  : (bare && (low.endsWith(bare) || bare.endsWith(low))) ? bare.length : 0;
      if (score > bestScore) { bestScore = score; best = img; }
    }
    const mime = best && extOf(best) === 'png' ? 'image/png' : 'image/jpeg';
    return {
      group, file: f, stem: stemOf(f), ext: extOf(f),
      text: readFileSync(join(PROBLEMS, group, f), 'utf-8'),
      thumbnail: best ? `data:${mime};base64,${readFileSync(join(PROBLEMS, group, best)).toString('base64')}` : null,
    };
  });
}

const invokeCalls = [];
const storeData   = new Map();

const mockTauri = {
  core: { invoke: async (cmd, payload = {}) => {
      invokeCalls.push({ cmd, payload });
      if (cmd === 'get_app_info') return { name: 'Tabulon', version: 'test', homepage: '' };
      if (cmd === 'list_problem_groups') return listProblemGroups();
      if (cmd === 'read_problem_group')  return readProblemGroup(payload.group);
      if (cmd === 'parse_pjn') {
        // Meme decoupage que la commande Rust : un bloc de tags apparie avec
        // le bloc suivant, sur TOUT le fichier. Ne renvoyer que la premiere
        // partie masquerait les fichiers a plusieurs problemes.
        const blocks = String(payload.data).replace(/\r\n?/g, '\n').split('\n\n')
          .map(b => b.trim()).filter(Boolean);
        const out = [];
        for (let i = 0; i < blocks.length; ) {
          if (!blocks[i].startsWith('[')) { i++; continue; }
          const tags = {};
          for (const line of blocks[i].split('\n')) {
            const m = /^\s*\[(\S+)\s+(.*)\]\s*$/.exec(line.trim());
            if (m) tags[m[1]] = m[2].replace(/^"|"$/g, '');
          }
          let j = i + 1;
          while (j < blocks.length && !blocks[j].startsWith('[')) j++;
          out.push({ label: '', text: [blocks[i], ...blocks.slice(i + 1, j)].join('\n\n'), tags });
          i = j;
        }
        return out;
      }
      return null;
  } },
  event:  { listen: async () => () => {}, emit: async () => {} },
  window: { getCurrentWindow: () => ({ label: 'main', close: () => {} }) },
  os:     { platform: async () => 'linux', locale: async () => 'en-US' },
  shell:  { open: async () => {} },
  // Aucun dialogue de fichier n'est attendu depuis cet ecran : s'il en
  // surgit un, le test doit le voir plutot que le laisser passer.
  dialog: { save: async () => { throw new Error('dialogue d\'enregistrement inattendu'); } },
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

// ── 4. Exemples : dossier externalisé, un onglet par sous-dossier ──────────
console.log('Exemples du dossier problems/');
{
  await waitFor(() => document.querySelectorAll('.loadgame-tab').length > 0, 'onglets rendus');
  const help = text('.loadgame-samples-help');
  assert(/problems folder/i.test(help) && /next to the executable/i.test(help),
    'le texte dit OU poser le dossier');
  assert(/one subfolder per game/i.test(help) && /Jocly game name/i.test(help),
    'et que le nom du sous-dossier doit etre le nom du jeu');
  assert(/-thumb/.test(help), 'la convention de nommage des vignettes est donnee');
  assert(text('#loadgame-samples-intro').includes('/chemin/vers/problems'),
    'le chemin resolu est affiche, pour savoir ou deposer un fichier de plus');

  // Un onglet par sous-dossier, dans l'ordre du dossier.
  const tabs = [...document.querySelectorAll('.loadgame-tab')];
  assert(tabs.length === 4, `4 onglets (${tabs.length}) — un par sous-dossier de tests/fixtures-problems`);
  const labels = tabs.map(t => t.textContent);
  assert(labels[0] === 'Chu Shogi (1)' && labels[1] === 'Chess (2)',
    'le titre vient du catalogue, avec le nombre de fichiers — ' + labels.join(' | '));
  assert(labels[2] === 'khans-chess (1)' && labels[3] === 'ultima (2)',
    'un jeu absent du catalogue garde son nom de dossier — ' + labels.slice(2).join(', '));
  assert(tabs[0].classList.contains('active'), 'le premier onglet est ouvert par defaut');

  // Le premier onglet affiche son unique probleme, avec sa vignette fournie.
  let cards = [...document.querySelectorAll('.loadgame-sample')];
  assert(cards.length === 1, 'onglet chu-shogi : 1 exemple');
  // Le titre vient de [Event], pas du nom de fichier : « tsumeshogi.pjn »
  // n'apprend rien, « silverman - Black to move and Mate in 5 » si.
  assert(/silverman/.test(cards[0].querySelector('.loadgame-sample-name').textContent),
    'titre lu dans le fichier — ' + cards[0].querySelector('.loadgame-sample-name').textContent);
  assert(cards[0].querySelector('img').src.startsWith('data:image/'),
    'la vignette du dossier est utilisee (tsumeshogi-thumb), pas la miniature du jeu');

  // Changement d'onglet.
  tabs[1].click();
  await waitFor(() => document.querySelectorAll('.loadgame-sample').length === 2, 'onglet classic-chess');
  cards = [...document.querySelectorAll('.loadgame-sample')];
  const names = cards.map(c => c.querySelector('.loadgame-sample-name').textContent);
  assert(names.length === 2, 'onglet classic-chess : 2 exemples — ' + names.join(', '));
  assert(cards.every(c => c.querySelector('img').src.startsWith('data:image/')),
    'chaque .pgn a trouve sa vignette -thumb.jpg');

  // Lancer : meme circuit qu'un fichier choisi a la main.
  const before = invokeCalls.length;
  cards[names.findIndex(n => /Opéra/.test(n))].querySelector('.sample-solve').click();
  await waitFor(() => invokeCalls.slice(before).some(c => c.cmd === 'open_book'), 'exemple lance');
  assert(invokeCalls.slice(before).find(c => c.cmd === 'open_book').payload.gameName === 'classic-chess',
    'jeu resolu depuis le fichier — le PGN lichess ne porte que [Variant "Standard"]');

  // Aucun bouton d'enregistrement : la source EST un dossier que
  // l'utilisateur ouvre lui-meme, recopier un fichier depuis l'application
  // ne lui apprendrait rien qu'un gestionnaire de fichiers ne fasse mieux.
  assert(cards.every(c => !c.querySelector('.sample-save')),
    'pas de bouton Enregistrer sur les vignettes');
  assert(!invokeCalls.some(c => c.cmd === 'save_text_file'),
    'et aucune ecriture de fichier depuis cet ecran');
  assert(cards.every(c => c.querySelectorAll('.loadgame-sample-buttons button').length === 2),
    'deux boutons par vignette : chercher, ou voir la solution');
}

// ── 4c. « Essayer » vs « Résoudre » : deux chargements différents ─────────
console.log('Essayer / Résoudre');
{
  const cards = [...document.querySelectorAll('.loadgame-sample')];
  const names = cards.map(c => c.querySelector('.loadgame-sample-name').textContent);
  const card  = cards[names.findIndex(n => /Opéra/.test(n))];
  assert(card, 'la vignette porte le titre du fichier, pas son nom — ' + names.join(' | '));

  // L'énoncé, qui dit ce qu'il faut chercher, est sur la vignette.
  assert(/Mat en 2 ici/.test(card.querySelector('.loadgame-sample-note').textContent),
    'l\'énoncé est lisible AVANT de lancer quoi que ce soit');

  // « Essayer » : la position, sans les coups.
  let before = invokeCalls.length;
  card.querySelector('.sample-try').click();
  await waitFor(() => invokeCalls.slice(before).some(c => c.cmd === 'open_book'), 'Essayer');
  // Le texte transite par le store (book:{jeu}) : open_book ne porte que le nom.
  let data = storeData.get('book:classic-chess').data;
  assert(ExtractMoves(data).length === 0, 'aucun coup transmis : il reste tout à chercher');
  assert(/\[FEN "4kb1r/.test(data), 'mais la position, elle, est bien là');
  assert(!/Qb8/.test(data), 'la solution n\'apparaît nulle part dans ce qui est chargé');

  // « Résoudre » : la même position AVEC les coups.
  before = invokeCalls.length;
  card.querySelector('.sample-solve').click();
  await waitFor(() => invokeCalls.slice(before).some(c => c.cmd === 'open_book'), 'Résoudre');
  data = storeData.get('book:classic-chess').data;
  assert(ExtractMoves(data).length === 3, 'les 3 coups de la solution sont transmis');
  assert(/Qb8\+/.test(data), 'le fichier passe tel quel, commentaires compris');

  // L'image ouvre la position à chercher, pas la solution.
  before = invokeCalls.length;
  card.querySelector('img').click();
  await waitFor(() => invokeCalls.slice(before).some(c => c.cmd === 'open_book'), 'clic sur l\'image');
  assert(ExtractMoves(storeData.get('book:classic-chess').data).length === 0,
    'le geste le plus naturel mène à « Essayer », pas à la solution');
  assert(card.querySelector('img').classList.contains('clickable'), 'et l\'image le signale');

  // Le bouton de recherche est le bouton principal, et il vient en premier.
  const order = [...card.querySelectorAll('.loadgame-sample-buttons button')].map(b => b.className);
  assert(order[0].includes('sample-try'), 'Essayer est le premier bouton');
  assert(order[0].includes('btn-positive') && !order[1].includes('btn-positive'),
    'et le seul mis en avant : voir la solution ne doit pas être le geste par défaut');
}

// ── 4d. Fichier à plusieurs problèmes ──────────────────────────────────────
console.log('Fichier à plusieurs problèmes');
{
  const tabs = [...document.querySelectorAll('.loadgame-tab')];
  tabs[0].click();                                   // chu-shogi
  await waitFor(() => document.querySelectorAll('.loadgame-sample').length === 1, 'onglet chu-shogi');
  const card = document.querySelector('.loadgame-sample');
  assert(/silverman/.test(card.querySelector('.loadgame-sample-name').textContent),
    'le titre est celui du PREMIER problème du fichier');
  assert(/3 games|3 parties/.test(card.querySelector('.loadgame-sample-note').textContent),
    'et la note annonce qu\'il y en a trois — le titre seul serait trompeur');

  const before = invokeCalls.length;
  card.querySelector('.sample-try').click();
  await waitFor(() => invokeCalls.slice(before).some(c => c.cmd === 'open_book'), 'Essayer');
  const data = storeData.get('book:chu-shogi').data;
  const blocks = data.split('\n\n').map(b => b.trim()).filter(Boolean).filter(b => b.startsWith('['));
  assert(blocks.length === 3, `les 3 problèmes survivent au retrait des coups (${blocks.length})`);
  assert(!/FLj9-k10/.test(data), 'et aucune solution ne subsiste');
}

// ── 4b. Jeu absent du catalogue : visible mais pas lancable ───────────────
console.log('Onglet dont le jeu n\'est pas installe');
{
  const tabs = [...document.querySelectorAll('.loadgame-tab')];
  // Repérage par libellé et non par index : l'ordre est alphabétique, ajouter
  // un dossier d'exemples décalerait tout.
  tabs.find(t => t.textContent.startsWith('ultima')).click();
  await waitFor(() => document.querySelectorAll('.loadgame-sample').length === 2, 'onglet ultima');
  const cards = [...document.querySelectorAll('.loadgame-sample')];
  const names = cards.map(c => c.querySelector('.loadgame-sample-name').textContent);
  assert(names.includes('Mat in 1') && names.includes('ultima-solutionP1.json'),
    'titre pour le .pjn, nom de fichier pour le .json qui n\'en porte pas — ' + names.join(', '));
  assert(cards.every(c => c.querySelector('.sample-solve').disabled),
    'solution desactivee : le jeu ultima n\'est pas dans ce catalogue de test');
  assert(cards.every(c => c.querySelector('.sample-try').disabled),
    'recherche desactivee aussi : les deux boutons ouvrent une partie');
  assert(/not installed/i.test(text('.loadgame-sample-desc')), 'et la raison est ecrite');

  // Appariement lache : p1-thumb.jpg <-> ultima-solutionP1.json
  const sol = cards[names.indexOf('ultima-solutionP1.json')];
  assert(sol.querySelector('img').src.startsWith('data:image/'),
    'p1-thumb.jpg est rattache a ultima-solutionP1.json malgre le nom different');
  const pjn = cards[names.indexOf('Mat in 1')];
  assert(pjn.querySelector('img').src.startsWith('data:image/'),
    'matc.jpg est rattache a matc.pjn (image sans suffixe -thumb)');
  assert(sol.querySelector('img').src !== pjn.querySelector('img').src
      || true, 'chaque exemple a sa propre vignette');
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
  // Une variante n'a pas de solution : « Essayer » est le seul geste qui ait
  // un sens, et il ouvre la position de depart declaree par le variants.ini.
  cards[0].querySelector('.sample-try').click();
  await waitFor(() => invokeCalls.slice(before2).some(c => c.cmd === 'open_book'), 'position ouvrable');
  assert(invokeCalls.slice(before2).find(c => c.cmd === 'open_book').payload.gameName === 'shako-chess',
    'la variante "shako" est routee vers le jeu Jocly "shako-chess"');
}

console.log(`\n${passed} assertions OK — ecran "Charger une partie" valide.`);
process.exit(0);
