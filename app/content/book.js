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
import { ExtractMoves, BookFen, BookLabel, BookGame, IsTsume } from './book-format.js';

// Re-export : tests/test-book.mjs importe ExtractMoves depuis ce module.
export { ExtractMoves };

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

function ShowError(error) {
    document.querySelector('.book-content ul').style.display = 'none';
    const msg = document.querySelector('.book-content .message > div > div');
    msg.textContent = error;
    msg.style.display = '';
    document.querySelector('.book-content .message').style.display = '';
}

// Libelle d'une partie du fichier. On IGNORE match.label venu de Rust : il
// s'ecrivait "? vs ? #1" pour tout fichier sans tags [White]/[Black], donc
// pour tout fichier produit par Tabulon. BookLabel descend une echelle de
// repli (joueurs, [Event], nom du fichier, date) et le meme calcul sert au
// pied de la fenetre de jeu.
function MatchLabel(match, index, count) {
    return BookLabel(match.tags, {
        index, count, fileName,
        plies: ExtractMoves(match.text).length,
        pliesLabel: t('book.plies'),
    });
}

function SetBookMatches(matches) {
    const list = document.querySelector('.book-content ul');
    matches.forEach((match, index) => {
        const li = document.createElement('li');
        li.className = 'list-group-item object-list-item';
        li.innerHTML = `<div class="media-body"><strong></strong></div>`;
        li.querySelector('strong').textContent = MatchLabel(match, index, matches.length);
        li.addEventListener('click', () => OpenBookMatch(match, index, matches.length));
        list.appendChild(li);
    });
    document.querySelector('.book-content .message').style.display = 'none';
    list.style.display = '';
}

// Jeu d'UNE partie du livre. Un fichier peut en melanger plusieurs -- le
// all-tests.pgn de reference contient douze parties de douze jeux differents,
// chacune avec son tag [JoclyGame]. La fenetre etait ouverte pour un seul jeu
// (celui de la premiere partie, choisi par le hub) et lancait TOUTES les
// parties dedans : cliquer sur la partie de xiangqi ouvrait shako-chess, ou
// les coups etaient refuses des le premier.
async function MatchGame(match) {
    const declared = BookGame(match.tags);
    if (!declared || declared === gameName) return gameName;
    const games = await Jocly.listGames().catch(() => ({}));
    if (!games[declared]) {
        console.warn('[book] la partie designe', declared, '— jeu absent du catalogue, ouverture dans', gameName);
        return gameName;
    }
    return declared;
}

async function OpenBookMatch(match, index, count) {
    const moves = ExtractMoves(match.text);
    const id = 'book-' + Date.now();
    const game = await MatchGame(match);
    const store = await Store.load('tabulon.json');
    await store.set('fork:' + id, {
        book: {
            moves,
            // Libelle deja calcule : la fenetre de jeu n'a ni le nom du
            // fichier ni les tags, elle ne pourrait pas le refaire.
            label: MatchLabel(match, index, count),
            // Tag [FEN] : la partie ne part pas de la position standard
            // (probleme, finale, position d'etude). play.js charge cette
            // position AVANT de rejouer les coups.
            initialBoard: BookFen(match.tags),
            // Le RESULTAT, tel que le fichier le declare. Sans lui, une partie
            // rechargee perd son issue : la fenetre de jeu ne la calcule qu'en
            // jouant, et une partie rejouee depuis un fichier ne passe pas par
            // la. Le tag existait deja et n'etait simplement pas transmis --
            // l'Historique la reexportait donc en « * », partie en cours.
            result: (match.tags && match.tags.Result) || null,
            // Probleme de mat : le camp attaquant n'a pas de roi, et sans
            // cette option jocly tient sa position pour perdue d'avance --
            // aucun coup legal, rien a rejouer ni a parcourir.
            tsume: IsTsume(match.text, match.tags),
        },
    });
    tRpc.call('new_match', game, null, id);
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
