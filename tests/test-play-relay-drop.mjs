// test-play-relay-drop.mjs — une partie à distance terminée s'efface du relai.
//
// LA RÈGLE : seul celui qui a REÇU le dernier coup arme l'effacement (Rust
// l'envoie à la fermeture de la fenêtre, voir relay_cmds.rs). Il sait que les
// deux côtés ont vu la fin ; celui qui l'a joué ne le sait pas, et effacer de
// son côté pourrait retirer le coup avant que l'autre l'ait lu.
//
// Deux scénarios, chacun dans son processus (play.js ne se charge qu'une fois
// par page) :
//   (défaut)     la fin arrive par le relai → armé, puis désarmé si
//                l'adversaire reprend son coup après la fin ;
//   local-final  c'est nous qui jouons le coup final → rien d'armé.
//
// Usage : node tests/test-play-relay-drop.mjs   (depuis tabulon/)
import { JSDOM } from '../app/node_modules/jsdom/lib/api.js';
import { completeTauriInjection } from './helpers/tauri-mock.mjs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
process.chdir(new URL('..', import.meta.url).pathname);
import { readFileSync } from 'fs';

const SCENARIO = process.argv[2] || 'remote-final';
const PLAYER_A = 1, PLAYER_B = -1;
const INVITE = 'inv-drop';
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
    return { status: 200, text: async () => '' };
}
function opponentWrites(moves) {
    const matchDetails = { matchId: MID, gameName: 'classic-chess', nbTurns: moves.length, a: { pseudo: '' }, b: { pseudo: '' }, allowTakeback: true };
    relay.set(MID, JSON.stringify({ matchDetails, matchdata: { playedMoves: [...moves] }, time: Date.now(), key: 'k' }));
}

const invokeCalls = [];
const bus = {};
const storeData = new Map();
storeData.set('invite:' + INVITE, {
    matchId: MID, relayUrl: RELAY, gameName: 'classic-chess',
    player: 'a', creator: true, peer: false, chatKey: null, allowTakeback: true,
});
const mockTauri = {
    core: { invoke: async (cmd, args) => { invokeCalls.push({ cmd, args }); return null; } },
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

if (SCENARIO === 'remote-final') {
    // Nous jouons, l'adversaire répond par le coup final.
    await humanPlays({ to: 'e4' });
    await waitFor(() => JSON.parse(relay.get(MID) || 'null')?.matchDetails?.nbTurns === 1, 'notre coup est publié');
    assert(calls('arm_relay_drop').length === 0, 'partie en cours : rien d’armé');

    opponentWrites([{ to: 'e4' }, { to: 'mat' }]);
    await waitFor(() => calls('arm_relay_drop').length === 1, 'effacement armé');
    const arm = calls('arm_relay_drop')[0].args;
    assert(arm.matchId === 9, 'armé pour CETTE fenêtre (play-9)');
    assert(arm.relayUrl === RELAY && arm.gameId === MID,
        'avec le relai et l’identifiant de la partie — ceux que Rust effacera');
    assert(calls('disarm_relay_drop').length === 0, 'et rien ne le désarme tant que la partie reste finie');

    // L'adversaire reprend son coup final : la partie revit, plus rien à effacer.
    opponentWrites([{ to: 'e4' }]);
    await waitFor(() => calls('disarm_relay_drop').length === 1, 'effacement désarmé après la reprise');
    assert(calls('disarm_relay_drop')[0].args.matchId === 9, 'désarmé pour cette fenêtre');

    // Il rejoue le coup final : réarmé.
    opponentWrites([{ to: 'e4' }, { to: 'mat' }]);
    await waitFor(() => calls('arm_relay_drop').length === 2, 'réarmé quand la partie refinit');

    // La fermeture de la page ne désarme pas : c'est elle qui doit déclencher
    // l'envoi, côté Rust.
    dom.window.dispatchEvent(new dom.window.Event('beforeunload'));
    await sleep(50);
    assert(calls('disarm_relay_drop').length === 1, 'beforeunload ne désarme pas (c’est Rust qui envoie, après)');

    // Second scénario, dans son propre processus.
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), 'local-final'], { encoding: 'utf8' });
    process.stdout.write(out);
    const m = /(\d+) assertions OK/.exec(out);
    passed += m ? Number(m[1]) : 0;
    console.log(`\ntest-play-relay-drop: ${passed} assertions OK`);
    process.exit(0);
}

// local-final : c'est NOUS qui jouons le coup final.
await humanPlays({ to: 'e4' });
await waitFor(() => JSON.parse(relay.get(MID) || 'null')?.matchDetails?.nbTurns === 1, 'notre coup est publié');
opponentWrites([{ to: 'e4' }, { to: 'e5' }]);
await waitFor(() => match.playedMoves.length === 2 && match.pendingUserTurn, 'le coup adverse arrive');
await humanPlays({ to: 'mat' });
await waitFor(() => JSON.parse(relay.get(MID) || 'null')?.matchDetails?.nbTurns === 3, 'notre coup final est publié');
await sleep(150);
assert(calls('arm_relay_drop').length === 0,
    'coup final joué par nous : rien d’armé (l’autre ne l’a peut-être pas encore lu)');
assert(relay.has(MID), 'la partie reste sur le relai pour que l’adversaire la lise');
console.log(`${passed} assertions OK`);
process.exit(0);
