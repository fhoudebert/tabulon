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
// invitation, extensions...) s'ouvraient blanches avec juste le titre. Cause :
// sous WebView2, les initialization scripts de Tauri (dont l'injection de
// window.__TAURI__ et des sous-objets de chaque plugin) peuvent s'executer
// APRES les <script type="module"> de la page pour une webview creee apres
// le demarrage -- course documentee cote Tauri (tauri-apps/tauri#12990,
// #12694 pour le cas « deuxieme fenetre »). Sur Linux/WebKitGTK l'ordre est
// fiable, d'ou l'asymetrie.
//
// PAS DE TOP-LEVEL AWAIT ICI. La premiere version suspendait ce module par
// un `await` au niveau du module. WKWebView sur macOS l'a refuse a l'analyse
// (« Unexpected identifier 'waitForTauri' ») : ce module est importe par
// TOUTES les pages, donc aucune ne demarrait. Le moteur de Safari n'accepte
// le top-level await qu'a partir de Safari 15, et son chargeur de modules
// ne le gere conformement a la spec qu'a partir de Safari 27 -- ce n'est pas
// une base sur laquelle faire reposer le demarrage de chaque fenetre.
//
// A la place : `tauriReady`, une promesse demarree a l'evaluation de ce
// module, et que chaque export ASYNCHRONE attend avant d'appeler Tauri. Le
// code applicatif fait deja `await invoke(...)`, `await Store.load(...)`,
// `await listen(...)` : il attend donc l'injection sans changer une ligne.
// Les rares exports SYNCHRONES (getCurrentWindow, constructeurs) ne peuvent
// pas attendre ; un appelant qui en a besoin des le demarrage attend
// `tauriReady` d'abord (voir tabulon-winutils.js).

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

function waitForTauri(timeoutMs = 8000, intervalMs = 15) {
    return new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
            if (isTauriInjected(window)) return resolve();
            if (Date.now() - started > timeoutMs) {
                // NON FATAL : si ce message apparait dans la console,
                // l'injection n'est JAMAIS arrivee (probleme different de la
                // simple course : CSP, withGlobalTauri, build casse) -- a
                // signaler tel quel. Les appels leveront ensuite, comme avant.
                console.error(
                    `[tauri-bridge] window.__TAURI__ toujours incomplet apres ${timeoutMs} ms — ` +
                    'l\'injection Tauri n\'est pas arrivee du tout (voir ' +
                    'tauri-apps/tauri#12990). Verifier app.withGlobalTauri et la CSP.'
                );
                return resolve();
            }
            setTimeout(tick, intervalMs);
        };
        tick();
    });
}

/**
 * Resolue quand l'injection Tauri est complete -- immediatement dans le cas
 * nominal (Linux, macOS, fenetre principale), apres quelques millisecondes
 * dans le cas de course Windows, et immediatement aussi hors d'une vraie page
 * Tauri (tests Node avec stub window, contexte sans DOM) : la, l'injection
 * n'arrivera jamais et l'erreur paresseuse a l'appel reste le bon signal.
 */
export const tauriReady =
    (typeof window !== 'undefined' && isTauriPage(window) && !isTauriInjected(window))
        ? waitForTauri()
        : Promise.resolve();

/** L'injection est-elle attendue et pas encore arrivee ? (relu a chaque appel) */
const injectionPending = () =>
    typeof window !== 'undefined' && isTauriPage(window) && !isTauriInjected(window);

/**
 * Enveloppe d'un appel asynchrone. Injection deja faite (cas nominal) :
 * appel DIRECT, exactement comme avant -- meme ordre d'execution. Sinon :
 * attendre l'injection, puis appeler.
 */
const later = (call) => (...args) =>
    injectionPending() ? tauriReady.then(() => call(...args)) : call(...args);

/**
 * Proxy paresseux d'une classe Tauri (Store, WebviewWindow). Le constructeur
 * reste synchrone ; les methodes statiques (Store.load, WebviewWindow.getByLabel)
 * renvoient des promesses et attendent donc l'injection comme le reste.
 */
function lazyClass(getReal) {
    return new Proxy(function () {}, {
        construct(_target, args) { return new (getReal())(...args); },
        get(_target, prop) {
            if (!injectionPending()) {
                const Real = getReal();
                const value = Real[prop];
                return typeof value === 'function' ? value.bind(Real) : value;
            }
            // Pas encore injecte : seule une methode est concevable ici, et
            // on ne peut la connaitre qu'apres l'injection.
            return (...args) => tauriReady.then(() => {
                const Real = getReal();
                return Real[prop](...args);
            });
        },
    });
}

// @tauri-apps/api/core
export const invoke = later((...args) => tauri().core.invoke(...args));

// @tauri-apps/api/event
export const emit   = later((...args) => tauri().event.emit(...args));
export const emitTo = later((...args) => tauri().event.emitTo(...args));
export const listen = later((...args) => tauri().event.listen(...args));
export const once   = later((...args) => tauri().event.once(...args));

// @tauri-apps/api/window — getCurrentWindow est SYNCHRONE (il rend l'objet
// fenetre, pas une promesse) : appele avant l'injection il leve, comme avant.
export const getCurrentWindow = (...args) => tauri().window.getCurrentWindow(...args);
export const getAllWindows    = later((...args) => tauri().window.getAllWindows(...args));

// @tauri-apps/api/webviewWindow — classe : voir lazyClass().
export const WebviewWindow = lazyClass(() => tauri().webviewWindow.WebviewWindow);
export const getCurrentWebviewWindow = (...args) => tauri().webviewWindow.getCurrentWebviewWindow(...args);
export const getAllWebviewWindows    = later((...args) => tauri().webviewWindow.getAllWebviewWindows(...args));

// @tauri-apps/plugin-shell
export const open = later((...args) => tauri().shell.open(...args));

// @tauri-apps/plugin-dialog
export const message    = later((...args) => tauri().dialog.message(...args));
export const ask        = later((...args) => tauri().dialog.ask(...args));
export const save       = later((...args) => tauri().dialog.save(...args));
export const openDialog = later((...args) => tauri().dialog.open(...args));

// @tauri-apps/plugin-store — classe, pas une fonction : Store.load(...) est
// une methode statique, d'ou le Proxy (lazyClass). La methode est liee
// (bind) a la classe reelle : un usage interne de `this` dans
// l'implementation Tauri (bundle minifie, non verifiable) resterait correct.
export const Store = lazyClass(() => tauri().store.Store);

// @tauri-apps/plugin-os — appeles avec `await` par Tabulon.
export const platform = later((...args) => tauri().os.platform(...args));
export const locale   = later((...args) => tauri().os.locale(...args));

// @tauri-apps/plugin-http — fetch execute cote Rust (reqwest), donc pas
// soumis au CORS du navigateur. Necessaire pour parler a un relai HTTP
// distant (fileio.php de jocly-simple-match n'envoie pas d'en-tetes CORS).
// L'URL doit etre autorisee dans capabilities/default.json (permission
// http:default -> allow[].url).
export const httpFetch = later((...args) => tauri().http.fetch(...args));
