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
const SCAN_WORKER_RE  = /(^|\/)jocly\.scanworker\.js(\?|$)/;
const KATA_WORKER_RE  = /(^|\/)jocly\.kataworker\.js(\?|$)/;

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
 * Faux Worker pour le moteur de DAMES natif Scan. Même contrat que
 * NativeFairyWorker, mais le protocole de jocly.scan.js diffère sur un point :
 * la réponse « Done » porte `data.bestMove` (notation naturelle de Scan,
 * « 33-28 », « 28x19x23 ») et non `data.bestMoveUci`.
 *
 * Une position terminale est un `done` SANS coup : jocly l'interprète en
 * vidant sa liste de coups, ce n'est pas une erreur — on transmet donc
 * `bestMove: null` plutôt que d'échouer.
 */
class NativeScanWorker {
    constructor(rpc) {
        this._rpc = rpc;
        this.onmessage = null;
        this.onerror = null;
        this._searching = false;
        this._stopped = false;
        this._dead = false;
    }

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
        console.warn('[engine-native] message ignoré (scan):', type);
    }

    terminate() {
        this._dead = true;
        if (this._searching) this._rpc.call('scan_stop').catch(() => {});
    }

    _init() {
        this._rpc.call('scan_probe')
            .then((name) => {
                console.info('[engine-native] moteur de dames natif :', name);
                this._post({ type: 'Ready' });
            })
            .catch((err) => {
                // Chemin NORMAL quand `engine/scan` n'est pas installé : jocly
                // marque le moteur indisponible et joue avec son IA native.
                const why = (err && err.message) || err;
                console.warn('[engine-native] moteur de dames indisponible — ' +
                    'le niveau Expert des dames se rabat sur l’IA native :', why);
                this._fail(err);
            });
    }

    _search(msg) {
        this._stopped = false;
        this._searching = true;
        this._rpc.call('scan_search', {
            fen:         msg.fen,
            depth:       msg.depth,
            moveTimeMs:  msg.moveTimeMs,
            bookEnabled: msg.bookEnabled,
            variant:     msg.variant,
        })
            .then((res) => {
                this._searching = false;
                if (this._stopped) return this._post({ type: 'Aborted' });
                this._post({ type: 'Done', data: { bestMove: res && res.bestMove } });
            })
            .catch((err) => {
                this._searching = false;
                if (this._stopped) return this._post({ type: 'Aborted' });
                console.warn('[engine-native] recherche de dames échouée :',
                    (err && err.message) || err);
                this._fail(err);
            });
    }

    _stop() {
        if (!this._searching) return;
        this._stopped = true;
        this._rpc.call('scan_stop').catch(() => {});
    }
}

/**
 * Faux Worker pour le moteur de GO natif KataGo. Même contrat que les deux
 * précédents, mais deux différences que jocly.kata.js impose :
 *
 * 1. **Le message Init porte des données dont la recherche a besoin.** KataGo
 *    charge son réseau AU LANCEMENT, et la taille du goban est fixée avec lui.
 *    Fairy-Stockfish résout son NNUE au moment de la recherche ; ici il faut
 *    retenir `net` et `boardSize` posés à l'Init et les renvoyer à chaque
 *    recherche, sinon le côté Rust n'a pas de quoi démarrer le moteur.
 *
 * 2. **La position n'est pas un FEN mais la suite des coups** — `moves`,
 *    `toPlay`, `komi` —, parce que c'est ce que demande l'ABI wasm que ce
 *    shim remplace. Rien à traduire ici : la conversion en GTP est côté Rust,
 *    là où elle est testable sans navigateur.
 *
 * La réponse « Done » porte `data.bestMove`, un index d'intersection (-1 pour
 * une passe), que jocly retrouve dans sa propre liste de coups légaux.
 */
class NativeKataWorker {
    constructor(rpc) {
        this._rpc = rpc;
        this.onmessage = null;
        this.onerror = null;
        this._searching = false;
        this._stopped = false;
        this._dead = false;
        this._net = null;
        this._boardSize = null;
    }

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
        if (type === 'Init')   return this._init(msg);
        if (type === 'Search') return this._search(msg);
        if (type === 'Stop')   return this._stop();
        console.warn('[engine-native] message ignoré (katago):', type);
    }

    terminate() {
        this._dead = true;
        if (this._searching) this._rpc.call('katago_stop').catch(() => {});
    }

    _init(msg) {
        this._net = (msg && msg.net) || null;
        this._boardSize = (msg && msg.boardSize) || null;
        // La sonde charge vraiment le réseau : c'est long, mais c'est le seul
        // moyen de distinguer « installé » de « installé et fonctionnel »,
        // et le joueur doit le savoir avant sa première partie.
        this._rpc.call('katago_probe', { net: this._net })
            .then((name) => {
                console.info('[engine-native] moteur de go natif :', name,
                    '- réseau', this._net, '- goban', this._boardSize);
                this._post({ type: 'Ready', data: { backend: 'native', engine: name } });
            })
            .catch((err) => {
                // Chemin NORMAL quand `engine/katago` (ou son réseau, ou sa
                // config) n'est pas installé : jocly marque le moteur
                // indisponible et joue avec son IA native.
                const why = (err && err.message) || err;
                console.warn('[engine-native] moteur de go indisponible — ' +
                    'les niveaux KataGo se rabattent sur l’IA native :', why);
                this._fail(err);
            });
    }

    _search(msg) {
        this._stopped = false;
        this._searching = true;
        this._rpc.call('katago_search', {
            moves:      msg.moves || [],
            toPlay:     msg.toPlay,
            komi:       msg.komi,
            // Retenus de l'Init : KataGo en a besoin au lancement.
            boardSize:  this._boardSize,
            net:        this._net,
            visits:     msg.visits,
            moveTimeMs: msg.moveTimeMs,
        })
            .then((res) => {
                this._searching = false;
                if (this._stopped) return this._post({ type: 'Aborted' });
                // Un abandon est un « pas de coup » comme une passe côté
                // index (-1) ; on le dit ici, sinon il passerait pour une
                // passe et personne ne saurait que le moteur a renoncé.
                if (res && res.resigned)
                    console.info('[engine-native] KataGo abandonne');
                this._post({ type: 'Done', data: { bestMove: res && res.bestMove } });
            })
            .catch((err) => {
                this._searching = false;
                if (this._stopped) return this._post({ type: 'Aborted' });
                console.warn('[engine-native] recherche de go échouée :',
                    (err && err.message) || err);
                this._fail(err);
            });
    }

    _stop() {
        if (!this._searching) return;
        this._stopped = true;
        this._rpc.call('katago_stop').catch(() => {});
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
        if (SCAN_WORKER_RE.test(s))  return new NativeScanWorker(rpc);
        if (KATA_WORKER_RE.test(s))  return new NativeKataWorker(rpc);
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

export { NativeFairyWorker, NativeScanWorker, NativeKataWorker };
