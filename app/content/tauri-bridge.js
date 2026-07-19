// app/content/tauri-bridge.js
//
// Tabulon n'utilise aucun bundler (vanilla JS, vrais fichiers .html/.js
// servis tels quels par la WebView) : les imports npm classiques
// (`import { invoke } from '@tauri-apps/api/core'`) ne fonctionnent pas
// dans ce contexte — ce sont des "bare specifiers", que seul un bundler
// (Vite, Webpack...) sait résoudre vers le bon fichier de node_modules.
// Sans bundler, le navigateur essaie de les interpréter comme une URL et
// échoue avec "TypeError: Module name ... does not resolve to a valid URL".
//
// La solution documentée par Tauri pour ce cas (vanilla JS sans bundler)
// est d'activer `app.withGlobalTauri` dans tauri.conf.json (déjà fait) et
// de lire l'API depuis `window.__TAURI__` plutôt que via `import`. Ce
// fichier ré-exporte ces sous-objets sous forme de vrais exports ES,
// pour que le reste du code puisse continuer à écrire des imports
// normaux — juste vers ce fichier (chemin relatif, donc valide) plutôt
// que vers le paquet npm :
//
//   import { invoke } from './tauri-bridge.js';        // au lieu de '@tauri-apps/api/core'
//   import { emit, listen } from './tauri-bridge.js';  // au lieu de '@tauri-apps/api/event'
//   import { open } from './tauri-bridge.js';           // au lieu de '@tauri-apps/plugin-shell'
//   import { Store } from './tauri-bridge.js';          // au lieu de '@tauri-apps/plugin-store'
//   etc.
//
// Source de vérité pour ces noms : le script d'injection IIFE de chaque
// plugin (api-iife.js dans les sources des crates tauri-plugin-*), qui
// fait littéralement `Object.defineProperty(window.__TAURI__, "shell", {value: ...})`.
//
// window.__TAURI__ est injecté par Tauri avant que ce module ne soit
// évalué (scripts type="module" sont différés à after-parse, après les
// scripts classiques qui font l'injection) ; si jamais ce n'était pas le
// cas (voir tauri-apps/tauri#12990 pour un cas Windows connu), l'erreur
// serait immédiate et explicite ci-dessous plutôt qu'un échec silencieux
// plus loin dans le code applicatif.

// Les exports sont des wrappers paresseux : window.__TAURI__ (et les
// sous-objets de chaque plugin) sont relus à chaque appel plutôt que
// capturés une fois au chargement de ce module. C'est une garde contre un
// problème de timing documenté (tauri-apps/tauri#12990) où, sur certaines
// configurations, le script d'injection de Tauri ne s'est pas encore
// exécuté au moment où le tout premier <script type="module"> tourne.
// Si jamais cela arrivait ici, l'erreur serait immédiate et explicite à
// l'appel plutôt qu'un required indéfiniment undefined capturé trop tôt.
function tauri() {
    const T = window.__TAURI__;
    if (!T) {
        throw new Error(
            'window.__TAURI__ is undefined — check app.withGlobalTauri in tauri.conf.json.'
        );
    }
    return T;
}

// ── Attente de l'injection Tauri (course perdue sous Windows) ─────────────────
//
// Constate sur Windows 11 : la fenetre principale (creee au setup) marche,
// mais TOUTES les fenetres satellites creees ensuite (partie rapide, aide,
// invitation, extensions...) s'ouvrent blanches avec juste le titre. Cause :
// sous WebView2, les initialization scripts de Tauri (dont l'injection de
// window.__TAURI__ et des sous-objets de chaque plugin) peuvent s'executer
// APRES les <script type="module"> de la page pour une webview creee apres
// le demarrage -- course documentee cote Tauri (tauri-apps/tauri#12990,
// "status: upstream" donc pas corrigee par une montee de version, et
// #12694 pour le cas precis "deuxieme fenetre", inconsistant et sensible a
// la charge CPU). Sur Linux/WebKitGTK l'ordre est fiable, d'ou l'asymetrie.
// Consequence sans cette attente : chaque appel du bridge leve, le boot de
// la page meurt avant initI18n(), tous les elements data-i18n restent
// vides -> page visuellement blanche.
//
// Le remede : un top-level await ci-dessous. Il suspend l'EVALUATION de ce
// module -- donc de tout le graphe d'imports de la page (aucun code
// applicatif ne tourne avant que l'injection soit arrivee), et, par la
// spec HTML des scripts module (differes), il retarde aussi
// DOMContentLoaded : les `document.addEventListener('DOMContentLoaded', ...)`
// des pages restent corrects sans modifier une seule page.

/**
 * L'injection Tauri est-elle complete pour ce que Tabulon utilise ?
 * Predicat PUR (testable sous Node) : verifie window.__TAURI__ ET les
 * sous-objets injectes par les init scripts de chaque plugin employe par ce
 * bridge -- la course peut laisser core present mais un plugin absent.
 * Liste alignee sur les .plugin(...) de src-tauri/src/lib.rs.
 */
export function isTauriInjected(w) {
    const T = w && w.__TAURI__;
    return !!(T && T.core && T.event && T.window && T.webviewWindow
        && T.shell && T.dialog && T.store && T.os);
}

/**
 * Sommes-nous dans une vraie page Tauri (ou l'injection est ATTENDUE) ?
 * Predicat PUR. Discrimine par l'origine de la page : les pages Tabulon
 * sont servies depuis tauri://localhost (Linux/macOS),
 * http(s)://tauri.localhost (Windows) ou le devUrl http://localhost:PORT
 * (mode dev). Les contextes de test (stub `globalThis.window = {...}` des
 * suites Node, sans `location`) et tout autre contexte hors Tauri ne
 * doivent JAMAIS attendre : chez eux l'injection n'arrivera pas, et le
 * comportement historique (erreur paresseuse a l'appel) est le bon.
 */
export function isTauriPage(w) {
    const loc = w && w.location;
    if (!loc || typeof loc.protocol !== 'string') return false;
    if (loc.protocol === 'tauri:') return true;
    const host = String(loc.hostname || '');
    return host === 'localhost' || host.endsWith('.localhost');
}

async function waitForTauri(timeoutMs = 8000, intervalMs = 15) {
    const started = Date.now();
    while (!isTauriInjected(window)) {
        if (Date.now() - started > timeoutMs) {
            // NON FATAL : si ce message apparait dans la console, l'injection
            // n'est JAMAIS arrivee (probleme different de la simple course :
            // CSP, withGlobalTauri, build casse) -- a signaler tel quel. Les
            // wrappers paresseux ci-dessous leveront ensuite a l'appel, comme
            // avant ce garde-fou.
            console.error(
                `[tauri-bridge] window.__TAURI__ toujours incomplet apres ${timeoutMs} ms — ` +
                'l\'injection Tauri n\'est pas arrivee du tout (voir ' +
                'tauri-apps/tauri#12990). Verifier app.withGlobalTauri et la CSP.'
            );
            return;
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}

// Top-level await : ne coute rien quand l'injection a deja eu lieu (cas
// nominal Linux/macOS et fenetre principale), attend quelques millisecondes
// dans le cas de course Windows, et n'est jamais declenche hors d'une vraie
// page Tauri (tests Node avec stub window, contexte sans DOM...).
if (typeof window !== 'undefined' && isTauriPage(window) && !isTauriInjected(window)) {
    await waitForTauri();
}

// @tauri-apps/api/core
export const invoke = (...args) => tauri().core.invoke(...args);

// @tauri-apps/api/event
export const emit   = (...args) => tauri().event.emit(...args);
export const emitTo = (...args) => tauri().event.emitTo(...args);
export const listen = (...args) => tauri().event.listen(...args);
export const once   = (...args) => tauri().event.once(...args);

// @tauri-apps/api/window
export const getCurrentWindow = (...args) => tauri().window.getCurrentWindow(...args);
export const getAllWindows    = (...args) => tauri().window.getAllWindows(...args);

// @tauri-apps/api/webviewWindow — classe, même traitement que Store ci-dessous.
export const WebviewWindow = new Proxy(function () {}, {
    construct(_target, args) { return new (tauri().webviewWindow.WebviewWindow)(...args); },
    get(_target, prop) {
        const Real = tauri().webviewWindow.WebviewWindow;
        const value = Real[prop];
        return typeof value === 'function' ? value.bind(Real) : value;
    },
});
export const getCurrentWebviewWindow = (...args) => tauri().webviewWindow.getCurrentWebviewWindow(...args);
export const getAllWebviewWindows    = (...args) => tauri().webviewWindow.getAllWebviewWindows(...args);

// @tauri-apps/plugin-shell
export const open = (...args) => tauri().shell.open(...args);

// @tauri-apps/plugin-dialog
export const message    = (...args) => tauri().dialog.message(...args);
export const ask        = (...args) => tauri().dialog.ask(...args);
export const save       = (...args) => tauri().dialog.save(...args);
export const openDialog = (...args) => tauri().dialog.open(...args);

// @tauri-apps/plugin-store — classe, pas une fonction : on ne peut pas la
// wrapper de la même façon. Store.load(...) est une méthode statique (cf.
// jb-controller.js/worker-bridge.js qui font `Store.load('tabulon.json')`),
// donc un Proxy paresseux sur la classe elle-même est nécessaire ici.
// IMPORTANT : `get` doit lier (bind) la propriété récupérée à l'objet réel
// (`tauri().store.Store`), pas la retourner détachée — sinon un éventuel
// usage interne de `this` dans l'implémentation Tauri (non vérifiable
// depuis l'extérieur, le bundle est minifié) se retrouverait silencieusement
// cassé dès qu'on appelle `Store.load(...)` via ce proxy.
export const Store = new Proxy(function () {}, {
    construct(_target, args) { return new (tauri().store.Store)(...args); },
    get(_target, prop) {
        const RealStore = tauri().store.Store;
        const value = RealStore[prop];
        return typeof value === 'function' ? value.bind(RealStore) : value;
    },
});

// @tauri-apps/plugin-os
export const platform = (...args) => tauri().os.platform(...args);
export const locale   = (...args) => tauri().os.locale(...args);

// @tauri-apps/plugin-http — fetch execute cote Rust (reqwest), donc pas
// soumis au CORS du navigateur. Necessaire pour parler a un relai HTTP
// distant (fileio.php de jocly-simple-match n'envoie pas d'en-tetes CORS).
// L'URL doit etre autorisee dans capabilities/default.json (permission
// http:default -> allow[].url).
export const httpFetch = (...args) => tauri().http.fetch(...args);
