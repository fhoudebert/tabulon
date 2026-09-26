// tests/import/test-book-position.mjs — une position illisible se dit, et
// n'ouvre rien.
//
// CE QUI SE JOUE ICI. Un fichier dont le [FEN] ne se charge pas faisait quand
// même ouvrir une fenêtre de jeu : elle s'y plaignait en console -- « import
// failed: parse error » -- posait un plateau figé et n'en disait rien.
// L'utilisateur voyait une partie qui ne s'ouvre pas, sans savoir pourquoi.
//
// La position est donc essayée AVANT, dans la fenêtre du livre, là où le clic
// a eu lieu. La liste reste affichée : les autres parties du fichier sont
// peut-être lisibles.
//
// Usage : node tests/import/test-book-position.mjs
import { JSDOM } from '../../app/node_modules/jsdom/lib/api.js';
import { completeTauriInjection } from '../helpers/tauri-mock.mjs';
process.chdir(new URL('../..', import.meta.url).pathname);
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const repo = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
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

// Deux parties : la première porte une position que le jeu refuse, la seconde
// part de la position standard.
const BAD = '[Event "Bancale"]\n[FEN "n’importe quoi"]\n[SetUp "1"]\n\n1. e4 e5 *\n';
const GOOD = '[Event "Ordinaire"]\n\n1. d4 d5 *\n';

const invokeCalls = [];
const storeData = new Map();
const mockTauri = {
    core: { invoke: async (cmd, payload = {}) => {
        invokeCalls.push({ cmd, payload });
        if (cmd === 'parse_pjn') return [
            { label: '#1', text: BAD,  tags: { Event: 'Bancale', FEN: 'n’importe quoi', SetUp: '1' } },
            { label: '#2', text: GOOD, tags: { Event: 'Ordinaire' } },
        ];
        return null;
    } },
    event: { listen: async () => () => {}, emit: async () => {} },
    window: { getCurrentWindow: () => ({ label: 'book', close: () => {} }) },
    os:    { platform: async () => 'linux' },
    shell: { open: async () => {} },
    dialog:{ save: async () => null },
    store: { Store: class { static async load() { return {
        get: async (k) => storeData.get(k), set: async (k, v) => { storeData.set(k, v); },
        delete: async (k) => { storeData.delete(k); },
    }; } } },
};

const html = readFileSync(repo + '/app/content/book.html', 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'https://tauri.localhost/content/book.html?game=classic-chess&file=bancal.pgn' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
dom.window.__TAURI__ = completeTauriInjection(mockTauri);

// Le moteur, réduit à ce que la fenêtre lui demande : la fiche du jeu, et un
// match d'essai qui refuse la position — comme le vrai le fait.
let loads = 0;
globalThis.Jocly = {
    getGameConfig: async () => ({ model: { 'title-en': 'Chess', levels: [] } }),
    listGames: async () => ({ 'classic-chess': {} }),
    createMatch: async () => ({
        load: async ({ initialBoard }) => {
            loads++;
            if (initialBoard && !/^[rnbqkpRNBQKP1-8/]+ [wb] /.test(initialBoard))
                throw new Error('import failed: parse error');
        },
    }),
};

storeData.set('book:classic-chess', { fileName: 'bancal.pgn', data: BAD + '\n' + GOOD });

await import('../../app/content/book.js');
document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));
await waitFor(() => document.querySelectorAll('.book-content li').length === 2, 'les deux parties listées');

const message = () => {
    const box = document.querySelector('.book-content .message');
    return box.style.display === 'none' ? '' : box.textContent.trim();
};
const items = [...document.querySelectorAll('.book-content li')];

// ── La partie bancale ───────────────────────────────────────────────────────
{
    const before = invokeCalls.length;
    items[0].click();
    await waitFor(() => message().length > 0, 'un motif est affiché');
    assert(!invokeCalls.slice(before).some(c => c.cmd === 'new_match'),
        'aucune fenêtre de jeu ouverte sur une position illisible');
    assert(loads > 0, 'la position a bien été essayée avant');
    assert(/parse error/.test(message()),
        'le motif du moteur est rapporté tel quel — « ' + message().slice(0, 80) + ' »');
    assert(document.querySelector('.book-content ul').style.display !== 'none',
        'et la liste reste affichée : les autres parties sont peut-être lisibles');
}

// ── La partie ordinaire, juste après ────────────────────────────────────────
{
    const before = invokeCalls.length;
    items[1].click();
    await waitFor(() => invokeCalls.slice(before).some(c => c.cmd === 'new_match'), 'la seconde s\'ouvre');
    const nm = invokeCalls.slice(before).find(c => c.cmd === 'new_match');
    assert(nm.payload.gameName === 'classic-chess', 'dans le jeu du livre');
    const fork = storeData.get('fork:' + nm.payload.forkId);
    assert(fork?.book?.moves?.join(' ') === 'd4 d5', 'avec ses coups (' + fork.book.moves.join(' ') + ')');
}

console.log(`\n${passed} assertions OK — position refusée dans la fenêtre du livre.`);
process.exit(0);
