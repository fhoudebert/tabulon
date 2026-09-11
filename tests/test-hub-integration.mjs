// test-hub-integration.mjs — smoke test de la navigation unifiée du hub.
//
// Exécute le VRAI app/content/hub.js contre le VRAI app/content/hub.html
// (jsdom) avec le VRAI dist/ de jocly2 (API node, fullPath injecté comme le
// fait le build browser). Seul window.__TAURI__ est mocké (invoke/event/
// store/os/window), exactement ce que Tauri injecte au runtime.
//
// Usage : node test-hub-integration.mjs   (depuis tabulon/, après npm i jsdom dans app/)
import { JSDOM } from '../app/node_modules/jsdom/lib/api.js';
process.chdir(new URL('..', import.meta.url).pathname);   // cwd = racine tabulon/
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);

// ── Mock Tauri ────────────────────────────────────────────────────────────────
const invokeCalls = [];                 // [{cmd, payload}]
const eventHandlers = {};               // eventName -> [fn]
const storeData = new Map();            // store en mémoire
let favorites = null;                   // état "Rust" des favoris (null = défauts)

const mockTauri = {
  core: {
    invoke: async (cmd, payload = {}) => {
      invokeCalls.push({ cmd, payload });
      switch (cmd) {
        case 'get_app_info': return { name: 'Tabulon', version: 'test', homepage: 'https://example.org' };
        case 'is_favorite':  return !!(favorites && favorites[payload.gameName]);
        case 'play_template':
          return { gameName: 'classic-chess', gameData: { game: 'classic-chess', playedMoves: [] }, clock: null };
        case 'set_favorite':
          favorites = favorites || {};
          if (payload.value) favorites[payload.gameName] = Date.now();
          else delete favorites[payload.gameName];
          return null;
        default: return null;
      }
    },
  },
  event: {
    listen: async (name, fn) => { (eventHandlers[name] ??= []).push(fn); return () => {}; },
    emit: async () => {},
  },
  window: { getCurrentWindow: () => ({ label: 'main', close: () => {} }) },
  os:     { platform: async () => 'linux' },
  shell:  { open: async () => {} },
  store:  { Store: class { static async load() { return {
      get: async (k) => storeData.get(k),
      set: async (k, v) => { storeData.set(k, v); },
  }; } } },
};

// ── DOM : vrai hub.html, scripts non exécutés (hub.js importé ensuite) ───────
const html = readFileSync('./app/content/hub.html', 'utf-8')
  .replace(/<script[\s\S]*?<\/script>/g, '');   // on n'exécute pas jquery/jocly ici
const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/hub.html' });

globalThis.window = dom.window;
globalThis.document = dom.window.document;
dom.window.__TAURI__ = mockTauri;

// ── Jocly : dist réel, chemin d'exécution *browser* ──────────────────────────
// jocly.core.js détecte `window` → branche browser → BrowserScriptLoader.
// On shime BrowserScriptLoader : getBaseURL comme Tauri, import → require des
// mêmes modules CJS du dist/node (mêmes fichiers de config que le browser).
// On exerce ainsi le vrai code de résolution thumbnail/fullPath du dist.
const BASE = 'https://tauri.localhost/';
dom.window.BrowserScriptLoader = {
  getBaseURL: () => BASE,
  import: (p) => Promise.resolve(require('../dist/node/' + p)),
};
globalThis.Jocly = require('../dist/node/jocly.core.js');

// ── Exécution du vrai hub.js ──────────────────────────────────────────────────
await import('../app/content/hub.js');
document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return; await sleep(25); }
  throw new Error('timeout: ' + what);
}
const $  = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
  console.log('  ✓ ' + msg); passed++;
}

// 1. Démarrage : nav par défaut = Favorites (defaultFavorites, 10 jeux)
await waitFor(() => $$('#game-list li').length > 0, 'liste initiale rendue');
assert($('#nav-games-fav').classList.contains('active'), 'nav par défaut = Favorites');
assert($$('#game-list li').length === 10, `Favorites affiche 10 jeux (défauts) — trouvé ${$$('#game-list li').length}`);
assert($('#game-detail-empty').style.display !== 'none', 'panneau détail vide au départ (pas de last-game)');

// 2. Nav All → tout le catalogue
// Le nombre est LU dans le dist, pas écrit en dur : il change à chaque jeu
// ajouté en amont (125 → 128 → 129 au fil des versions de jocly), et un
// chiffre figé transforme chaque mise à jour du dist en faux échec. Ce qu'on
// veut vérifier ici, c'est que « All » n'oublie ni ne duplique rien.
const catalogSize = Object.keys(await globalThis.Jocly.listGames()).length;
$('#nav-games-all').click();
await waitFor(() => $$('#game-list li').length > 100, 'liste All rendue');
assert($$('#game-list li').length === catalogSize,
  `All affiche tout le catalogue (${catalogSize} jeux) — trouvé ${$$('#game-list li').length}`);
assert($$('#game-list li img')[0].src.includes('/games/'), 'thumbnails de liste résolus via baseURL/games/');

// 2b. Raccourcis de liste : 4 icônes sur chaque item
const li0 = $$('#game-list li')[0];
assert(li0.querySelector('.list-shortcut-play .icon-play'), 'raccourci play présent');
assert(!li0.querySelector('.list-shortcut-clock'),
  'raccourci horloge RETIRÉ de la liste (manque de place) — Clocked play reste dans le détail');
assert(li0.querySelector('.list-shortcut-info .icon-info-circled') && li0.querySelector('.list-shortcut-fav'),
  'raccourcis info + favori présents');
li0.querySelector('.list-shortcut-info').click();
assert(invokeCalls.some(c => c.cmd === 'open_info' && c.payload.gameName === li0.dataset.game),
  'clic icône i → open_info(jeu)');

// 2c. Étoile de favori : état + bascule optimiste + set_favorite
//     (on est dans All : le 1er jeu par ordre alphabétique n'est pas un favori par défaut)
assert(li0.querySelector('.list-shortcut-fav .icon-star-empty'), 'jeu non favori : étoile vide');
li0.querySelector('.list-shortcut-fav').click();
assert(li0.querySelector('.list-shortcut-fav .icon-star'), 'clic : étoile pleine immédiatement (optimiste)');
await waitFor(() => invokeCalls.some(c => c.cmd === 'set_favorite' && c.payload.gameName === li0.dataset.game && c.payload.value === true),
  'set_favorite(true) envoyé');
li0.querySelector('.list-shortcut-fav').click();
await waitFor(() => invokeCalls.some(c => c.cmd === 'set_favorite' && c.payload.gameName === li0.dataset.game && c.payload.value === false),
  'set_favorite(false) au 2e clic');
assert(li0.querySelector('.list-shortcut-fav .icon-star-empty'), 'étoile redevenue vide');
assert(!li0.classList.contains('active'), 'le clic raccourci ne change pas la sélection (stopPropagation)');

// 3. Sélection d'un jeu → panneau de détail (navigation interne, pas de fenêtre)
const liChess = $$('#game-list li').find(li => li.dataset.game === 'classic-chess');
liChess.click();
await waitFor(() => $('#game-detail-body').style.display !== 'none', 'détail affiché');
assert($('#game-detail .game-title').textContent === 'Chess', 'titre du jeu rendu');
assert($('#game-detail .game-summary').textContent.includes('Chess'), 'résumé rendu');
assert(liChess.classList.contains('active'), 'élément de liste surligné');
assert($('#game-list-pane').classList.contains('show-detail'), 'classe show-detail posée (vue tablette)');
assert(!invokeCalls.some(c => c.cmd === 'open_game'), 'aucun appel open_game (navigation interne)');
assert(storeData.get('last-game') === 'classic-chess', 'last-game persisté');

// 4. Visuels animés 600x600 (classic-chess en a 2)
await waitFor(() => $$('#game-detail .visuals > div > div').length === 2, 'visuels injectés');
const shown = $$('#game-detail .visuals > div > div').filter(d => d.style.opacity === '1');
assert(shown.length === 1, 'exactement un visuel visible (rotation crossfade)');
assert(shown[0].style.backgroundImage.includes('/games/chessbase/res/visuals/'), 'URL visuel = fullPath + chemin 600x600');

// 5. Boutons d'action → bonnes commandes RPC sur le bon jeu
$('#quickplay').click();
assert(invokeCalls.some(c => c.cmd === 'new_match' && c.payload.gameName === 'classic-chess'), 'Quick play → new_match(classic-chess)');
$('#clockedplay').click();
assert(invokeCalls.some(c => c.cmd === 'open_clock_setup' && c.payload.gameName === 'classic-chess'), 'Clocked play → open_clock_setup');
$('#info').click();
assert(invokeCalls.some(c => c.cmd === 'open_info'), 'Rules → open_info');
$('#boardstate').click();
assert(invokeCalls.some(c => c.cmd === 'open_board_state'), 'Board state → open_board_state');

// 6. Favoris : classic-chess n'est pas favori (état mock vide) → bouton "Not favorite"
await waitFor(() => $('#favorite').style.display !== 'none', 'bouton favorite visible');
$('#favorite').click();
await waitFor(() => invokeCalls.some(c => c.cmd === 'set_favorite' && c.payload.value === true), 'set_favorite envoyé');
// Simuler le push Rust updateFavorites (comme le vrai backend après set_favorite)
for (const fn of eventHandlers['updateFavorites'] || []) fn({ payload: [favorites] });
await waitFor(() => $('#unfavorite').style.display !== 'none' && $('#favorite').style.display === 'none', 'bascule vers Unfavorite');
assert(true, 'set_favorite → push updateFavorites → bouton basculé');

// 7. Templates filtrés par jeu : push updateTemplates avec 1 template chess + 1 autre
storeData.set('templates', {
  'Ma partie rapide': { gameName: 'classic-chess', lastUsed: 2 },
  'Dames blitz':      { gameName: 'draughts',      lastUsed: 1 },
});
for (const fn of eventHandlers['updateTemplates'] || []) fn({ payload: [Object.fromEntries(storeData.get('templates') ? Object.entries(storeData.get('templates')) : [])] });
await waitFor(() => $$('#game-detail .template').length === 1, 'template du jeu affiché');
assert($('#game-detail .template').textContent === 'Ma partie rapide', 'seul le template de classic-chess apparaît');
assert($('#game-detail .templates-block').style.display !== 'none', 'bloc Templates visible');
$('#game-detail .template').click();
await waitFor(() => invokeCalls.some(c => c.cmd === 'play_template' && c.payload.templateName === 'Ma partie rapide'), 'play_template appelé');
// play_template retourne les données (mock) → le hub doit LANCER la partie
await waitFor(() => invokeCalls.some(c => c.cmd === 'new_match' && String(c.payload.forkId || '').startsWith('tpl-')),
  'clic template → new_match');
const tplLaunch = invokeCalls.find(c => c.cmd === 'new_match' && String(c.payload.forkId || '').startsWith('tpl-'));
assert(storeData.get('fork:' + tplLaunch.payload.forkId)?.game === 'classic-chess',
  'clic template → gameData déposé sous fork:{tpl-…} puis new_match (l\'ancien code ignorait le retour)');

// 8. Changement de jeu : visuels nettoyés et remplacés, favoris re-synchronisés
// (le push updateFavorites de l'étape 6 a re-rendu la liste pour rafraîchir
// les étoiles — on re-requête les <li> vivants plutôt que les nœuds détachés)
const liveLi = (name) => $$('#game-list li').find(li => li.dataset.game === name);
const liDraughts = liveLi('draughts');
liDraughts.click();
await waitFor(() => $('#game-detail .game-title').textContent === 'International Draughts', 'détail draughts rendu');
assert($$('#game-detail .visuals > div > div').every(d => d.style.backgroundImage.includes('draughts')), 'anciens visuels purgés, nouveaux injectés');
assert(!liveLi('classic-chess').classList.contains('active') && liDraughts.classList.contains('active'), 'surlignage déplacé');
await waitFor(() => $$('#game-detail .template').length === 1 && $('#game-detail .template').textContent === 'Dames blitz',
  'templates re-filtrés pour le nouveau jeu');
assert(true, 'templates de chess retirés, template de draughts affiché (filtre par jeu OK)');

// 9. Bouton retour (vue étroite) → show-detail retirée
$('#detail-back').click();
assert(!$('#game-list-pane').classList.contains('show-detail'), 'retour liste : show-detail retirée');

// 10. Jeu sans visuels 600x600 (cubic-chess) → conteneur vide, pas d'erreur
const liCubic = liveLi('cubic-chess');
liCubic.click();
await waitFor(() => $('#game-detail .game-title').textContent.length > 0 && $('#game-detail .game-title').textContent !== 'International Draughts', 'détail cubic-chess rendu');
assert($$('#game-detail .visuals > div > div').length === 0, 'cubic-chess (sans 600x600) : visuels vides sans erreur');

// 11. Restauration au redémarrage : last-game présent → détail restauré SANS show-detail
//     (on simule en revérifiant l'état du store)
assert(storeData.get('last-game') === 'cubic-chess', 'last-game suit la sélection');

/* ── 12. Le réglage d'affichage des visuels ─────────────────────────────────
 *
 * Les visuels de fond sont de grandes images livrées avec la ludothèque, et
 * souvent les premières supprimées quand la place manque. Le fond enchaînait
 * alors des fondus sur RIEN, toutes les cinq secondes, sans que rien ne
 * l'explique. D'où l'interrupteur — dans le hub, et pas dans la fenêtre
 * « Options d'affichage », qui est ouverte avec un numéro de partie et
 * dialogue avec sa fenêtre de jeu.
 */
{
    const nav = $('#nav-display');
    assert(!!nav, 'la configuration porte une entrée Affichage');
    nav.click();
    await waitFor(() => $('#display').style.display === '', 'le panneau Affichage s\'ouvre');
    assert(storeData.get('nav-last') === 'display', 'la navigation retient le panneau');

    const box = $('#display-visuals');
    assert(box && box.checked, 'les visuels sont affichés par défaut');

    // Décoché : le conteneur se VIDE et le minuteur s'arrête. Rendre les
    // images transparentes ne suffirait pas — le fondu continuerait à tourner
    // en arrière-plan toutes les cinq secondes.
    box.checked = false;
    box.dispatchEvent(new dom.window.Event('change'));
    await waitFor(() => storeData.get('hub-visuals') === false, 'le choix est persisté');

    liveLi('classic-chess').click();
    await waitFor(() => $('#game-detail .game-title').textContent.includes('Chess'), 'détail rouvert');
    assert($$('#game-detail .visuals > div > div').length === 0,
        'réglage éteint : aucun visuel injecté, même pour un jeu qui en a');

    // Et rallumé, ils reviennent : un interrupteur qui n'a qu'un sens n'en est
    // pas un.
    box.checked = true;
    box.dispatchEvent(new dom.window.Event('change'));
    await waitFor(() => $$('#game-detail .visuals > div > div').length === 2,
        'réglage rallumé : les visuels reviennent sans changer de jeu');
    assert(storeData.get('hub-visuals') === true, 'et le choix inverse est persisté aussi');
}

/* ── 13. Les trousseaux de communauté ───────────────────────────────────────
 *
 * Le secret partagé UNE FOIS avec un groupe, et qui protège ensuite toutes les
 * parties jouées avec lui. PLUSIEURS plutôt qu'un seul : un club, une famille
 * et une compétition n'ont pas à pouvoir se lire les uns les autres.
 */
{
    const list = $('#prefs-key-list');
    const name = $('#prefs-key-name');
    const key  = $('#prefs-community-key');
    assert(!!list && !!name && !!key, 'l’écran Préférences porte la liste et les deux champs');
    assert(list.options.length === 0, 'vide tant qu’aucun trousseau n’existe');

    $('#prefs-key-add').click();
    await waitFor(() => list.options.length === 1, 'Nouveau crée un trousseau');
    name.value = 'Club du mardi';
    $('#prefs-key-new').click();
    await waitFor(() => /^[0-9a-f]{64}$/.test(key.value), 'Générer produit une clé');
    // PAS enregistrée tout de suite : tant qu'on ne l'a pas transmise,
    // l'enregistrer rendrait nos messages illisibles pour les autres sans rien
    // dire. C'est « Enregistrer » qui engage.
    assert(!(storeData.get('community-keys') || [])[0]?.key, 'générer n’enregistre pas encore');

    const generated = key.value;
    $('#prefs-key-save').click();
    await waitFor(() => (storeData.get('community-keys') || [])[0]?.key === generated,
        'Enregistrer range la clé');
    assert(storeData.get('community-keys')[0].name === 'Club du mardi', 'avec son nom');
    assert(storeData.get('community-key-current') === storeData.get('community-keys')[0].id,
        'et c’est celui-là qui est sélectionné');

    // Un second trousseau : c'est le point de la liste.
    $('#prefs-key-add').click();
    await waitFor(() => list.options.length === 2, 'un second trousseau s’ajoute');
    name.value = 'Famille';
    key.value = 'b'.repeat(64);
    $('#prefs-key-save').click();
    await waitFor(() => storeData.get('community-keys')[1]?.key === 'b'.repeat(64), 'et s’enregistre');
    assert(storeData.get('community-keys')[1].key === 'b'.repeat(64), 'sans toucher au premier');
    assert(storeData.get('community-keys')[0].key === generated, 'qui est toujours là');

    // Un format inattendu est refusé plutôt qu'enregistré : une clé à moitié
    // valide ne protège rien et en donne l'apparence.
    key.value = 'pas une clé';
    $('#prefs-key-save').click();
    await sleep(40);
    assert(storeData.get('community-keys')[1].key === 'b'.repeat(64),
        'une clé mal formée ne remplace pas la bonne');

    $('#prefs-key-del').click();
    await waitFor(() => storeData.get('community-keys').length === 1, 'Supprimer retire le trousseau');
    assert(storeData.get('community-keys')[0].name === 'Club du mardi', 'et laisse les autres');
}

/* ── 14. Le chemin de ffmpeg ────────────────────────────────────────────────
 *
 * L'enregistrement vidéo appelle un binaire qui n'est pas livré avec Tabulon.
 * Sous Linux il coexiste souvent en plusieurs exemplaires, et celui du PATH
 * n'est pas toujours celui qui sait encoder en H.264 — d'où un réglage, seul
 * moyen d'en désigner un autre sans toucher au système.
 */
{
    const field = $('#prefs-ffmpeg-path');
    assert(!!field, 'l’écran Préférences porte un champ pour ffmpeg');
    assert(field.value === '', 'vide par défaut : on emploie celui du système');

    field.value = '/opt/ffmpeg-7/bin/ffmpeg';
    $('#prefs-ffmpeg-save').click();
    await waitFor(() => storeData.get('ffmpeg-path') === '/opt/ffmpeg-7/bin/ffmpeg',
        'le chemin est enregistré');

    // Vider le champ revient à reprendre celui du PATH : c'est un état normal,
    // pas un effacement de réglage.
    field.value = '   ';
    $('#prefs-ffmpeg-save').click();
    await waitFor(() => storeData.get('ffmpeg-path') === '', 'un champ vide rend la main au système');
    assert(storeData.get('ffmpeg-path') === '', 'sans laisser d’espaces derrière');
}

console.log(`\n${passed} assertions OK — navigation unifiée du hub validée.`);
process.exit(0);
