// test-play-remote-takeback.mjs — reprise de coup face à un joueur distant,
// dans play.js, contre un relai fileio.php en mémoire tenu « en face » comme
// le ferait control.js de joclymatch.
//
// CE QUI SE VÉRIFIE ICI :
//   - l'hôte publie le réglage de la partie dès l'état initial ;
//   - Reculer n'est offert qu'à NOTRE tour (joclymatch ne sonde que pendant
//     qu'il attend) ; l'infobulle dit pourquoi sinon ;
//   - notre reprise PUBLIE le nouveau compte et l'état complet, sans perdre
//     le réglage ;
//   - la reprise de l'adversaire est CHARGÉE telle quelle : aucun coup n'est
//     rejoué (le piège du `!=` corrigé côté joclymatch), la boucle se réarme
//     sur la bonne position, et le joueur en est prévenu ;
//   - le fichier fait foi : s'il dit « interdite », les boutons se ferment.
//
// Usage : node tests/test-play-remote-takeback.mjs   (depuis tabulon/)
import { JSDOM } from '../app/node_modules/jsdom/lib/api.js';
process.chdir(new URL('..', import.meta.url).pathname);
import { readFileSync } from 'fs';

const PLAYER_A = 1, PLAYER_B = -1;
const INVITE = 'inv-takeback';
const MID = 'mid-takeback';

let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}

// ── Relai en mémoire ─────────────────────────────────────────────────────────
const relay = new Map();
async function relayFetch(_url, init) {
    const p = new URLSearchParams(init.body);
    if (p.get('gameioaction') === 'save') { relay.set(p.get('gameid'), p.get('gamedata')); return { status: 200, text: async () => 'ok' }; }
    if (p.get('gameioaction') === 'load') { const t = relay.get(p.get('gameid')) ?? ''; return { status: 200, text: async () => t }; }
    return { status: 200, text: async () => '' };   // chat & co : sans objet ici
}
const file = () => JSON.parse(relay.get(MID) || 'null');
// Ce qu'écrirait control.js (saveGameIfNecessary) : matchDetails reconstruit.
function opponentWrites(moves, allowTakeback) {
    const matchDetails = { matchId: MID, gameName: 'classic-chess', nbTurns: moves.length, a: { pseudo: '' }, b: { pseudo: '' } };
    if (allowTakeback !== undefined) matchDetails.allowTakeback = allowTakeback;
    relay.set(MID, JSON.stringify({ matchDetails, matchdata: { playedMoves: [...moves] }, time: Date.now(), key: 'k' }));
}

// ── Mock Tauri ───────────────────────────────────────────────────────────────
const bus = {};
const storeData = new Map();
storeData.set('invite:' + INVITE, {
    matchId: MID, relayUrl: 'https://relai.test/fileio.php', gameName: 'classic-chess',
    player: 'a', creator: true, peer: false, chatKey: null, allowTakeback: true,
});
const mockTauri = {
    core: { invoke: async () => null },
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

// ── Match factice : alternance stricte, A commence ──────────────────────────
const turnOf = (n) => n % 2 === 0 ? PLAYER_A : PLAYER_B;
const match = {
    playedMoves: [],
    pendingUserTurn: null,
    playMoveCalls: [],
    loadCalls: 0,
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
    async save()           { return { game: 'classic-chess', playedMoves: [...this.playedMoves] }; },
    async load(state)      { this.loadCalls++; this.playedMoves = [...(state.playedMoves || [])]; },
    async rollback(n)      { this.playedMoves = this.playedMoves.slice(0, n); },
    async viewControl()    { return null; },
    userTurn() { return new Promise((resolve, reject) => { this.pendingUserTurn = { resolve, reject }; }); },
    async machineSearch()  { return { move: {} }; },
    async playMove(move)   { this.playMoveCalls.push(move); this.playedMoves.push(move); return { finished: false, winner: null }; },
};

const html = readFileSync('./app/content/play.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: `https://tauri.localhost/content/play.html?game=classic-chess&id=9&invite=${INVITE}` });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.FileReader = dom.window.FileReader;
dom.window.__TAURI__ = mockTauri;
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
const takebackBtn = () => document.getElementById('button-takeback');
const restartBtn  = () => document.getElementById('button-restart');
const warning     = () => document.getElementById('play-warning');
async function humanPlays(move) {
    await waitFor(() => match.pendingUserTurn, 'le tour humain est armé');
    const p = match.pendingUserTurn; match.pendingUserTurn = null;
    match.playedMoves.push(move);
    p.resolve({ move, finished: false, winner: null });
}

// 1. L'hôte publie tout de suite l'état de départ, AVEC le réglage.
await waitFor(() => file(), 'l’état initial est publié');
assert(file().matchDetails.nbTurns === 0 && file().matchDetails.allowTakeback === true,
    'l’hôte publie l’état initial et le réglage de la partie');

// 2. Notre tour : Reculer est offert (rien à reculer encore, mais permis).
await waitFor(() => match.pendingUserTurn && !takebackBtn().disabled, 'notre tour ouvre les boutons');
assert(!takebackBtn().disabled && !restartBtn().disabled, 'pendant notre tour, Reculer et Recommencer sont actifs');

// 3. Nous jouons ; pendant le tour adverse, les boutons se ferment et disent pourquoi.
await humanPlays({ to: 'e4' });
await waitFor(() => file().matchDetails.nbTurns === 1, 'notre coup est publié');
assert(file().matchDetails.allowTakeback === true, 'le réglage survit à notre sauvegarde');
await waitFor(() => takebackBtn().disabled, 'les boutons se ferment');
assert(/à votre tour|on your turn/.test(takebackBtn().title), 'l’infobulle dit « à votre tour », pas « interdit »');

// 4. L'adversaire (joclymatch) répond — son fichier reconstruit matchDetails
//    et PORTE le réglage, comme le fera le control.js corrigé.
opponentWrites([{ to: 'e4' }, { to: 'e5' }], true);
await waitFor(() => match.playedMoves.length === 2 && match.pendingUserTurn, 'le coup adverse est joué, notre tour revient');

// 5. Nous reprenons : retour à NOTRE tour précédent (notre coup et sa réponse).
const playsBefore = match.playMoveCalls.length;
takebackBtn().click();
await waitFor(() => file().matchDetails.nbTurns === 0, 'la reprise est publiée');
assert(match.playedMoves.length === 0, 'la position locale revient à notre tour précédent');
assert(file().matchData === undefined && Array.isArray(file().matchdata.playedMoves) && file().matchdata.playedMoves.length === 0,
    'l’état complet part avec le nouveau compte (c’est lui que joclymatch charge)');
assert(file().matchDetails.allowTakeback === true, 'et le réglage n’est pas perdu en route');
await waitFor(() => match.pendingUserTurn, 'la boucle se réarme sur notre tour');
assert(match.playMoveCalls.length === playsBefore, 'aucun coup n’est rejoué pendant notre reprise');

// 6. Nous rejouons, puis l'ADVERSAIRE reprend pendant son tour : il annule
//    notre coup. Le compte baisse de 1 à 0.
await humanPlays({ to: 'd4' });
await waitFor(() => file().matchDetails.nbTurns === 1, 'notre nouveau coup est publié');
const playsBeforeRemote = match.playMoveCalls.length;
const loadsBefore = match.loadCalls;
opponentWrites([], true);
await waitFor(() => match.loadCalls > loadsBefore, 'l’état de l’adversaire est chargé');
assert(match.playedMoves.length === 0, 'la position est celle du fichier, telle quelle');
assert(match.playMoveCalls.length === playsBeforeRemote,
    'AUCUN coup rejoué : une baisse n’est pas un coup (le piège du « != »)');
assert(!warning().classList.contains('hidden') && /recommencé|restarted/.test(warning().textContent),
    'le joueur est prévenu que le plateau a changé tout seul');
await waitFor(() => match.pendingUserTurn, 'la boucle attend de nouveau NOTRE saisie');
assert(true, 'la boucle ne reste pas bloquée à attendre un coup distant qui ne viendra pas');

// 7. Le fichier fait foi : l'adversaire y écrit « interdite ».
opponentWrites([], false);
await waitFor(() => takebackBtn().disabled, 'le fichier ferme les boutons');
assert(/n’autorise pas|does not allow/.test(takebackBtn().title),
    'l’infobulle dit « la partie n’autorise pas », distinct de « à votre tour »');
const before = relay.get(MID);
restartBtn().disabled = false;          // garde de fond : on force le clic
restartBtn().click();
await sleep(100);
assert(relay.get(MID) === before, 'la garde de fond refuse aussi : rien n’est publié');

console.log(`\n${passed} assertions OK — reprise de coup en partie à distance validée.`);
process.exit(0);
