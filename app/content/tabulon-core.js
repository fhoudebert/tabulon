// app/core/tabulon-core.js
//
// Couche d'abstraction qui isole jb-match.js de l'API Tauri.
// Centralise : invoke, store, gestion des fenêtres, émission d'events.
//
// Le "main process" de JoclyBoard est ici remplacé par ce module JS
// qui tourne dans la fenêtre hub (main) et pilote toutes les autres.

import { invoke, emit, listen, Store, WebviewWindow, save as saveDialog } from './tauri-bridge.js';

let _store = null;
let _matchIdCounter = 0;

// Callbacks de fermeture de fenêtre : label → fn[]
const _closeCallbacks = new Map();
// Unlisten Tauri event pour chaque fenêtre créée
const _windowUnlistens = new Map();

async function getStore() {
    if (!_store) _store = await Store.load('tabulon.json');
    return _store;
}

const tCore = {

    // ── IDs de match ──────────────────────────────────────────────────────────
    nextMatchId() {
        return ++_matchIdCounter;
    },

    // ── Store (persistent settings) ───────────────────────────────────────────
    async storeGet(key) {
        const s = await getStore();
        return s.get(key);
    },
    async storeSet(key, value) {
        const s = await getStore();
        await s.set(key, value);
        await s.save();
    },

    // ── Invoke Rust commands ──────────────────────────────────────────────────
    invoke(command, args) {
        return invoke(command, args || {});
    },

    // ── Fenêtres ──────────────────────────────────────────────────────────────

    /**
     * Ouvre une nouvelle fenêtre ou la focus si elle existe déjà.
     * Équivalent de utils.createWindowPromise().
     * Attend que la fenêtre émette "window-ready" avant de résoudre.
     */
    async openWindow({ label, url, title, width, height, minWidth, minHeight, persistKey, geometry }) {
        // Si elle existe déjà, la focus
        const existing = await WebviewWindow.getByLabel(label);
        if (existing) { await existing.setFocus(); return; }

        // Récupérer la géométrie persistée
        let x, y, w = width, h = height;
        if (persistKey) {
            const stored = await tCore.storeGet(persistKey);
            if (stored) { x = stored.x; y = stored.y; w = stored.width; h = stored.height; }
        }
        if (geometry) { x = geometry.x; y = geometry.y; w = geometry.width; h = geometry.height; }

        // Attendre "window-ready" depuis cette fenêtre spécifique
        const readyPromise = new Promise((resolve) => {
            listen('window-ready', (event) => {
                if (event.payload?.label === label) resolve();
            });
        });

        const win = new WebviewWindow(label, {
            url, title,
            width: w, height: h,
            minWidth: minWidth || 200,
            minHeight: minHeight || 150,
            x, y,
        });

        await readyPromise;

        // Persistance géométrie à la fermeture
        if (persistKey) {
            const unlisten = await win.onCloseRequested(async () => {
                const size = await win.innerSize();
                const pos  = await win.outerPosition();
                await tCore.storeSet(persistKey, {
                    width: size.width, height: size.height,
                    x: pos.x, y: pos.y,
                });
            });
            _windowUnlistens.set(label, unlisten);
        }

        // Écouter la fermeture pour déclencher les callbacks
        win.onCloseRequested(() => {
            const callbacks = _closeCallbacks.get(label) || [];
            callbacks.forEach(fn => fn());
            _closeCallbacks.delete(label);
            const ul = _windowUnlistens.get(label);
            if (ul) { ul(); _windowUnlistens.delete(label); }
        });
    },

    /** Ferme une fenêtre par son label */
    async closeWindow(label) {
        const win = await WebviewWindow.getByLabel(label);
        if (win) await win.close();
    },

    /** Met le focus sur une fenêtre existante */
    async focusWindow(label) {
        const win = await WebviewWindow.getByLabel(label);
        if (win) await win.setFocus();
    },

    /** Enregistre un callback de fermeture */
    onWindowClose(label, fn) {
        if (!_closeCallbacks.has(label)) _closeCallbacks.set(label, []);
        _closeCallbacks.get(label).push(fn);
    },

    // ── Events RPC renderer→renderer via Rust relay ───────────────────────────
    //
    // Équivalent de rpc.call(window, "method", args) du main Electron.
    // Passe par relay_to_window côté Rust, qui émet sur la fenêtre cible.
    // Retourne une Promise qui se résout quand la fenêtre répond via
    // "rpc-reply-<token>".

    emit(targetLabel, event, payload) {
        const token = `rpc-${targetLabel}-${event}-${Date.now()}-${Math.random()}`;

        const replyPromise = new Promise((resolve, reject) => {
            listen('rpc-reply:' + token, ({ payload: p }) => {
                if (p.error) reject(new Error(p.error));
                else         resolve(p.result);
            });
        });

        invoke('relay_to_window', { target: targetLabel, event, payload: { payload, token } });

        return replyPromise;
    },

    // ── Dialog ────────────────────────────────────────────────────────────────
    async dialogSaveFile({ title, defaultName, filters }) {
        return saveDialog({ title, defaultPath: defaultName, filters });
    },
};

export default tCore;
