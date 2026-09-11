// test-play-presence.mjs — « je fais une pause », de bout en bout.
//
// CE QUE ÇA RÉSOUT. En jeu à distance, rien ne distinguait un adversaire qui
// réfléchit d'un adversaire parti dîner : le plateau était immobile dans les
// deux cas, et le seul recours était d'attendre ou de fermer la fenêtre.
//
// LE CHOIX QUI SE VÉRIFIE ICI. Le bouton Pause EST « je fais une pause » :
// plutôt qu'un second bouton à côté qui dirait la même chose, celui qui existe
// prévient l'adversaire distant. En partie locale il n'y a personne à
// prévenir, et il doit alors se taire — c'est la moitié du test.
//
// Et ce qui traverse le réseau est un DRAPEAU, pas une phrase : `paused`
// s'affiche « s'est absenté » ici et autrement ailleurs, ce qui marche entre
// deux joueurs qui ne partagent aucune langue. Rien de personnel ne circule,
// donc aucune clé n'est nécessaire : la présence fonctionne même quand la
// partie n'a pas de discussion.
//
// Usage : node tests/test-play-presence.mjs   (depuis tabulon/)
import { JSDOM } from '../app/node_modules/jsdom/lib/api.js';
process.chdir(new URL('..', import.meta.url).pathname);
import { readFileSync } from 'fs';

const PLAYER_A = 1, PLAYER_B = -1;
const INVITE = 'inv-test';

// ── Mock Tauri ───────────────────────────────────────────────────────────────
const bus = {};
const invokeCalls = [];
const storeData = new Map();
storeData.set('invite:' + INVITE, {
    // Pair-à-pair : la session est déjà établie côté Rust, donc aucun relai à
    // simuler. La clé est là pour vérifier qu'elle traverse — mais la présence
    // n'en a pas besoin.
    matchId: 'p2p:abcdef123456', peer: true, player: 'a', creator: true,
    gameName: 'classic-chess', chatKey: 'd'.repeat(64),
});

const mockTauri = {
    core: { invoke: async (cmd, args) => {
        invokeCalls.push({ cmd, args });
        if (cmd === 'is_favorite') return false;
        if (cmd === 'peer_status') return { connected: true };
        if (cmd === 'peer_last_message') return null;
        /*
         * L'empreinte et la derivation vivent en Rust (seal_cmds.rs) : ici on
         * imite leur CONTRAT, pas leur cryptographie. Ce qui compte pour ce
         * test est qu'une empreinte designe toujours la meme cle, et qu'une
         * derivation depende de la partie.
         */
        if (cmd === 'chat_key_id') return 'id-' + String(args.master).slice(0, 8);
        if (cmd === 'derive_chat_key') return String(args.master).slice(0, 32) + String(args.info).padEnd(32, '0').slice(0, 32);
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
        get: async (k) => storeData.get(k), set: async (k, v) => { storeData.set(k, v); },
        delete: async () => {},
    }; } } },
};

// ── Match factice : deux humains, l'un d'eux distant ─────────────────────────
const match = {
    turn: PLAYER_A,
    playedMoves: [],
    pendingUserTurn: null,
    async getConfig()      { return { model: { levels: [] }, view: { skins: [] } }; },
    async attachElement()  {},
    async getTurn()        { return this.turn; },
    async getPlayedMoves() { return [...this.playedMoves]; },
    async getViewOptions() { return {}; },
    async setViewOptions() {},
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
let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}

const sentLines = () => invokeCalls
    .filter(c => c.cmd === 'peer_send')
    .map(c => { try { return JSON.parse(c.args.line); } catch { return null; } })
    .filter(Boolean);

// 1. L'adversaire distant est configuré depuis l'invitation. Le canal de jeu
//    rattrape le dernier message reçu pendant que la fenêtre s'ouvrait ; c'est
//    ce qu'on observe pour savoir qu'il est en place.
await waitFor(() => invokeCalls.some(c => c.cmd === 'peer_last_message'),
    'la session pair-à-pair est reprise depuis l’invitation');
assert(true, 'le canal distant s’ouvre au démarrage');

// 2. Pause : l'adversaire est prévenu.
document.getElementById('button-pause').click();
await waitFor(() => sentLines().some(m => m.kind === 'presence' && m.state === 'paused'),
    'un état de présence part sur la session');
{
    const msg = sentLines().find(m => m.kind === 'presence');
    assert(msg.state === 'paused', 'le bouton Pause annonce l’absence');
    // Un drapeau, pas une phrase : c'est ce qui permet à chacun de l'afficher
    // dans sa langue.
    assert(!('body' in msg), 'et il ne transporte aucun texte');
    // Signé du camp LOCAL : c'est lui qui décide de quel côté la présence
    // s'affiche chez l'autre.
    assert(msg.side === PLAYER_A, 'signé de notre camp');
}

// 3. Reprise : l'adversaire est prévenu aussi. Un état qui ne se lève jamais
//    laisserait l'autre croire à une absence indéfinie.
document.getElementById('button-resume').click();
await waitFor(() => sentLines().some(m => m.kind === 'presence' && m.state === 'back'),
    'la reprise est annoncée');
assert(true, 'le bouton Reprendre annonce le retour');

// 4. Ce que NOUS recevons s'affiche, avec le temps écoulé.
{
    const listeners = bus['tabulon-peer://message'] || [];
    assert(listeners.length > 0, 'la fenêtre écoute les messages de la session');
    listeners.forEach(fn => fn({ payload: JSON.stringify({
        v: 1, kind: 'presence', side: PLAYER_B, at: Date.now() - 12 * 60000,
        id: '0011223344556677', state: 'paused' }) }));
    await waitFor(() => /12/.test(document.getElementById('board-footer-text').textContent),
        'le pied de plateau annonce l’absence');
    const footer = document.getElementById('board-footer-text').textContent;
    // La durée est ce qui rend l'information utile : « en pause » ne dit pas
    // s'il faut attendre ou fermer la fenêtre, « en pause depuis 12 min » si.
    assert(/12/.test(footer), 'avec depuis combien de temps : ' + JSON.stringify(footer));
    // Un coup n'est pas un message : il passe par le même événement et ne doit
    // pas entrer dans la conversation.
    const before = footer;
    listeners.forEach(fn => fn({ payload: JSON.stringify({ v: 1, nbTurns: 1, lastMove: null, state: null }) }));
    await sleep(50);
    assert(document.getElementById('board-footer-text').textContent === before,
        'un coup reçu ne change pas l’affichage de présence');
}

// 5. La fenêtre de discussion : le bouton n'apparaît qu'avec un adversaire
//    distant, et l'envoi passe par le canal.
{
    const btn = document.getElementById('button-chat');
    assert(btn && btn.style.display !== 'none',
        'le bouton Discussion apparaît quand le canal distant est ouvert');

    // Un message RAPIDE part comme identifiant, pas comme texte : c'est ce qui
    // permet à l'autre de le lire dans sa langue, et rien de personnel ne
    // transite — donc rien à sceller.
    await mockTauri.event.emit(`play-req:9:send-chat`, { quick: 'wellPlayed' });
    await waitFor(() => sentLines().some(m => m.kind === 'chat' && m.quick === 'wellPlayed'),
        'un message rapide part sur la session');
    const quick = sentLines().find(m => m.kind === 'chat');
    assert(quick.quick === 'wellPlayed', 'il voyage comme identifiant');
    assert(!('body' in quick), 'et ne transporte aucun texte');

    // Et la fenêtre reçoit l'état du fil, avec de quoi savoir si le texte
    // libre est possible.
    let pushed = null;
    (bus['play-event:9:chat'] ??= []).push(({ payload }) => { pushed = payload; });
    await mockTauri.event.emit(`play-req:9:get-chat`, {});
    await waitFor(() => pushed !== null, 'la fenêtre reçoit la conversation');
    assert(Array.isArray(pushed.conversation), 'avec le fil');
    assert(pushed.canWrite === true, 'et le droit d’écrire — ici pair-à-pair, rien ne transite par un serveur');
}

// 6. La pastille de messages non lus.
//
//    Elle existe parce que la fenêtre est fermée par défaut : sans elle, un
//    message arrive et personne ne le sait. Et play.js n'a aucun moyen de
//    savoir si la fenêtre est ouverte — Tauri ne prévient pas de sa fermeture
//    — donc c'est la fenêtre qui signale ce qu'elle a affiché. Tant qu'elle se
//    tait, les messages sont non lus, ce qui est exactement vrai.
{
    const btn = document.getElementById('button-chat');
    const listeners = bus['tabulon-peer://message'] || [];
    const incoming = (id, body) => listeners.forEach(fn => fn({ payload: JSON.stringify({
        v: 1, kind: 'chat', side: PLAYER_B, at: Date.now(), id, quick: body }) }));

    incoming('1111111111111111', 'yourTurn');
    await waitFor(() => btn.classList.contains('has-unread'), 'la pastille s’allume');
    // UN, pas deux : l'adversaire a aussi envoyé un état de présence plus haut,
    // et celui-là s'affiche déjà dans le pied de plateau. L'allumer enverrait
    // ouvrir une fenêtre où il n'y a rien de nouveau à lire.
    assert(btn.dataset.unread === '1', 'un changement de présence ne compte pas comme un message');

    incoming('2222222222222222', 'wellPlayed');
    await waitFor(() => btn.dataset.unread === '2', 'deux messages non lus');
    assert(btn.dataset.unread === '2', 'le compte suit — « 3 » dit s’il faut ouvrir tout de suite');

    // La fenêtre signale ce qu'elle a affiché : la pastille s'éteint.
    await mockTauri.event.emit('play-req:9:chat-seen', { id: '2222222222222222' });
    await waitFor(() => !btn.classList.contains('has-unread'), 'la pastille s’éteint');
    assert(btn.dataset.unread === '', 'et le compte est vidé');

    // Un message de plus après lecture rallume, sans recompter les anciens.
    incoming('3333333333333333', 'rematch');
    await waitFor(() => btn.dataset.unread === '1', 'un message de plus rallume');
    assert(btn.dataset.unread === '1', 'sans recompter ceux déjà lus');

    // NOS propres messages ne comptent pas : ils sont lus par construction.
    await mockTauri.event.emit('play-req:9:send-chat', { quick: 'yourTurn' });
    await sleep(60);
    assert(btn.dataset.unread === '1', 'nos propres messages ne s’ajoutent pas au compte');
}

// 7. Ajouter une clé à une partie qui n'en avait pas.
//
//    Elle ne peut pas s'inventer d'un seul côté : les deux joueurs doivent
//    avoir LA MÊME, et elle ne doit pas passer par le relai — sinon il
//    l'aurait, et le chiffrement ne servirait plus à rien. Elle se transmet
//    donc de la main à la main, et chacun la colle chez soi ; play.js la range
//    avec l'invitation, seule copie qui existe.
{
    const key = 'e'.repeat(64);
    await mockTauri.event.emit('play-req:9:set-chat-key', { key });
    await waitFor(() => storeData.get('invite:' + INVITE)?.chatKey === key,
        'la clé est rangée avec l’invitation');
    assert(storeData.get('invite:' + INVITE).chatKey === key, 'et c’est bien celle qu’on a collée');

    // Un format inattendu est refusé plutôt que rangé : une clé à moitié valide
    // ne protège rien et donnerait l'apparence du contraire.
    await mockTauri.event.emit('play-req:9:set-chat-key', { key: 'trop court' });
    await sleep(60);
    assert(storeData.get('invite:' + INVITE).chatKey === key, 'une clé mal formée ne remplace pas la bonne');

    /*
     * ET LA CLE REDESCEND VERS LA FENETRE.
     *
     * Sans cela, celui qui CREE la partie n'avait aucun moyen de la relire :
     * elle est tirée au tirage de l'invitation et ne vit que dans le fragment
     * du lien. Si l'autre ne l'avait pas reçue — lien tronqué à la copie —
     * personne ne pouvait la lui redonner, et la ligne de saisie
     * n'apparaissait que chez celui qui en manquait.
     */
    let pushed = null;
    (bus['play-event:9:chat'] ??= []).push(({ payload }) => { pushed = payload; });
    await mockTauri.event.emit('play-req:9:get-chat', {});
    await waitFor(() => pushed !== null, 'la fenêtre reçoit l’état du fil');
    assert(pushed.chatKey === key, 'avec la clé, pour pouvoir l’afficher et la redonner');
}

// 9. Le trousseau descend vers la fenêtre, et en choisir une entrée change la
//    clé de la partie.
//
//    C'est la manœuvre courante quand on ne se lit pas : les deux joueurs
//    n'emploient pas la même clé de communauté. La bonne est presque toujours
//    déjà sur la machine, sous un autre nom — d'où une liste plutôt qu'un
//    champ à coller. Seuls les NOMS et les empreintes voyagent jusqu'à la
//    fenêtre : les clés restent dans les préférences.
{
    const master = 'f'.repeat(64);
    storeData.set('community-keys', [{ id: 'x', name: 'Famille', key: master }]);

    let pushed = null;
    (bus['play-event:9:chat'] ??= []).push(({ payload }) => { pushed = payload; });
    await mockTauri.event.emit('play-req:9:get-chat', {});
    await waitFor(() => pushed !== null, 'la fenêtre reçoit l’état du fil');
    assert(Array.isArray(pushed.keyring), 'avec le trousseau');
    assert(pushed.keyring.every(k => !('key' in k)),
        'mais sans les clés elles-mêmes : la fenêtre n’en a pas besoin pour en désigner une');
    assert(pushed.keyring[0]?.name === 'Famille', 'et avec leur nom, seul repère lisible');

    // Choisir une entrée DÉRIVE la clé de la partie : rien ne transite, et
    // l'autre joueur qui choisit la même communauté obtient la même clé.
    const before = storeData.get('invite:' + INVITE).chatKey;
    await mockTauri.event.emit('play-req:9:set-chat-keyring', { id: pushed.keyring[0].id });
    await waitFor(() => storeData.get('invite:' + INVITE).chatKey !== before,
        'la clé de la partie change');
    assert(storeData.get('invite:' + INVITE).chatKeyId === pushed.keyring[0].id,
        'et l’empreinte est retenue, pour reconnaître l’entrée la prochaine fois');
}

console.log(`\n${passed} assertions OK — présence en jeu à distance validée.`);
process.exit(0);
