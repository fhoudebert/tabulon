// test-invitation-prefs.mjs — la fenêtre Invitation retient ce qui a marché.
//
// CE QUE ÇA ÉVITE. Une adresse publique ou un nom DynDNS ne s'invente pas, et
// se rappeler de tête le numéro de port ouvert dans sa box est exactement la
// corvée qu'un logiciel doit s'épargner. Ces trois champs étaient vides à
// chaque ouverture.
//
// LA RÈGLE QUI SE VÉRIFIE ICI : on ne retient QUE ce qui a servi. Reproposer
// une adresse qui a échoué serait pire que de ne rien proposer — le joueur
// croirait retrouver un réglage éprouvé, et chercherait la panne ailleurs.
//
// Usage : node tests/test-invitation-prefs.mjs   (depuis tabulon/)
import { JSDOM } from '../app/node_modules/jsdom/lib/api.js';
process.chdir(new URL('..', import.meta.url).pathname);
import { readFileSync } from 'fs';

const storeData = new Map();
const invokeCalls = [];
let hostShouldFail = false;

const mockTauri = {
    core: { invoke: async (cmd, args) => {
        invokeCalls.push({ cmd, args });
        if (cmd === 'peer_host_start') {
            // L'hébergement échoue tant que hostShouldFail est posé : c'est le
            // cas qui ne doit RIEN retenir.
            if (hostShouldFail) throw new Error('port occupé');
            return { port: args.port ?? 40123, ips: ['192.168.1.20'] };
        }
        return null;
    } },
    event: { listen: async () => (() => {}), emit: async () => {} },
    window:{ getCurrentWindow: () => ({ label: 'invitation', close: () => {}, setTitle: async () => {} }) },
    os:    { platform: async () => 'linux' },
    shell: { open: async () => {} },
    dialog:{ save: async () => null },
    http:  { fetch: async () => ({ status: 200, text: async () => '' }) },
    store: { Store: class { static async load() { return {
        get: async (k) => storeData.get(k), set: async (k, v) => { storeData.set(k, v); },
        delete: async () => {},
    }; } } },
};

const html = readFileSync('./app/content/invitation.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/invitation.html?game=classic-chess' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
dom.window.__TAURI__ = mockTauri;
globalThis.Jocly = {
    PLAYER_A: 1, PLAYER_B: -1,
    listGames: async () => ({ 'classic-chess': { title: 'Chess' } }),
    getGameConfig: async () => ({ model: { 'title-en': 'Chess' }, view: {} }),
};

// Des réglages déjà retenus par une session précédente.
storeData.set('invitation-last', {
    relayUrl: 'https://relai.perso/fileio.php',
    port: '7777',
    extraAddresses: 'monhote.dyndns.org',
});

await import('../app/content/invitation.js');
document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return; await sleep(20); }
    throw new Error('timeout: ' + what);
}
let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}
const $ = (id) => document.getElementById(id);

// 1. Au chargement, les champs reprennent ce qui a marché la dernière fois.
await waitFor(() => $('peer-port')?.value === '7777', 'les réglages retenus sont reproposés');
assert($('invitation-relay-url').value === 'https://relai.perso/fileio.php',
    'le relai retrouvé, et non le relai par défaut');
assert($('peer-extra-addr').value === 'monhote.dyndns.org',
    'l’adresse publique aussi — c’est elle qu’on ne peut pas deviner');

// 2. Un hébergement qui ÉCHOUE ne retient rien.
//
//    C'est la moitié qui compte : reproposer un port occupé ferait chercher la
//    panne ailleurs.
hostShouldFail = true;
$('peer-port').value = '9999';
$('peer-extra-addr').value = 'mauvaise.adresse';
$('button-peer-host').click();
await waitFor(() => invokeCalls.some(c => c.cmd === 'peer_host_start'), 'l’hébergement est tenté');
await sleep(80);
assert(storeData.get('invitation-last').port === '7777',
    'après un échec, l’ancien réglage est conservé tel quel');

// 3. Un hébergement qui RÉUSSIT les retient.
hostShouldFail = false;
$('button-peer-host').click();
await waitFor(() => storeData.get('invitation-last').port === '9999',
    'après une réussite, le nouveau port est retenu');
assert(storeData.get('invitation-last').extraAddresses === 'mauvaise.adresse',
    'et l’adresse avec lui — elle vient de servir, donc elle est bonne');

// 4. Le relai s'enregistre séparément, sans effacer le reste : les deux moitiés
//    de la fenêtre ne partagent rien d'autre que le fichier de préférences.
assert(storeData.get('invitation-last').relayUrl === 'https://relai.perso/fileio.php',
    'le relai n’a pas été effacé par l’enregistrement du pair-à-pair');

console.log(`\n${passed} assertions OK — réglages retenus de la fenêtre Invitation.`);
process.exit(0);
