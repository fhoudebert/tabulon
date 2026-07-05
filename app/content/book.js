// app/content/book.js
//
// Fenêtre "livre" : liste les parties d'un fichier PGN/PJN et permet d'en
// rejouer une. Flux (remplace le PJNParser Electron de JoclyBoard) :
//   1. hub.js dépose {fileName, data} dans le store sous 'book:{gameName}'
//   2. cette fenêtre lit le store et parse via la commande Rust parse_pjn
//   3. au clic sur une partie : les coups SAN sont extraits du texte, déposés
//      dans le store sous 'fork:{id}' avec un marqueur `book`, puis
//      new_match(gameName, null, id) — play.js détecte le marqueur et rejoue
//      les coups via l'API Jocly pickMove/playMove. La navigation dans la
//      partie se fait ensuite par la fenêtre History (start/step/end).
import tRpc from './tabulon-rpc.js';
import twu  from './tabulon-winutils.js';
import { Store } from './tauri-bridge.js';
import { initI18n, t } from './tabulon-i18n.js';

const gameName = (function () {
    const m = /\?.*\bgame=([^&]+)/.exec(window.location.href);
    return m && m[1] || 'classic-chess';
})();
const fileName = (function () {
    const m = /\?.*\bfile=([^&]+)/.exec(window.location.href);
    if (m && m[1]) {
        const f = decodeURIComponent(m[1]);
        return /([^/\\]*)$/.exec(f)[1];
    }
    return 'PJN';
})();

// Extrait les coups SAN du texte d'une partie PGN/PJN : retire les tags, les
// commentaires {…}, les variantes (…), les numéros de coups, les NAG $n et
// le résultat. Exporté pour les tests.
export function ExtractMoves(text) {
    const parts = String(text).replace(/\r\n?/g, '\n').split(/\n\n+/);
    const movesPart = (parts.length > 1 ? parts.slice(1) : parts).join('\n');
    let s = movesPart.replace(/\{[^}]*\}/g, ' ');
    while (/\([^()]*\)/.test(s)) s = s.replace(/\([^()]*\)/g, ' ');
    return s.split(/\s+/)
        .map(tok => tok.replace(/^\d+\.+/, ''))     // "12.Nf3" → "Nf3"
        .filter(tok => tok
            && !/^\d+\.+$/.test(tok)                 // "12."
            && !/^\$\d+$/.test(tok)                  // NAG
            && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok) // résultat
            && !/^\[/.test(tok));
}

function ShowError(error) {
    document.querySelector('.book-content ul').style.display = 'none';
    const msg = document.querySelector('.book-content .message > div > div');
    msg.textContent = error;
    msg.style.display = '';
    document.querySelector('.book-content .message').style.display = '';
}

function SetBookMatches(matches) {
    const list = document.querySelector('.book-content ul');
    matches.forEach((match) => {
        const li = document.createElement('li');
        li.className = 'list-group-item object-list-item';
        li.innerHTML = `<div class="media-body"><strong></strong></div>`;
        li.querySelector('strong').textContent = match.label;
        li.addEventListener('click', () => OpenBookMatch(match));
        list.appendChild(li);
    });
    document.querySelector('.book-content .message').style.display = 'none';
    list.style.display = '';
}

async function OpenBookMatch(match) {
    const moves = ExtractMoves(match.text);
    const id = 'book-' + Date.now();
    const store = await Store.load('tabulon.json');
    await store.set('fork:' + id, {
        book: { moves, playerA: match.playerA, playerB: match.playerB },
    });
    tRpc.call('new_match', gameName, null, id);
}

document.addEventListener('DOMContentLoaded', async () => {
    await initI18n();
    const config = await Jocly.getGameConfig(gameName);
    await twu.init(config.model['title-en'] + ' — ' + fileName);
    setTimeout(() => twu.ready(), 0);

    try {
        const store = await Store.load('tabulon.json');
        const book = await store.get('book:' + gameName);
        if (!book?.data) return ShowError(t('book.noContent'));
        const matches = await tRpc.call('parse_pjn', book.data);
        if (!matches || matches.length === 0) return ShowError(t('book.noGame'));
        SetBookMatches(matches);
    } catch (e) {
        ShowError(t('book.parseError') + ' ' + (e.message || e));
    }
});
