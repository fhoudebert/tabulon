// app/content/history.js
// Fenetre satellite : historique des coups joues.
// Affiche les coups, permet de naviguer (rollback) dans la partie.
// Communique avec play.html via Tauri events (play-req/play-rep:{matchId}:*).

import tRpc from './tabulon-rpc.js';
import twu  from './tabulon-winutils.js';
import { BuildPJN } from './book-format.js';
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
async function SavePJN() {
    // Sans le nom du jeu, le fichier serait ecrit avec un mauvais tag
    // [JoclyGame] et deviendrait irrechargeable : mieux vaut ne rien ecrire.
    if (!gameName) { console.warn('[history] save book : jeu inconnu, sauvegarde annulee'); return; }
    const path = await saveDialog({
        defaultPath: gameName + '.pjn',
        filters: [{ name: 'PJN', extensions: ['pjn', 'pgn'] }],
    }).catch(() => null);
    if (!path) return;

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
        event:  path.replace(/^.*[/\\]/, '').replace(/\.[^.]*$/, ''),
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
