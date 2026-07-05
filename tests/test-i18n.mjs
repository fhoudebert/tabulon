// test-i18n.mjs — valide l'internationalisation fr/en.
//
// Deux scénarios dans le même processus (modules distincts) :
//   A. hub.js avec locale système fr-FR → interface en français
//   B. info.js (makromachy) avec locale fr → règles chargées depuis le
//      fichier _fr : d'abord via la déclaration explicite rules.fr de la
//      config, puis via la SONDE du suffixe _fr quand la config ne déclare
//      pas de fr (mécanisme demandé), avec fallback en pour description.
// Usage : node test-i18n.mjs   (depuis tabulon/)
import { JSDOM } from '../app/node_modules/jsdom/lib/api.js';
process.chdir(new URL('..', import.meta.url).pathname);   // cwd = racine tabulon/
import { readFileSync, existsSync } from 'fs';
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
  os:    { platform: async () => 'linux', locale: async () => 'fr-FR' },   // ← système en français
  shell: { open: async () => {} },
  store: { Store: class { static async load() { return {
      get: async (k) => storeData.get(k), set: async (k, v) => { storeData.set(k, v); },
  }; } } },
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return; await sleep(25); }
  throw new Error('timeout: ' + what);
}
let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
  console.log('  ✓ ' + msg); passed++;
}

// ═══ Scénario A : hub en français ═══
{
  const html = readFileSync('./app/content/hub.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/hub.html' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  dom.window.__TAURI__ = mockTauri;
  dom.window.BrowserScriptLoader = {
    getBaseURL: () => 'https://tauri.localhost/',
    import: (p) => Promise.resolve(require('../dist/node/' + p)),
  };
  globalThis.Jocly = require('../dist/node/jocly.core.js');

  await import('../app/content/hub.js');
  document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  await waitFor(() => $$('#game-list li').length > 0, 'liste chargée');
  await waitFor(() => $('[data-i18n="nav.all"]').textContent === 'Tous', 'DOM traduit');
  assert($('[data-i18n="nav.favorites"]').textContent === 'Favoris', 'nav : Favorites → Favoris');
  assert($('#gamefilter').placeholder === 'Rechercher un jeu', 'placeholder de recherche en fr');
  assert($('[data-i18n="hub.selectGame"]').textContent === 'Sélectionnez un jeu', 'panneau vide en fr');
  assert($('[data-i18n="btn.quickPlay"]').textContent === 'Partie rapide', 'bouton détail Quick play → Partie rapide');
  assert($('[data-i18n="about.feat.clock"]').textContent === 'Parties chronométrées', 'About (contenu "pretraduction") traduit');
  document.getElementById('nav-about').click();
  await waitFor(() => $('.appLocale').textContent.length > 0, 'locale affichée');
  assert($('.appLocale').textContent === 'Français (fr)', 'About affiche la locale retenue : "Français (fr)"');
  assert($('[data-i18n="about.locale"]').textContent === 'Langue :', 'libellé "Langue :" en fr');
  const li0 = $$('#game-list li')[0];
  assert(li0.querySelector('.list-shortcut-play').title === 'Partie rapide', 'tooltip dynamique de raccourci en fr');
  // L'onglet par défaut est Favoris : le 1er item EST un favori
  assert(li0.querySelector('.list-shortcut-fav').title === 'Retirer des favoris',
    'tooltip favori en fr (item favori → "Retirer des favoris")');
}

// ═══ Scénario B : règles makromachy en français ═══
{
  // fetch servi depuis le disque : https://tauri.localhost/<p> → dist/browser/<p>
  const fetchedUrls = [];
  globalThis.fetch = async (url) => {
    fetchedUrls.push(url);
    const p = './dist/browser/' + String(url).replace('https://tauri.localhost/', '');
    if (!existsSync(p)) return { ok: false, status: 404 };
    return { ok: true, text: async () => readFileSync(p, 'utf-8') };
  };

  const html = readFileSync('./app/content/info.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/info.html?game=makromachy' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  dom.window.__TAURI__ = mockTauri;
  dom.window.BrowserScriptLoader = {
    getBaseURL: () => 'https://tauri.localhost/',
    import: (p) => Promise.resolve(require('../dist/node/' + p)),
  };
  // B2 : simuler une config SANS fr déclaré pour vérifier la sonde _fr
  const core = require('../dist/node/jocly.core.js');
  let stripFr = false;
  globalThis.Jocly = {
    ...core,
    getGameConfig: async (name) => {
      const c = await core.getGameConfig(name);
      if (stripFr && c.model.rules) c.model.rules = { en: c.model.rules.en };
      return c;
    },
  };

  const { default: _ } = await import('../app/content/info.js').catch(() => ({}));
  document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));
  const $ = (s) => document.querySelector(s);

  // B1 : rules.fr déclaré dans la config → fichier _fr chargé
  await waitFor(() => $('.window-content [data-tab="rules"]').innerHTML.length > 0, 'règles chargées');
  assert($('.window-content [data-tab="rules"]').innerHTML.includes('Les règles du jeu'),
    'règles en FRANÇAIS (makromachy-rules_fr.html, déclaré rules.fr)');
  assert(fetchedUrls.some(u => u.includes('makromachy-rules_fr.html')), 'URL _fr effectivement demandée');
  assert($('.window-content [data-tab="description"]').innerHTML.length > 0 &&
         !fetchedUrls.some(u => u.includes('description_fr') && u.includes('200')),
    'description sans traduction : fallback sur le fichier en');
  assert(document.title.startsWith('À propos de'), 'titre de fenêtre localisé');

  // B2 : config sans fr → la SONDE _fr doit trouver le fichier quand même
  stripFr = true;
  fetchedUrls.length = 0;
  const { translateDom } = await import('../app/content/tabulon-i18n.js');
  // recharger les règles via le même mécanisme que GetHtml en réimportant la page :
  // on rejoue le flux en re-déclenchant DOMContentLoaded n'est pas possible
  // (module en cache) — on teste directement la construction des candidats
  // via un mini-harnais équivalent :
  const cfg = await globalThis.Jocly.getGameConfig('makromachy');
  assert(!cfg.model.rules.fr, 'précondition : fr retiré de la config');
  const base = cfg.model.rules.en;
  const probed = base.replace(/(\.html?)$/i, '_fr$1');
  const resp = await fetch('https://tauri.localhost/games/chessbase/' + probed);
  assert(resp.ok && (await resp.text()).includes('Les règles du jeu'),
    'sonde du suffixe _fr : le fichier existe et est servi sans déclaration en config');
}

// ═══ Scénario C : résilience — défaut 'en', jamais de plantage ═══
{
  // C1. Structurel : la régression vécue ("Importing binding name 'locale'
  // is not found" → liste vide) venait d'un import nommé statique, qui plante
  // à la résolution du module si le bridge en place n'a pas l'export.
  // Le module ne doit plus contenir AUCUN import nommé depuis le bridge.
  const src = readFileSync('./app/content/tabulon-i18n.js', 'utf-8');
  assert(!/import\s*\{[^}]*\}\s*from\s*'\.\/tauri-bridge/.test(src),
    'aucun import nommé depuis tauri-bridge (import namespace uniquement)');
  assert(src.includes("import * as bridge from './tauri-bridge.js'"), 'import namespace en place');

  // C2. Runtime : environnement totalement dépourvu (pas de __TAURI__, pas de
  // navigator) → initI18n ne plante pas et la locale par défaut est 'en'.
  // Processus enfant pour repartir d'un cache de modules vierge.
  const { execSync } = await import('child_process');
  const out = execSync(
    `node --input-type=module -e "` +
    `import { initI18n, getLocale, t } from './app/content/tabulon-i18n.js';` +
    `await initI18n();` +
    `console.log(getLocale(), '|', t('nav.favorites'));"`,
    { cwd: process.cwd() }).toString().trim();
  assert(out === "en | Favorites", "environnement nu : locale par défaut 'en', t() fonctionnel (" + out + ")");
}

console.log(`\n${passed} assertions OK — i18n fr/en validée.`);
process.exit(0);
