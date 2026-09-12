// test-play-viewas.mjs — de quel côté le plateau se regarde en partie à
// distance.
//
// CE QUE ÇA RÉSOUT. Le joueur B ouvrait sa partie vue de chez A : les pièces
// qui avancent venaient vers lui, la notation était à l'envers, et il fallait
// passer par « Options de vue > Voir en tant que » à chaque partie. La cause
// était un ORDRE : l'invitation — seule à savoir quel camp on joue — n'était
// relue qu'au bas de play.js, longtemps après attachElement(), donc après que
// la vue ait été construite avec viewAs = PLAYER_A.
//
// CE QUI SE VÉRIFIE ICI est donc le moment autant que la valeur : l'option est
// posée AVANT l'attachement, pour que le plateau soit dessiné du bon côté du
// premier coup — et non retourné après, ce qui se verrait à l'écran et
// demanderait de réarmer le tour en cours (voir set-view-options).
//
// Usage : node tests/test-play-viewas.mjs   (depuis tabulon/)
import { JSDOM } from '../app/node_modules/jsdom/lib/api.js';
process.chdir(new URL('..', import.meta.url).pathname);
import { readFileSync } from 'fs';

const PLAYER_A = 1, PLAYER_B = -1;
const INVITE = 'inv-viewas';

let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}

// ── Mock Tauri ───────────────────────────────────────────────────────────────
const bus = {};
const storeData = new Map();
const storeWrites = [];
storeData.set('invite:' + INVITE, {
    // Nous sommes l'INVITÉ : « player » est le côté qu'on joue localement.
    matchId: 'p2p:abcdef123456', peer: true, player: 'b', creator: false,
    gameName: 'classic-chess', chatKey: 'd'.repeat(64),
});
/*
 * UNE PRÉFÉRENCE CONTRAIRE, à dessein.
 *
 * Le jeu a déjà été regardé « en tant que A » dans une partie locale, et c'est
 * enregistré. Le camp qu'on joue est un fait de CETTE partie : il doit
 * l'emporter, sans quoi l'option resterait bonne pour les parties locales et
 * fausse pour celles à distance — exactement le cas qui a été signalé.
 */
storeData.set('view-options:classic-chess', { skin: 'skin2d', viewAs: PLAYER_A, moves: true });

const mockTauri = {
    core: { invoke: async (cmd) => {
        if (cmd === 'is_favorite') return false;
        if (cmd === 'peer_status') return { connected: true };
        if (cmd === 'peer_last_message') return null;
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
    http:  { fetch: async () => ({ status: 200, text: async () => '' }) },
    store: { Store: class { static async load() { return {
        get: async (k) => storeData.get(k),
        set: async (k, v) => { storeWrites.push({ k, v }); storeData.set(k, v); },
        delete: async (k) => { storeData.delete(k); },
    }; } } },
};

// ── Match factice : on n'observe que ce qu'attachElement reçoit ──────────────
let attached = null;          // les options au moment de l'attachement
const setViewCalls = [];      // les changements APRÈS coup
const match = {
    turn: PLAYER_A,
    playedMoves: [],
    pendingUserTurn: null,
    async getConfig() {
        // Vue retournable : c'est la condition pour que viewAs ait un sens
        // (jocly l'ignore pour les autres).
        return { model: { levels: [] }, view: { skins: [], switchable: true } };
    },
    async attachElement(_el, opts) { attached = JSON.parse(JSON.stringify(opts || {})); },
    async getTurn()        { return this.turn; },
    async getPlayedMoves() { return [...this.playedMoves]; },
    async getViewOptions() { return attached?.viewOptions || {}; },
    async setViewOptions(o){ setViewCalls.push(o); },
    async abortUserTurn()  {
        if (this.pendingUserTurn) {
            const p = this.pendingUserTurn; this.pendingUserTurn = null;
            p.reject(new Error('User input aborted'));
        }
    },
    async abortMachineSearch() {},
    async getBoardState()  { return 'fen'; },
    async save()           { return { game: 'classic-chess', playedMoves: [] }; },
    async viewControl()    { return null; },
    userTurn() { return new Promise((resolve, reject) => { this.pendingUserTurn = { resolve, reject }; }); },
    async machineSearch()  { return { move: {} }; },
    async playMove(move)   { this.playedMoves.push(move); this.turn = -this.turn; return { finished: false, winner: null }; },
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
async function waitFor(fn, what, timeout = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return; await sleep(20); }
    throw new Error('timeout: ' + what);
}

console.log('Le joueur B ouvre sa partie de son côté');

await waitFor(() => attached !== null, 'la vue est attachée');
assert(attached.viewOptions.viewAs === PLAYER_B,
    'le plateau est attaché vu du camp qu’on joue');
assert(attached.viewOptions.skin === 'skin2d',
    'et le reste des préférences du jeu est conservé');

// Posée AVANT l'attachement, pas corrigée après : un retournement après coup
// se verrait à l'écran et laisserait le tour en cours armé sur l'ancienne vue.
await sleep(100);
assert(!setViewCalls.some(o => o && 'viewAs' in o),
    'sans retournement après coup');

/*
 * ET RIEN N'EST RÉÉCRIT DANS LES PRÉFÉRENCES DU JEU.
 *
 * L'orientation appartient à cette partie-ci. L'enregistrer ferait ouvrir la
 * prochaine partie locale de ce jeu à l'envers, sans que rien ne l'ait
 * demandé — une partie à distance contaminerait toutes les suivantes.
 */
assert(storeData.get('view-options:classic-chess').viewAs === PLAYER_A,
    'la préférence enregistrée du jeu n’est pas touchée');
assert(!storeWrites.some(w => w.k === 'view-options:classic-chess'),
    'elle n’est même pas réécrite');

// Le camp distant est bien l'AUTRE : c'est la même invitation qui décide des
// deux, et les voir diverger serait le symptôme d'une correction faite à côté.
{
    let players = null;
    (bus['play-rep:9:get-players'] ??= []).push(({ payload }) => { players = payload; });
    await mockTauri.event.emit('play-req:9:get-players', {});
    await waitFor(() => players !== null, 'la fenêtre Joueurs reçoit les camps');
    assert(players.players[PLAYER_A]?.type === 'remote',
        'le camp A est le joueur distant');
    assert(players.players[PLAYER_B]?.type !== 'remote',
        'et B — le nôtre — est local');
}

console.log('');
console.log(`${passed} assertions OK — orientation du plateau en partie à distance validée.`);
process.exit(0);
