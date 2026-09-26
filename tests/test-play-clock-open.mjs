// test-play-clock-open.mjs — l'horloge s'ouvre d'office pour une partie
// chronometree, et seulement pour elle.
//
// Chronometree = configuration d'horloge en mode countdown dans l'URL (ecran
// « Clocked play » ou modele avec horloge). Les autres parties -- sans
// horloge, ou countup -- ne l'ouvrent pas. L'appel porte `auto: true` : cote
// Rust, la fenetre ne prend alors pas le focus et se place a cote du plateau.
//
// Usage : node tests/test-play-clock-open.mjs   (depuis tabulon/)
import { JSDOM } from '../app/node_modules/jsdom/lib/api.js';
import { completeTauriInjection } from './helpers/tauri-mock.mjs';
process.chdir(new URL('..', import.meta.url).pathname);
import { readFileSync } from 'fs';

const PLAYER_A = 1, PLAYER_B = -1;
const LEVELS = [{ name: 'easy', label: 'Easy', isDefault: true }];
const invokeCalls = [];
// Le scenario vient de la ligne de commande : ce fichier se relance lui-meme
// pour chaque cas (play.js ne s'importe qu'une fois par processus).
const CASE = process.argv[2] || null;
const CLOCKS = {
    countdown: { mode: 'countdown', 1: 300000, '-1': 300000 },
    countup:   { mode: 'countup', 1: 0, '-1': 0 },
    none:      null,
};

let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}

// ── Mock Tauri ───────────────────────────────────────────────────────────────
const bus = {};
const storeData = new Map();
const mockTauri = {
    core: { invoke: async (cmd, payload) => { invokeCalls.push({ cmd, payload }); return null; } },
    event: {
        listen: async (name, fn) => { (bus[name] ??= []).push(fn); return () => {}; },
        emit:   async (name, payload) => { (bus[name] || []).forEach(fn => fn({ payload })); },
    },
    window:{ getCurrentWindow: () => ({ label: 'play-9', close: () => {}, setTitle: async () => {} }) },
    os:    { platform: async () => 'linux' },
    shell: { open: async () => {} },
    dialog:{ save: async () => null },
    store: { Store: class { static async load() { return {
        get: async (k) => storeData.get(k), set: async (k, v) => { storeData.set(k, v); },
        delete: async (k) => { storeData.delete(k); },
    }; } } },
};

// ── Match factice : alternance stricte, A commence ──────────────────────────
const turnOf = (n) => n % 2 === 0 ? PLAYER_A : PLAYER_B;
const match = {
    playedMoves: [],
    pendingUserTurn: null,
    playMoveCalls: [],
    loadCalls: 0,
    searches: 0,
    pendingSearch: null,
    get turn() { return turnOf(this.playedMoves.length); },
    async getConfig()      { return { model: { levels: LEVELS }, view: { skins: [] } }; },
    async attachElement()  {},
    async getTurn()        { return this.turn; },
    async getPlayedMoves() { return [...this.playedMoves]; },
    async getViewOptions() { return {}; },
    async setViewOptions() {},
    async abortUserTurn()  {
        if (this.pendingUserTurn) { const p = this.pendingUserTurn; this.pendingUserTurn = null; p.reject(new Error('User input aborted')); }
    },
    async abortMachineSearch() {
        if (this.pendingSearch) { const p = this.pendingSearch; this.pendingSearch = null; p.reject(new Error('Machine search aborted')); }
    },
    async getBoardState()  { return 'fen'; },
    async save()           { return { game: 'classic-chess', playedMoves: [...this.playedMoves] }; },
    async load(state)      { this.loadCalls++; this.playedMoves = [...(state.playedMoves || [])]; },
    async rollback(n)      { this.playedMoves = this.playedMoves.slice(0, n); },
    async viewControl()    { return null; },
    userTurn() { return new Promise((resolve, reject) => { this.pendingUserTurn = { resolve, reject }; }); },
    // Recherche lente, comme un vrai moteur : c'est pendant ce laps que la
    // boucle peut etre surprise par un changement de position.
    machineSearch() {
        this.searches++;
        const k = this.searches;
        return new Promise((resolve, reject) => {
            const p = { resolve, reject };
            this.pendingSearch = p;
            setTimeout(() => { if (this.pendingSearch === p) { this.pendingSearch = null; resolve({ move: { ai: k } }); } }, 40);
        });
    },
    async playMove(move)   { this.playMoveCalls.push(move); this.playedMoves.push(move); return { finished: false, winner: null }; },
};

// Les appels traversent l'iframe de jocly par postMessage : chaque reponse
// arrive dans une tache ULTERIEURE, pas dans la foulee. C'est ce qui laisse la
// boucle de jeu et le bouton s'entrelacer -- un faux synchrone masquerait la
// course.
// getTurn est rendu PLUS LENT que le reste : la boucle, reveillee par
// l'interruption, lit alors le tour APRES que le bouton a recule d'un coup --
// l'ordre constate avec le vrai jocly. Et playMove dure le temps de son
// animation.
const DELAY = { getTurn: 25, playMove: 300 };
for (const name of ['getTurn', 'getPlayedMoves', 'rollback', 'playMove', 'abortUserTurn', 'abortMachineSearch']) {
    const real = match[name].bind(match);
    match[name] = (...args) => new Promise((resolve, reject) =>
        setTimeout(() => real(...args).then(resolve, reject), DELAY[name] ?? 5));
}

const html = readFileSync('./app/content/play.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/play.html?game=classic-chess&id=11'
    + (CLOCKS[CASE] ? '&clock=' + encodeURIComponent(JSON.stringify(CLOCKS[CASE])) : '') });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.FileReader = dom.window.FileReader;
dom.window.__TAURI__ = completeTauriInjection(mockTauri);
globalThis.Jocly = {
    PLAYER_A, PLAYER_B,
    getGameConfig: async () => ({ model: { 'title-en': 'Chess', levels: LEVELS }, view: {} }),
    createMatch:   async () => match,
};

if (!CASE) {
    // Processus parent : un sous-processus par cas.
    const { execFileSync } = await import('child_process');
    for (const c of Object.keys(CLOCKS)) {
        const out = execFileSync(process.execPath, [new URL(import.meta.url).pathname, c], { encoding: 'utf-8' });
        const line = out.split('\n').find(l => l.startsWith('RESULT '));
        const opened = line === 'RESULT opened auto';
        if (c === 'countdown') assert(opened, 'partie chronométrée (countdown) : l’horloge s’ouvre d’office, sans prendre le focus');
        else assert(line === 'RESULT closed', `horloge ${c} : rien ne s’ouvre d’office (${line})`);
    }
    console.log(`\n${passed} assertions OK — ouverture de l’horloge validée.`);
    process.exit(0);
}

await import('../app/content/play.js');
document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 6000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return; await sleep(20); }
    throw new Error('timeout: ' + what);
}
async function humanPlays(move) {
    await waitFor(() => match.pendingUserTurn, 'le tour humain est armé');
    const p = match.pendingUserTurn; match.pendingUserTurn = null;
    match.playedMoves.push(move);
    p.resolve({ move, finished: false, winner: null });
}

await waitFor(() => match.pendingUserTurn, 'la partie a démarré');
await sleep(100);
const call = invokeCalls.find(c => c.cmd === 'open_clock');
console.log(call ? `RESULT opened ${call.payload.auto === true && call.payload.matchId === 11 ? 'auto' : JSON.stringify(call.payload)}` : 'RESULT closed');
process.exit(0);
