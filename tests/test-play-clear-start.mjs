// test-play-clear-start.mjs — écrire sans protection d'emblée (bouton « clé barrée »).
//
// play.js décide : le bouton n'est proposé que pour une partie PROTÉGÉE sur
// un relai ; la bascule est la même que « Continuer sans protection »
// (AcceptChatClear) — le texte libre part ensuite en clair, ce qui était dit
// avant reste lisible.
//
// Usage : node tests/test-play-clear-start.mjs   (depuis tabulon/)
import { JSDOM } from '../app/node_modules/jsdom/lib/api.js';
import { completeTauriInjection } from './helpers/tauri-mock.mjs';
process.chdir(new URL('..', import.meta.url).pathname);
import { readFileSync } from 'fs';

const PLAYER_A = 1, PLAYER_B = -1;
const INVITE = 'inv-clear';
const MID = 'mid-drop-123456';
const RELAY = 'https://relai.test/fileio.php';

let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}

const relay = new Map();
async function relayFetch(_url, init) {
    const p = new URLSearchParams(init.body);
    if (p.get('gameioaction') === 'save') { relay.set(p.get('gameid'), p.get('gamedata')); return { status: 200, text: async () => 'ok' }; }
    if (p.get('gameioaction') === 'load') { const t = relay.get(p.get('gameid')) ?? ''; return { status: 200, text: async () => t }; }
    if (p.get('chatioaction') === 'save') { chatLines.push(p.get('chatmsg')); return { status: 200, text: async () => '{"ok":true}' }; }
    if (p.get('chatioaction') === 'load') { return { status: 200, text: async () => '{"messages":[' + chatLines.join(',') + ']}' }; }
    return { status: 200, text: async () => '' };
}
const chatLines = [];
function opponentWrites(moves) {
    const matchDetails = { matchId: MID, gameName: 'classic-chess', nbTurns: moves.length, a: { pseudo: '' }, b: { pseudo: '' }, allowTakeback: true };
    relay.set(MID, JSON.stringify({ matchDetails, matchdata: { playedMoves: [...moves] }, time: Date.now(), key: 'k' }));
}

const invokeCalls = [];
const bus = {};
const storeData = new Map();
storeData.set('invite:' + INVITE, {
    matchId: MID, relayUrl: RELAY, gameName: 'classic-chess',
    player: 'a', creator: true, peer: false, chatKey: 'a'.repeat(64), allowTakeback: true,
});
const mockTauri = {
    core: { invoke: async (cmd, args) => {
        invokeCalls.push({ cmd, args });
        // Sceau factice : opaque, donc le texte n'y apparaît pas en clair.
        if (cmd === 'seal_text') return 'S' + Buffer.from(args.text).toString('base64');
        if (cmd === 'open_text') return Buffer.from(String(args.sealed).slice(1), 'base64').toString();
        if (cmd === 'chat_key_id') return args.master.slice(0, 16);
        return null;
    } },
    event: {
        listen: async (name, fn) => { (bus[name] ??= []).push(fn); return () => {}; },
        emit:   async (name, payload) => { (bus[name] || []).forEach(fn => fn({ payload })); },
    },
    window:{ getCurrentWindow: () => ({ label: 'play-9', close: () => {}, setTitle: async () => {} }) },
    os:    { platform: async () => 'linux' },
    shell: { open: async () => {} },
    dialog:{ save: async () => null },
    http:  { fetch: relayFetch },
    store: { Store: class { static async load() { return {
        get: async (k) => storeData.get(k), set: async (k, v) => { storeData.set(k, v); },
        delete: async (k) => { storeData.delete(k); },
    }; } } },
};

// Le coup « mat » termine la partie, d'où qu'il vienne.
const ends = (move) => move?.to === 'mat';
const turnOf = (n) => n % 2 === 0 ? PLAYER_A : PLAYER_B;
const match = {
    playedMoves: [], pendingUserTurn: null, loadCalls: 0,
    get turn() { return turnOf(this.playedMoves.length); },
    async getConfig()      { return { model: { levels: [] }, view: { skins: [] } }; },
    async attachElement()  {},
    async getTurn()        { return this.turn; },
    async getPlayedMoves() { return [...this.playedMoves]; },
    async getViewOptions() { return {}; },
    async setViewOptions() {},
    async abortUserTurn()  {
        if (this.pendingUserTurn) { const p = this.pendingUserTurn; this.pendingUserTurn = null; p.reject(new Error('User input aborted')); }
    },
    async abortMachineSearch() {},
    async getBoardState()  { return 'fen'; },
    async getFinished()    { return { finished: ends(this.playedMoves[this.playedMoves.length - 1]), winner: 1 }; },
    async save()           { return { game: 'classic-chess', playedMoves: [...this.playedMoves] }; },
    async load(state)      { this.loadCalls++; this.playedMoves = [...(state.playedMoves || [])]; },
    async rollback(n)      { this.playedMoves = this.playedMoves.slice(0, n); },
    async viewControl()    { return null; },
    userTurn() { return new Promise((resolve, reject) => { this.pendingUserTurn = { resolve, reject }; }); },
    async machineSearch()  { return { move: {} }; },
    async playMove(move)   { this.playedMoves.push(move); return { finished: ends(move), winner: ends(move) ? -1 : null }; },
};

const html = readFileSync('./app/content/play.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: `https://tauri.localhost/content/play.html?game=classic-chess&id=9&invite=${INVITE}` });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.FileReader = dom.window.FileReader;
dom.window.__TAURI__ = completeTauriInjection(mockTauri);
globalThis.Jocly = {
    PLAYER_A, PLAYER_B,
    getGameConfig: async () => ({ model: { 'title-en': 'Chess', levels: [] }, view: {} }),
    createMatch:   async () => match,
};

await import('../app/content/play.js');
document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 6000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return; await sleep(20); }
    throw new Error('timeout: ' + what);
}
const calls = (cmd) => invokeCalls.filter(c => c.cmd === cmd);
async function humanPlays(move) {
    await waitFor(() => match.pendingUserTurn, 'le tour humain est armé');
    const p = match.pendingUserTurn; match.pendingUserTurn = null;
    match.playedMoves.push(move);
    p.resolve({ move, finished: ends(move), winner: ends(move) ? 1 : null });
}
const footer = () => document.body.textContent;

let lastChat = null;
(bus['play-event:9:chat'] ??= []).push(({ payload }) => { lastChat = payload; });
const emitReq = (name, payload) => mockTauri.event.emit(`play-req:9:${name}`, payload);

// Partie protégée (clé d'invitation) : la fenêtre peut proposer le bouton.
await waitFor(() => bus['play-req:9:get-chat'], 'play.js écoute la fenêtre de conversation');
await emitReq('get-chat', {});
await waitFor(() => lastChat && 'canClearStart' in lastChat, 'état de la conversation poussé');
assert(lastChat.canClearStart === true, 'partie protégée sur relai : « clé barrée » proposée');
assert(lastChat.clearOn === false && lastChat.canWrite === true, 'pas encore basculée, texte libre possible (scellé)');

// Avant la bascule : le texte part scellé.
await emitReq('send-chat', { body: 'avant bascule' });
await waitFor(() => chatLines.length === 1, 'premier message déposé');
assert(!chatLines[0].includes('avant bascule'), 'avant la bascule, le texte ne part pas en clair');

// Bascule (ce qu'envoie le bouton après confirmation).
await emitReq('chat-allow-clear', {});
await waitFor(() => lastChat?.clearOn === true, 'bascule faite');
assert(lastChat.canClearStart === false, 'après la bascule, le bouton n’est plus proposé');
assert(lastChat.canWrite === true, 'on peut toujours écrire');
assert((storeData.get('chat-clear-matches') || []).includes(MID),
    'la bascule est retenue pour CETTE partie (identifiant seulement, jamais une clé)');

await emitReq('send-chat', { body: 'apres bascule' });
await waitFor(() => chatLines.length === 2, 'second message déposé');
assert(chatLines[1].includes('apres bascule'), 'après la bascule, le texte part en clair — lisible sans clé');
await waitFor(() => (lastChat.conversation || []).some(m => m.body === 'avant bascule'), 'ancien message relu');
assert(true, 'ce qui a été dit sous protection reste lisible');

console.log(`\ntest-play-clear-start: ${passed} assertions OK`);
process.exit(0);
