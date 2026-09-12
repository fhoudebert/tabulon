// app/content/history.js
// Fenetre satellite : historique des coups joues.
// Affiche les coups, permet de naviguer (rollback) dans la partie.
// Communique avec play.html via Tauri events (play-req/play-rep:{matchId}:*).

import tRpc from './tabulon-rpc.js';
import twu  from './tabulon-winutils.js';
import { BuildPJN, BuildPGN, BuildSGF } from './book-format.js';
import { listen, emit, save as saveDialog, Store } from './tauri-bridge.js';
import { initI18n, t } from './tabulon-i18n.js';

// Le jeu vient de l'URL (open_history le passe) et, plus surement encore, de
// la reponse get-played-moves : c'est le match lui-meme qui le declare. Pas
// de repli sur 'classic-chess' -- ecrire [JoclyGame "classic-chess"] dans le
// PJN d'une partie de chu-shogi produit un fichier qui refuse de se recharger,
// ce qui est pire qu'un bouton momentanement inactif.
let gameName = new URLSearchParams(window.location.search).get('game') || null;
const matchId  = parseInt(new URLSearchParams(window.location.search).get('id') || '0', 10);

let currentIndex = -1;
let moveCount    = 0;
let moveStrings  = [];  // liste de chaines de coups (ex. ["e4", "e5", ...])
// Position de depart quand elle n'est PAS la position standard du jeu
// (probleme, finale) : ecrite en tag [FEN] a la sauvegarde.
let initialBoard = null;
// Qui a joue et resultat, rapportes par play.js : tags [White]/[Black]/[Result].
let white = null, black = null, result = null;
// Le camp, et non la couleur : au go PLAYER_A joue les pierres NOIRES, alors
// que `white` ci-dessus porte son libelle -- un heritage des echecs. L'export
// SGF nomme des couleurs reelles et se sert de ceux-ci.
let playerA = null, playerB = null;
// Renseignes par le go seul (voir getBoardState('score') dans play.js).
let komi = null, rules = null, margin = null;
// Probleme de mat, rapporte par play.js : marque a la sauvegarde.
let tsume = false;

function btn(action) {
    return document.querySelector('.toolbar-actions button[data-action=' + action + ']');
}

function UpdateButtons() {
    const dis = (action, enabled) => {
        const b = btn(action);
        if (b) b.classList.toggle('disabled', !enabled);
    };
    const vis = (action, visible) => {
        const b = btn(action);
        if (b) b.style.display = visible ? '' : 'none';
    };
    dis('start',       currentIndex >= 0);
    dis('stepback',    currentIndex >= 0);
    dis('stepforward', currentIndex < moveCount - 1);
    dis('end',         currentIndex < moveCount - 1);
    // Jouer/Pause : comme dans JoclyBoard, un seul des deux est VISIBLE, et
    // "Jouer" est DESACTIVE quand il n'y a plus rien a derouler.
    vis('play',  !playing);
    vis('pause',  playing);
    dis('play',  currentIndex < moveCount - 1);
    dis('resume', true);
}

function SelectMove(index) {
    document.querySelectorAll('#moves .move').forEach(el => el.classList.remove('active'));
    const el = document.querySelector('#moves .move[data-index="' + index + '"]');
    if (el) { el.classList.add('active'); el.scrollIntoView({ block: 'nearest' }); }
    currentIndex = Math.max(-1, Math.min(index, moveCount - 1));
    UpdateButtons();
}

function UpdateHistory(data) {
    const moves = data.moves || [];
    if (data.gameName) gameName = data.gameName;
    initialBoard = data.initialBoard || null;
    white  = data.white  || null;
    black  = data.black  || null;
    result = data.result || null;
    playerA = data.playerA || null;
    playerB = data.playerB || null;
    komi   = data.komi == null ? null : data.komi;
    rules  = data.rules || null;
    margin = data.margin == null ? null : data.margin;
    tsume  = !!data.tsume;
    moveStrings = moves.map(m => typeof m === 'string' ? m : (m.toString ? m.toString() : JSON.stringify(m)));
    moveCount   = moveStrings.length;

    const movesElem = document.getElementById('moves');
    movesElem.innerHTML = '';
    moveStrings.forEach((moveStr, index) => {
        if (index % 2 === 0) {
            const num = document.createElement('span');
            num.className   = 'movenumber';
            num.textContent = (index / 2 + 1) + '.';
            movesElem.appendChild(num);
        }
        const span = document.createElement('span');
        span.className = 'move';
        span.setAttribute('data-index', index);
        span.textContent = moveStr;
        span.addEventListener('click', () => { AutoplayStop(); GoTo(index); });
        movesElem.appendChild(span);
    });

    SelectMove(moveCount - 1);
}

function RequestHistory() {
    emit('play-req:' + matchId + ':get-played-moves', null);
}

// "Save book" : exporte la partie en PJN. Le download `data:` URI d'Electron
// ne fait rien dans la WebView Tauri : dialogue natif + save_text_file (même
// correctif que le bouton Save de la fenêtre de jeu). Coups numérotés
// ("1. e2-e4 e7-e5 2. …") pour rester relisible par parse_pjn/pickMove.
// Demande a play.js la partie en notation occidentale. Elle se calcule en
// rejouant la partie, d'ou l'aller-retour plutot qu'un champ joint a chaque
// rafraichissement de l'Historique.
/**
 * Taille du goban d'un jeu de go, ou null si ce n'est pas un go.
 *
 * Lue dans le NOM du jeu ("go9", "go13", "go19") : l'Historique n'a pas le
 * plateau sous la main, seulement la liste des coups, et le nom est la seule
 * chose qui dise la taille. Un « go » sans chiffre n'existe pas au catalogue,
 * et un nom qui commence par go sans etre un goban -- s'il en apparaissait un
 * -- ne repondrait pas au motif.
 */
function GoBoardSize(name) {
    const m = /^go(9|13|19)$/.exec(String(name || ''));
    return m ? parseInt(m[1], 10) : null;
}

/**
 * Le resultat au format SGF : "B+3.5", "W+R", "0" pour un jigo.
 *
 * Tabulon note le resultat a la maniere du PGN ("1-0"), ou 1 est le joueur A
 * -- c'est-a-dire NOIR au go. L'ecart vient du comptage quand la partie est
 * allee jusqu'au bout ; sans lui on ecrit le camp seul, ce que le format
 * accepte, plutot que d'inventer un nombre.
 */
function SgfResult(pgn, gap) {
    if (!pgn || pgn === '*') return null;
    if (pgn === '1/2-1/2') return '0';
    const side = pgn === '1-0' ? 'B' : (pgn === '0-1' ? 'W' : null);
    if (!side) return null;
    return side + '+' + (gap ? Math.abs(gap) : '');
}

// Cette fenetre n'a pas de banniere : le titre porte le message le temps
// qu'il soit lu, puis reprend sa valeur.
function NoteInTitle(message) {
    console.warn('[history]', message);
    const previous = document.title;
    document.title = message;
    setTimeout(() => { document.title = previous; }, 6000);
}

function AskWesternMoves() {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 5000);
        listen(`play-rep:${matchId}:get-western-moves`, ({ payload }) => {
            clearTimeout(timer);
            resolve(payload);
        }).then(() => emit(`play-req:${matchId}:get-western-moves`, null));
    });
}

async function SavePJN() {
    // Sans le nom du jeu, le fichier serait ecrit avec un mauvais tag
    // [JoclyGame] et deviendrait irrechargeable : mieux vaut ne rien ecrire.
    if (!gameName) { console.warn('[history] save book : jeu inconnu, sauvegarde annulee'); return; }
    // Le FORMAT se choisit par l'extension, dans le dialogue natif : « .pjn »
    // pour le format de Tabulon, « .pgn » pour celui que ChuShogiLite relit.
    // Pas de case a cocher supplementaire — l'utilisateur nomme deja son
    // fichier, et le nom porte l'intention.
    // Nom propose SANS extension : c'est le dialogue natif qui ajoute celle du
    // filtre choisi, et qui la remplace quand on change de filtre. La figer
    // ici — « chu-shogi.pjn » — la laissait au contraire telle quelle quand on
    // passait a PGN, et il fallait la corriger a la main.
    //
    // Windows et macOS suivent le filtre ; certains gestionnaires de fichiers
    // Linux se contentent d'ajouter l'extension sans en retirer d'autre, d'ou
    // le controle ci-dessous qui se fie a ce que le chemin porte REELLEMENT,
    // et non au filtre qu'on croit avoir choisi.
    // Le SGF n'est propose QUE pour le go : c'est le format de ce jeu-la et
    // d'aucun autre, et l'offrir ailleurs promettrait un fichier qu'on ne
    // saurait pas ecrire. Il passe en tete pour le go, ou c'est ce que le
    // destinataire attend -- un PJN de go ne se relit que dans Tabulon.
    const goSize = GoBoardSize(gameName);
    const filters = [
        { name: 'PJN (Jocly)', extensions: ['pjn'] },
        { name: 'PGN', extensions: ['pgn'] },
    ];
    if (goSize) filters.unshift({ name: 'SGF (Go)', extensions: ['sgf'] });

    const path = await saveDialog({ defaultPath: gameName, filters }).catch(() => null);
    if (!path) return;

    const event = path.replace(/^.*[/\\]/, '').replace(/\.[^.]*$/, '');

    if (/\.sgf$/i.test(path)) {
        // Comme pour le PGN, c'est l'extension ECRITE qui decide et non le
        // filtre : quelqu'un peut taper « partie.sgf » sous le filtre PJN.
        if (!goSize) { NoteInTitle(t('history.noSgf')); return; }
        const sgf = BuildSGF(moveStrings, goSize, {
            komi, rules,
            application: 'Tabulon',
            event,
            // PB est le joueur A -- c'est lui qui pose les pierres noires.
            playerA, playerB,
            date: new Date().toISOString().slice(0, 10),
            result: SgfResult(result, margin),
        });
        // BuildSGF rend null sur un jeton qu'il ne sait pas ecrire. Ecrire un
        // fichier tronque sous l'extension .sgf serait pire que de refuser :
        // il s'ouvrirait, et montrerait une autre partie.
        if (!sgf) { console.warn('[history] SGF : coup non convertible'); NoteInTitle(t('history.noSgf')); return; }
        await tRpc.call('save_text_file', path, sgf)
            .catch(e => console.warn('[history] save book (sgf) failed:', e));
        return;
    }
    if (/\.pgn$/i.test(path)) {
        // C'est l'extension ECRITE qui decide, pas le filtre : l'utilisateur
        // peut taper « partie.pgn » sous le filtre PJN, et c'est son nom qui
        // dit ce qu'il attend.
        // La notation occidentale demande le moteur : seul play.js peut la
        // produire. S'il ne sait pas — jeu sans SFEN, coup non traduisible —
        // on le dit et on n'ecrit rien, plutot que de livrer sous l'extension
        // .pgn un fichier que le destinataire ne relira pas.
        const data = await AskWesternMoves();
        if (!data || !data.moves || data.moves.some(mv => !mv || mv === '?')) {
            // Ecrire sous l'extension .pgn un fichier que le destinataire ne
            // relira pas serait pire que de refuser.
            console.warn('[history]', t('history.noPgn'));
            // Pas de banniere dans cette fenetre : le titre de la fenetre
            // porte le message le temps qu'il soit lu, puis reprend sa valeur.
            NoteInTitle(t('history.noPgn'));
            return;
        }
        /*
         * LA BALISE [Variant], et c'est elle qui decide si le fichier sera
         * relisible ailleurs.
         *
         * Le nom Jocly n'a de sens que pour Tabulon : « horde-chess » la ou un
         * lecteur attend « horde ». play.js repond desormais avec le nom que
         * declare le niveau Expert du jeu -- celui de Fairy-Stockfish -- et
         * c'est celui-la qu'on ecrit.
         *
         * Faute de mieux on garde le nom Jocly et on le DIT : le fichier reste
         * juste, ses coups sont bons, il faudra seulement corriger la balise a
         * la main pour l'ouvrir ailleurs. Le refuser priverait d'export des
         * parties qui n'ont rien de fautif.
         */
        const variant = gameName === 'chu-shogi' ? 'chu' : (data.variant || gameName);
        if (!data.variant && gameName !== 'chu-shogi')
            NoteInTitle(t('history.pgnVariant', { variant }));
        const pgn = BuildPGN(data.moves, data.sfen, {
            event, white, black, result, tsume, variant,
        });
        await tRpc.call('save_text_file', path, pgn)
            .catch(e => console.warn('[history] save book (pgn) failed:', e));
        return;
    }

    // Tags d'identification. Trois choix assumes :
    //  - [Event] = le nom que l'utilisateur vient de donner au fichier. C'est
    //    la seule chose ici qui nomme la partie, et l'inscrire DANS le fichier
    //    la fait survivre a un renommage ou a une copie.
    //  - [White]/[Black] seulement si un cote n'est PAS humain : "Human vs
    //    Human" n'apprend rien et masquerait [Event] au reaffichage, alors
    //    que "Human vs Computer (Easy)" est une vraie information.
    //  - [Result] seulement si la partie est terminee ; sinon rien, ce que
    //    PGN note "*" par defaut.
    const human = t('common.human');
    const named = (white || black) && !(white === human && black === human);
    const text  = BuildPJN(gameName, moveStrings, initialBoard, null, {
        event,
        white:  named ? white : null,
        black:  named ? black : null,
        result,
        tsume,
    });
    await tRpc.call('save_text_file', path, text)
        .catch(e => console.warn('[history] save book failed:', e));
}

// Lecture automatique. Les boutons Jouer/Pause du HTML n'avaient AUCUN
// gestionnaire : ils ne faisaient rien. On rejoue les coups un par un en
// reutilisant exactement le meme chemin que "coup suivant".
let playing = false;
let autoplayTimer = null;
let stepAck = null;
const AUTOPLAY_MS  = 900;   // respiration entre deux coups
const STEP_TIMEOUT = 4000;  // filet si play.html ne repond pas

function GoTo(index) {
    const idx = Math.max(-1, Math.min(moveCount - 1, index));
    SelectMove(idx);
    emit('play-req:' + matchId + ':rollback-to', { index: idx + 1 });
    return idx;
}

function AutoplayStop() {
    playing = false;
    if (autoplayTimer) { clearTimeout(autoplayTimer); autoplayTimer = null; }
    stepAck = null;
    UpdateButtons();
}

// Attend que play.html ait REELLEMENT applique le coup avant d'enchainer --
// equivalent du chainage sur la promesse de freeze() dans JoclyBoard. Un
// intervalle fixe empilerait les demandes si un coup est lent a redessiner.
function WaitStep() {
    return new Promise((resolve) => {
        const done = () => { stepAck = null; clearTimeout(guard); resolve(); };
        const guard = setTimeout(done, STEP_TIMEOUT);
        stepAck = done;
    });
}

async function AutoplayStart() {
    if (playing) return;
    playing = true;
    UpdateButtons();
    while (playing && currentIndex < moveCount - 1) {
        GoTo(currentIndex + 1);
        await WaitStep();
        if (!playing) break;
        await new Promise((r) => { autoplayTimer = setTimeout(r, AUTOPLAY_MS); });
    }
    AutoplayStop();
}

document.addEventListener('DOMContentLoaded', async () => {
    await initI18n();
    await twu.init(t('history.title', { id: matchId }));

    // Recevoir la reponse de play.html
    listen('play-rep:' + matchId + ':get-played-moves', ({ payload }) => {
        UpdateHistory(payload);
        twu.ready();
    });

    // Accuse de reception d'un rollback : debloque l'etape de lecture auto.
    listen('play-rep:' + matchId + ':rollback-to', () => { if (stepAck) stepAck(); });

    // Rafraichir quand play.html signale un nouveau coup
    listen('play-event:' + matchId + ':move-played', () => { AutoplayStop(); RequestHistory(); });

    btn('start')?.addEventListener('click',       () => { AutoplayStop(); GoTo(-1); });
    btn('stepback')?.addEventListener('click',    () => { AutoplayStop(); GoTo(currentIndex - 1); });
    btn('stepforward')?.addEventListener('click', () => { AutoplayStop(); GoTo(currentIndex + 1); });
    btn('end')?.addEventListener('click',         () => { AutoplayStop(); GoTo(moveCount - 1); });
    btn('play')?.addEventListener('click',        () => AutoplayStart());
    btn('pause')?.addEventListener('click',       () => AutoplayStop());
    btn('resume')?.addEventListener('click', () => {
        // Reprendre la partie depuis le coup selectionne
        emit('play-req:' + matchId + ':rollback-to', { index: currentIndex + 1 });
    });
    btn('save')?.addEventListener('click',  () => SavePJN());
    // "Load board state" : ouvre la fenêtre de saisie d'un état (open-position)
    btn('position')?.addEventListener('click', () =>
        gameName && tRpc.call('open_position', gameName, Number(matchId)));
    // "Display board state" : ouvre show-position, qui interroge play.js
    btn('showpos')?.addEventListener('click', () =>
        gameName && tRpc.call('open_show_position', gameName, Number(matchId)));

    document.getElementById('button-close')?.addEventListener('click', () => tRpc.close());

    RequestHistory();
});
