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
