// app/content/engine-native.js
//
// Branche les niveaux « Expert » de Jocly sur le moteur Fairy-Stockfish NATIF
// (commandes Rust engine_probe / engine_search / engine_stop, voir
// src-tauri/src/commands/engine_cmds.rs et DEVELOPMENT.md § Native engine).
//
// POURQUOI : la build wasm embarquée dans Jocly est multi-thread ; dans une
// webview Tauri, la requête de son worker pthread `stockfish.worker.js` reste
// indéfiniment en attente (« pending » sans statut, dist interne comme
// externe). Le moteur annonce « engine ready » puis ne rend jamais de coup.
//
// COMMENT, SANS TOUCHER À JOCLY : Jocly crée son moteur par
// `new Worker(baseURL + "jocly.fairyworker.js")` puis lui parle par un petit
// protocole de messages. Il suffit donc de fournir un objet ayant la même
// interface. Aucune modification de la bibliothèque n'est nécessaire.
//
//   Init   → Ready | Error          (Error ⇒ Jocly se rabat sur son IA native
//                                    et play.js affiche #play-warning)
//   Search → Done | Error | Aborted
//   Stop   → Aborted
//
// OÙ IL S'INSTALLE : Jocly tourne dans un iframe (mode proxy), c'est donc
// l'objet `Worker` DE L'IFRAME qu'il faut remplacer. L'iframe est same-origin,
// et la fonction posée reste celle de la fenêtre du haut : le shim s'exécute
// dans le realm du haut et garde donc l'accès à Tauri, sans dépendre de la
// présence de `window.__TAURI__` dans l'iframe (qui n'est pas établie).
//
// COHABITATION avec le hook Worker d'asset-rewrite.js (qui redirige
// jocly.aiworker.js vers le dist externe) : les deux enveloppent `Worker`,
// mais sur des URL DISJOINTES et chacun délègue à l'enveloppe précédente —
// l'ordre d'installation n'a donc pas d'importance.

const FAIRY_WORKER_RE = /(^|\/)jocly\.fairyworker\.js(\?|$)/;

// Une trace par variante : le joueur doit pouvoir constater si Expert tourne
// avec son reseau NNUE ou en evaluation classique, sans lire les logs de
// l'application.
const evalReported = new Set();
function ReportEval(variant, asked, used) {
    if (evalReported.has(variant)) return;
    evalReported.add(variant);
    if (used) console.info(`[engine-native] ${variant} : reseau NNUE ${used}`);
    else if (asked) console.info(
        `[engine-native] ${variant} : reseau NNUE "${asked}" introuvable a cote du ` +
        `binaire (ou refuse) — evaluation classique`);
}

/**
 * Faux Worker : même surface que celle utilisée par jocly.fairy.js
 * (postMessage, onmessage, onerror, terminate).
 */
class NativeFairyWorker {
    constructor(rpc) {
        this._rpc = rpc;
        this.onmessage = null;
        this.onerror = null;
        this._searching = false;
        this._stopped = false;
        this._dead = false;
    }

    // Les réponses d'un vrai Worker arrivent toujours de façon asynchrone.
    // On respecte ce contrat : un appelant qui pose son onmessage APRÈS
    // postMessage (ce que fait jocly.fairy.js pour Init) doit être servi.
    _post(msg) {
        if (this._dead) return;
        Promise.resolve().then(() => {
            if (this._dead) return;
            try { if (this.onmessage) this.onmessage({ data: msg }); }
            catch (e) { console.error('[engine-native] onmessage:', e); }
        });
    }

    _fail(err) {
        this._post({ type: 'Error', error: String((err && err.message) || err) });
    }

    postMessage(msg) {
        const type = msg && msg.type;
        if (type === 'Init')   return this._init();
        if (type === 'Search') return this._search(msg);
        if (type === 'Stop')   return this._stop();
        console.warn('[engine-native] message ignoré:', type);
    }

    terminate() {
        this._dead = true;
        if (this._searching) this._rpc.call('engine_stop').catch(() => {});
    }

    _init() {
        this._rpc.call('engine_probe')
            .then((name) => {
                console.info('[engine-native] moteur natif :', name);
                this._post({ type: 'Ready' });
            })
            .catch((err) => {
                // Chemin NORMAL quand aucun binaire n'est installé : Jocly
                // marque le moteur indisponible et joue avec son IA native.
                console.info('[engine-native] moteur natif indisponible :',
                    (err && err.message) || err);
                this._fail(err);
            });
    }

    _search(msg) {
        this._stopped = false;
        this._searching = true;
        this._rpc.call('engine_search', {
            variant:          msg.variant,
            fen:              msg.fen,
            depth:            msg.depth,
            moveTimeMs:       msg.moveTimeMs,
            skillLevel:       msg.skillLevel,
            chess960:         msg.chess960,
            customVariantIni: msg.customVariantIni,
            // Reseau NNUE optionnel : cote natif il est cherche A COTE DU
            // BINAIRE du moteur (le worker wasm, lui, le telechargeait depuis
            // le dist). Absent => evaluation classique, jamais un echec.
            evalFile:         msg.evalFile,
        })
            .then((res) => {
                this._searching = false;
                // Les logs de resolution NNUE sont cote Rust (sortie de
                // l'application), donc INVISIBLES dans cette console : on dit
                // ici, une fois par variante, ce qui a reellement ete charge.
                ReportEval(msg.variant, msg.evalFile, res && res.evalFileUsed);
                // Une recherche interrompue se termine côté Rust par un
                // processus tué, donc par une erreur OU par un résultat
                // partiel : dans les deux cas c'est « Aborted » qu'attend
                // jocly, pas un coup à jouer.
                if (this._stopped) return this._post({ type: 'Aborted' });
                this._post({ type: 'Done', data: res });
            })
            .catch((err) => {
                this._searching = false;
                if (this._stopped) return this._post({ type: 'Aborted' });
                console.warn('[engine-native] recherche échouée :', (err && err.message) || err);
                this._fail(err);
            });
    }

    _stop() {
        if (!this._searching) return;
        this._stopped = true;
        this._rpc.call('engine_stop').catch(() => {});
    }
}

/**
 * Remplace `Worker` dans une fenêtre donnée pour intercepter la seule
 * création du worker fairy-stockfish. Idempotent.
 */
export function installInWindow(win, rpc) {
    if (!win || win.__tabulonNativeEngine) return false;
    let Previous;
    try { Previous = win.Worker; } catch (e) { return false; }   // iframe non accessible
    if (typeof Previous !== 'function') return false;
    win.__tabulonNativeEngine = true;

    function PatchedWorker(url, opts) {
        const s = (typeof url === 'string') ? url : String(url || '');
        if (FAIRY_WORKER_RE.test(s)) return new NativeFairyWorker(rpc);
        return new Previous(url, opts);
    }
    PatchedWorker.prototype = Previous.prototype;
    try { win.Worker = PatchedWorker; } catch (e) { return false; }
    return true;
}

/**
 * Installe le pont pour la fenêtre de jeu : dans l'iframe Jocly de `root`
 * (créé par attachElement), et dans la fenêtre courante par sécurité si un
 * jour Jocly tournait en direct. Surveille `root` car Jocly peut recréer son
 * iframe (changement de skin, rechargement).
 */
export function installNativeEngine(root, rpc) {
    const tryIframes = () => {
        if (!root) return;
        root.querySelectorAll('iframe').forEach((f) => {
            const apply = () => { try { installInWindow(f.contentWindow, rpc); } catch (e) {} };
            apply();
            f.addEventListener('load', apply);
        });
    };
    installInWindow(window, rpc);
    tryIframes();
    try {
        new MutationObserver(tryIframes).observe(root, { childList: true, subtree: true });
    } catch (e) {
        console.warn('[engine-native] observateur non installé :', e);
    }
}

export { NativeFairyWorker };
