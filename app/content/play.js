// app/content/play.js -- Fenetre de jeu Tabulon
//
// Jocly tourne dans un iframe (attachElement -> mode proxy). Dans ce mode :
//   - userTurn() joue le coup en interne, retourne {move, finished, winner}
//     -> pas besoin de playMove() apres
//   - machineSearch() cherche mais NE JOUE PAS le coup, retourne {move, ...}
//     -> il faut appeler playMove(result.move) apres (comme control.js)
//   - Si result.move est undefined (niveau IA non supporte pour ce jeu/position),
//     on logge un warning et on reboucle en humain plutot que boucler infiniment.

import tRpc from './tabulon-rpc.js';
import twu  from './tabulon-winutils.js';
import { Store, listen, emit, save as saveDialog } from './tauri-bridge.js';
import { initI18n, t, translateLevelLabel } from './tabulon-i18n.js';
import { installNativeEngine } from './engine-native.js';
import { ReplayBookMoves, MoveFormat, FlipSfenTurn, PgnFenToJocly, PgnFenToShogiSfen, VariantFen,
         
         ParseWesternMove, ParseNaturalMove, WesternMatches, BuildWesternMove,
         ParseWxfMove, WxfMatches, ParseSanMove, SanMatches, BuildSanMove } from './book-format.js';
import { HttpRelayChannel } from './remote-channel.js';
import { PeerChannel } from './remote-peer-channel.js';
import { DEFAULT_RELAY_URL } from './remote-relay-protocol.js';

// -- Parametres d'URL ---------------------------------------------------------
const gameName = new URLSearchParams(window.location.search).get('game') || 'classic-chess';
const matchId  = parseInt(new URLSearchParams(window.location.search).get('id') || '0', 10);
const viewOptionsFromUrl = (() => {
    try {
        const raw = new URLSearchParams(window.location.search).get('options');
        return raw ? JSON.parse(decodeURIComponent(raw)) : null;
    } catch { return null; }
})();
// Config horloge transmise par clock-setup.js via new_match(gameName, clock)
const clockConfig = (() => {
    try {
        const raw = new URLSearchParams(window.location.search).get('clock');
        return raw ? JSON.parse(decodeURIComponent(raw)) : null;
    } catch { return null; }
})();
// La sauvegarde de la partie, telle que Tabulon la transmet ou l'ecrit.
//
// joclyMatch.save() rend ce que jocly sait de la partie : les coups et la
// position de depart. Il ne sait rien du mode tsume, qui est une OPTION passee
// a load() et non un fait du plateau -- une position sans roi ne dit pas si
// elle est un probleme ou une erreur. Le drapeau est donc ajoute ici, a cote
// des coups, pour que la partie rechargee retrouve le mode dans lequel elle a
// ete jouee ; sans lui, rouvrir un tsume enregistre donne un plateau fige.
//
// Absent quand il est faux, plutot qu'ecrit `false` : une sauvegarde ordinaire
// garde exactement la forme qu'elle avait, et un fichier deja enregistre se
// relit sans rien de nouveau a interpreter.
async function SaveMatch() {
    const saved = await joclyMatch.save().catch(() => null);
    if (saved && tsumeMatch) saved.tsume = true;
    return saved;
}

// Position de tsume : retenu pour toute la partie, parce que CHAQUE
// rechargement doit reposer l'option -- la navigation dans l'historique
// recharge la position de depart avant de rejouer jusqu'au coup voulu.
let tsumeMatch = false;

// ID de la partie dont on fork la position (store key "fork:{forkId}")
const forkId = new URLSearchParams(window.location.search).get('fork') || null;
// ID de l'invitation à rejoindre (store key "invite:{inviteId}"), déposée par
// invitation.js juste avant new_match -- voir DEVELOPMENT.md § Remote play.
const inviteId = new URLSearchParams(window.location.search).get('invite') || null;

// -- Horloge --------------------------------------------------------------------
// Modèle JoclyBoard (joc/app/joclyboard.js) : l'état de l'horloge vit ici,
// la fenêtre clock.html ne fait que l'afficher. Sans clocked play, on tient
// quand même une horloge countup (temps de réflexion cumulé par joueur),
// comme l'original. turn/t0 sont posés au fil de la partie par ClockTurn().
let clock         = clockConfig ? { ...clockConfig } : { mode: 'countup', 1: 0, '-1': 0 };
let originalClock = { ...clock };

function ClockPayload() {
    return {
        players: {
            1:    { name: t('common.playerA') },   // Jocly.PLAYER_A
            '-1': { name: t('common.playerB') },   // Jocly.PLAYER_B
        },
        clock,
    };
}

function EmitClock() {
    emit(`play-event:${matchId}:update-clock`, ClockPayload()).catch(() => {});
}

// Changement de tour : débite le temps écoulé du joueur qui vient de jouer
// (+ bonus xtrasec / moves-per-session en countdown), puis démarre le temps
// du nouveau joueur. Portage fidèle de joclyboard.js::nextMove().
async function ClockTurn(turn) {
    if (!clock || clock.turn === turn) return;
    const now = Date.now();
    const otherTurn = -turn;   // PLAYER_A=1 / PLAYER_B=-1
    if (clock.turn === otherTurn) {
        if (clock.mode === 'countdown') {
            clock[otherTurn] -= now - clock.t0;
            if (clock['xtrasec_' + otherTurn] || clock['mps_' + otherTurn]) {
                const nMoves = (await joclyMatch?.getPlayedMoves().catch(() => []))?.length || 0;
                if (clock['xtrasec_' + otherTurn] && nMoves > 0 &&
                    clock['last_xtrasec_' + otherTurn] !== nMoves) {
                    clock[otherTurn] += clock['xtrasec_' + otherTurn] * 1000;
                    clock['last_xtrasec_' + otherTurn] = nMoves;
                }
                if (clock['mps_' + otherTurn] && nMoves > 1 &&
                    Math.floor(nMoves / 2) % clock['mps_' + otherTurn] === 0 &&
                    clock['last_mps_' + otherTurn] !== nMoves) {
                    clock[otherTurn] += originalClock[otherTurn];
                    clock['last_mps_' + otherTurn] = nMoves;
                }
            }
        } else {
            clock[otherTurn] += now - clock.t0;
        }
    }
    clock.t0 = now;
    clock.turn = turn;
    EmitClock();
}

// Fin de partie : solde le temps du joueur courant et arrête l'horloge.
function ClockStop() {
    if (!clock || !clock.turn) return;
    const now = Date.now();
    if (clock.mode === 'countdown') clock[clock.turn] -= now - clock.t0;
    else                            clock[clock.turn] += now - clock.t0;
    delete clock.turn;
    EmitClock();
}

// -- Etat ---------------------------------------------------------------------
let joclyMatch   = null;
let store        = null;
let loopActive   = false;
let paused       = false;
let levels       = [];

// Joueurs : null = humain local, objet level Jocly = IA,
// {remote:true, matchId, relayUrl} = adversaire distant via relai HTTP, ou
// {remote:true, peer:true, matchId} = adversaire distant en pair-a-pair
// (session TCP cote Rust, etablie par la fenetre Invitation -- voir
// remote-peer-channel.js).
// Un seul cote peut etre "remote" a la fois : l'autre est necessairement
// humain local (c'est "moi" qui joue cette partie).
const players = {};

// -- Jeu a distance -------------------------------------------------------------
// Un seul HttpRelayChannel actif a la fois pour ce match. gameLoop() attend
// le prochain coup adverse via waitForRemoteMove() ; le callback du canal
// (onRemoteMove) resout l'attente en cours, ou bufferise le coup si gameLoop
// n'a pas encore atteint le tour distant (cas normal : le polling peut
// detecter le coup un peu avant que la boucle ne l'attende explicitement).
let remoteChannel      = null;
let remoteChannelKey   = null;   // Jocly.PLAYER_A/B associe au canal actif
let remoteMoveBuffer   = null;   // {nbTurns, lastMove} recu avant d'etre attendu
let remoteMoveWaiters  = [];     // [{expectedNbTurns, resolve, reject}]

function onRemoteMoveReceived(payload) {
    remoteMoveBuffer = payload;
    remoteMoveWaiters = remoteMoveWaiters.filter(w => {
        if (payload.nbTurns !== w.expectedNbTurns) return true;
        remoteMoveBuffer = null;
        w.resolve(payload.lastMove);
        return false;
    });
}

function waitForRemoteMove(expectedNbTurns) {
    if (remoteMoveBuffer && remoteMoveBuffer.nbTurns === expectedNbTurns) {
        const move = remoteMoveBuffer.lastMove;
        remoteMoveBuffer = null;
        return Promise.resolve(move);
    }
    return new Promise((resolve, reject) => {
        remoteMoveWaiters.push({ expectedNbTurns, resolve, reject });
    });
}

// A appeler partout ou l'on annule le tour courant (pause, reconfiguration
// des joueurs, restart, takeback) -- meme role que abortUserTurn()/
// abortMachineSearch() pour le cas "j'attends un coup distant".
function cancelRemoteWait(reason) {
    const waiters = remoteMoveWaiters;
    remoteMoveWaiters = [];
    waiters.forEach(w => w.reject(new Error(reason)));
}

// Cree (ou reutilise) le canal pour la configuration donnee, et l'associe a
// playerKey (le cote distant). Si un canal existe deja pour une autre partie
// (matchId different) ou un autre cote, il est arrete proprement d'abord.
// currentNbTurns : nombre de coups deja joues localement au moment de la
// creation (baseline correcte pour une partie deja entamee -- fork, reprise
// apres fermeture de la fenetre...) ; ignore si le canal existe deja.
function ensureRemoteChannel(playerKey, { matchId: remoteMatchId, relayUrl, codec, gameName: remoteGameName, peer }, currentNbTurns) {
    if (remoteChannel && remoteChannel.matchId === remoteMatchId && remoteChannelKey === playerKey)
        return remoteChannel;
    disposeRemoteChannel();
    if (peer) {
        // Pair-a-pair : la session TCP existe deja cote Rust (etablie par la
        // fenetre Invitation avant new_match) -- le canal ne fait que s'y
        // attacher. Meme interface RemoteChannel, gameLoop ne voit aucune
        // difference avec le relai HTTP.
        const chan = new PeerChannel({ matchId: remoteMatchId, localNbTurns: currentNbTurns });
        chan.onStatusChange(({ connected, error }) => {
            if (!connected) {
                console.warn('[play] session pair-a-pair terminee', error || '');
                UpdateFooter(t('play.peerDisconnected'));
            }
        });
        remoteChannel = chan;
    } else {
        remoteChannel = new HttpRelayChannel({
            relayUrl, matchId: remoteMatchId, localNbTurns: currentNbTurns,
            codec: codec || 'tabulon', gameName: remoteGameName || gameName,
        });
    }
    remoteChannelKey = playerKey;
    remoteChannel.onRemoteMove(onRemoteMoveReceived);
    remoteChannel.start();
    return remoteChannel;
}

function disposeRemoteChannel() {
    remoteChannel?.stop();
    remoteChannel = null;
    remoteChannelKey = null;
    remoteMoveBuffer = null;
    cancelRemoteWait('remote channel disposed');
}

// Configure players[key] comme distant ET active le canal tout de suite,
// plutot que d'attendre que gameLoop() atteigne le tour de ce cote (ce que
// faisait ensureRemoteChannel seule, appelee uniquement depuis la branche
// "tour distant"). BUG corrige par cette fonction : quand on heberge une
// partie (Invitation > Create) et qu'on joue le premier coup localement, ce
// premier coup se jouait AVANT que gameLoop() n'ait jamais atteint le tour
// distant -- le canal n'existait donc pas encore, et le coup n'etait jamais
// pousse au relai (rien a lire pour l'autre joueur -- voir README § Remote
// play). En l'activant ici, des la configuration, le canal existe qu'importe
// qui joue en premier.
async function activateRemoteSide(key, conf) {
    players[key] = conf;
    const moves = await joclyMatch.getPlayedMoves().catch(() => []);
    ensureRemoteChannel(key, conf, moves.length);
    syncFooterSelect(key);
}

// A appeler apres toute action qui change la position locale SANS passer par
// gameLoop (takeback, restart, rollback-to, chargement d'un fichier/etat) :
// recale la baseline du canal actif sur le nombre de coups reellement joue
// localement maintenant, pour eviter un faux positif ou un coup manque au
// prochain poll. Ne resout PAS la desynchronisation avec le relai lui-meme
// (voir DEVELOPMENT.md § Remote play, limite connue) -- juste notre bookkeeping.
async function resyncRemoteChannelBaseline() {
    if (!remoteChannel) return;
    remoteMoveBuffer = null;
    const moves = await joclyMatch.getPlayedMoves().catch(() => []);
    remoteChannel.resetBaseline(moves.length);
}

// players[key] (interne) <-> descripteur echange avec players.js (satellite)
function describePlayer(value) {
    if (!value) return { type: 'human' };
    if (value.remote) return {
        type: 'remote', matchId: value.matchId, relayUrl: value.relayUrl,
        codec: value.codec || 'tabulon', gameName: value.gameName || null,
        peer: !!value.peer,
    };
    return { type: 'ai', levelIndex: levels.indexOf(value) };
}

function buildPlayerValue(info) {
    if (!info) return null;
    if (info.type === 'remote' && info.peer && info.matchId)
        return {
            remote: true, peer: true, matchId: String(info.matchId),
            gameName: info.gameName || gameName,
        };
    if (info.type === 'remote' && info.matchId && info.relayUrl)
        return {
            remote: true, matchId: String(info.matchId), relayUrl: String(info.relayUrl),
            codec: info.codec === 'jocly-simple-match' ? 'jocly-simple-match' : 'tabulon',
            gameName: info.gameName || gameName,
        };
    if (info.type === 'ai' && levels[info.levelIndex]) return levels[info.levelIndex];
    return null;
}

// Rearme le tour APRES un changement de position (recul, recommencement,
// chargement d'une partie ou d'une position).
//
// L'ORDRE EST ESSENTIEL. Ces handlers commencent par abortUserTurn() pour
// stopper ce qui est en cours ; gameLoop() attrape l'abandon et rappelle
// aussitot userTurn() -- donc HumanTurn() -- sur l'ANCIENNE position, en
// parallele du rollback qui suit. Or rollback() cote jocly redessine bien le
// plateau (BackTo + DisplayBoard) mais ne rearme RIEN : les elements
// cliquables construits pour la position precedente survivent. D'ou le
// symptome constate apres un take back (Ph3i4 sur rococo) : i4 restait
// selectionnable et h3 inerte, le plateau affichant pourtant la position
// reculee. examples/browser/control.html de jocly fait l'inverse et n'a pas
// le probleme : rollback(...) PUIS RunMatch().
//
// On rearme donc une fois la position stabilisee : abortUserTurn() fait
// reboucler gameLoop() sur la BONNE position ; si la boucle s'etait arretee
// (fin de partie -- loopActive=false), on la relance, sinon reculer apres
// avoir perdu laissait le plateau muet et « le joueur B gagne » a l'ecran.
// HumanTurn() n'est jamais appele directement : c'est de l'interne jocly,
// atteint via userTurn().
// Resultat de la partie ("1-0", "0-1", "1/2-1/2") des qu'elle est terminee,
// pour le tag [Result] a la sauvegarde. Remis a null a chaque changement de
// position : apres un recul dans l'historique la partie n'est plus finie, et
// ecrire un resultat serait faux.
let gameResult = null;

// Nom lisible d'un cote, pour les tags [White]/[Black] du PJN.
/**
 * Le camp au trait, nomme comme partout ailleurs dans Tabulon : « Joueur A »,
 * « Joueur B » -- la fenetre des joueurs, l'horloge, les options de vue et le
 * verdict de fin de partie emploient deja ces deux noms.
 *
 * PAS le libelle du niveau (« Humain », « Expert ») : il dit QUI calcule, pas
 * DE QUEL COTE, et deux niveaux identiques donnaient la meme phrase des deux
 * cotes. Le niveau reste utile pendant une recherche, ou il repond a une autre
 * question -- combien de temps cela va durer -- et il y est ajoute entre
 * parentheses plutot que substitue.
 */
function SideName(turn) {
    return t(turn > 0 ? 'common.playerA' : 'common.playerB');
}

function PlayerLabel(key) {
    const value = players[key];
    if (!value) return t('common.human');
    if (value.remote) return t('common.remote');
    return translateLevelLabel(value.label) || value.name || t('common.computer');
}

async function rearmAfterPositionChange() {
    gameResult = null;
    await joclyMatch?.abortUserTurn().catch(() => {});
    if (!loopActive) gameLoop();
}

// -- Boucle de jeu ------------------------------------------------------------
async function gameLoop() {
    loopActive = true;
    console.info('[play] gameLoop started');
    try {
        while (loopActive) {
            if (paused) {
                await new Promise(r => setTimeout(r, 200));
                continue;
            }

            const turn = await joclyMatch.getTurn();
            await ClockTurn(turn);
            const level = players[turn];   // null = humain, objet level = IA, {remote:true,...} = distant

            let finished     = false;
            let winner       = null;
            let playedLocally = false;   // false pour le tour "distant" (coup deja joue par l'adversaire)

            try {
                if (level?.remote) {
                    // Tour distant : personne localement pour jouer -- on
                    // attend le coup de l'adversaire via le relai, puis on
                    // l'applique. Comme pour l'IA (mode proxy iframe),
                    // playMove() est necessaire (le coup n'a pas ete joue ici).
                    const moves = await joclyMatch.getPlayedMoves().catch(() => []);
                    ensureRemoteChannel(turn, level, moves.length);
                    UpdateFooter(t('play.waitingRemote'));
                    const move = await waitForRemoteMove(moves.length + 1);
                    UpdateFooter('');
                    const playResult = await joclyMatch.playMove(move);
                    finished = playResult?.finished || false;
                    winner   = playResult?.winner;

                } else if (!level) {
                    // Tour humain.
                    // userTurn() joue le coup en interne (mode proxy iframe)
                    // et retourne {move, finished, winner} directement.
                    // Qui doit jouer, ecrit noir sur blanc : sur un plateau ou
                    // rien ne bouge entre deux coups -- un goban en
                    // particulier -- le seul indice est sinon la couleur du
                    // trait, que jocly n'affiche nulle part.
                    UpdateFooter(t(turn > 0 ? 'play.turnA' : 'play.turnB'));
                    const result = await joclyMatch.userTurn();
                    UpdateFooter('');
                    finished = result?.finished || false;
                    winner   = result?.winner;
                    playedLocally = true;

                } else {
                    // Tour IA.
                    // machineSearch() en mode proxy iframe retourne {move, ...}
                    // mais NE joue PAS le coup -- il faut appeler playMove().
                    // Le niveau nomme plutot que « Reflexion... » seul : une
                    // recherche KataGo dure des secondes, et la question du
                    // joueur pendant ce temps est de savoir QUI reflechit,
                    // pas que quelqu'un reflechit.
                    UpdateFooter(t(turn > 0 ? 'play.thinkingA' : 'play.thinkingB',
                        { level: PlayerLabel(turn) }));
                    const result = await joclyMatch.machineSearch({ level });
                    UpdateFooter('');

                    // Repli Fairy-Stockfish -> IA native : jocly pose
                    // result.fairyFallback quand un niveau "ai: fairy-stockfish"
                    // n'a pas pu demarrer son moteur (typiquement : page non
                    // cross-origin isolated, donc pas de SharedArrayBuffer).
                    // Sans ce bandeau le joueur croit affronter Expert alors
                    // qu'il joue contre l'IA native. jocly ne signale QUE le
                    // coup concerne, mais il replie a CHAQUE coup : on
                    // n'avertit donc qu'une fois par partie.
                    ShowFairyFallback(result?.fairyFallback);

                    if (!result?.move) {
                        // Le niveau demande n'est pas disponible pour ce jeu
                        // ou cette position (ex. expert fairy-stockfish sur un
                        // jeu non supporte, ou prelude pas encore resolu).
                        // On tombe en mode humain plutot que boucler sans fin.
                        console.warn('[play] machineSearch returned no move for level', level.name,
                            '-- falling back to human turn');
                        const r2 = await joclyMatch.userTurn();
                        finished = r2?.finished || false;
                        winner   = r2?.winner;
                        playedLocally = true;
                    } else {
                        const playResult = await joclyMatch.playMove(result.move);
                        finished = playResult?.finished || false;
                        winner   = playResult?.winner;
                        playedLocally = true;
                    }
                }
            } catch (e) {
                // abortUserTurn() / abortMachineSearch() / cancelRemoteWait() -> reboucler
                console.info('[play] turn aborted:', e.message);
                UpdateFooter('');
                continue;
            }

            // Si un coup vient d'etre joue localement (humain ou IA) et
            // qu'un adversaire distant existe (sur l'AUTRE cote), on le lui
            // transmet. On ne repousse jamais un coup qu'on vient de recevoir
            // de lui (playedLocally=false) -- inutile, il l'a deja.
            // state (joclyMatch.save()) est INDISPENSABLE en codec
            // jocly-simple-match (un vrai client control.js fait
            // match.load(matchdata), il n'y a pas d'equivalent playMove(un
            // seul coup) cote leur protocole) ; utile aussi en codec 'tabulon'
            // pour une resynchronisation complete si besoin plus tard.
            if (playedLocally && remoteChannel) {
                const moves = await joclyMatch.getPlayedMoves().catch(() => []);
                const state = await SaveMatch();
                remoteChannel.push({ nbTurns: moves.length, lastMove: moves[moves.length - 1] ?? null, state })
                    .catch(e => console.warn('[play] envoi du coup au relai distant échoué :', e.message || e));
            }

            if (finished) {
                ClockStop();
                gameResult = winner === 0 ? '1/2-1/2' : winner > 0 ? '1-0' : '0-1';
                const verdict = winner === 0 ? t('play.draw')
                    : winner > 0 ? t('play.aWins')
                    : t('play.bWins');
                const margin = await FinalMargin();
                UpdateFooter(margin ? `${verdict} : ${margin}` : verdict);
                loopActive = false;
            }
            // Notifier les satellites (history.js) qu'un coup a ete joue
            emit(`play-event:${matchId}:move-played`, null).catch(() => {});
        }
    } catch (e) {
        console.error('[play] gameLoop error:', e);
        UpdateFooter('');
    }
    console.info('[play] gameLoop ended');
}

/**
 * L'ecart final, pour les jeux qui le publient.
 *
 * « Le joueur A gagne » ne dit pas de combien, et au go c'est la moitie du
 * resultat : une partie se gagne de 0.5 comme de 60. jocly ne traduit rien --
 * la barre de statut du goban ne peut donc afficher qu'une pierre et un
 * nombre -- mais go-model.js publie les chiffres par getBoardState('score'),
 * le seul canal que jocly fasse deja traverser l'iframe. La phrase se compose
 * donc ICI, ou le dictionnaire existe.
 *
 * Les autres jeux repondent leur notation de plateau (une CHAINE) ou echouent :
 * dans les deux cas on affiche le verdict seul, comme avant.
 */
async function FinalMargin() {
    const state = await joclyMatch.getBoardState('score').catch(() => null);
    if (!state || typeof state !== 'object' || !state.counted) return null;
    const margin = Math.abs(state.margin);
    return margin > 0 ? margin : null;   // un jigo n'a pas d'ecart a annoncer
}

// -- Helpers UI ---------------------------------------------------------------
function UpdateFooter(text) {
    const el = document.getElementById('board-footer-text');
    if (el) el.textContent = text || '';
}

// ── Bandeau d'avertissement ───────────────────────────────────────────────────

function ShowWarning(text) {
    const bar = document.getElementById('play-warning');
    const el  = document.getElementById('play-warning-text');
    if (!bar || !el) { console.warn('[play]', text); return; }
    el.textContent = text;
    bar.classList.remove('hidden');
}

function HideWarning() {
    document.getElementById('play-warning')?.classList.add('hidden');
}

// Signale une seule fois par partie que le niveau demande a ete degrade.
// info = {engine, reason, level} pose par jocly (null si pas de repli).
// Champ absent d'un dist jocly anterieur au support de fairyFallback : dans
// ce cas info est undefined et rien ne s'affiche -- pas de regression.
let fairyFallbackWarned = false;
function ShowFairyFallback(info) {
    if (!info || fairyFallbackWarned) return;
    fairyFallbackWarned = true;
    let msg = t('play.fairyFallback', { level: translateLevelLabel(info.level) || '?' });
    // Le conseil "servir la page en cross-origin isolated" n'a de sens que
    // si l'environnement peut effectivement l'obtenir. Sous WebKitGTK le
    // schema tauri:// n'accorde pas l'isolation : inviter l'utilisateur a
    // corriger des en-tetes ne l'avancerait a rien.
    msg += ' ' + (typeof SharedArrayBuffer === 'function'
        ? t('play.fairyFallbackIsolate')
        : t('play.fairyFallbackUnsupported'));
    ShowWarning(msg);
}

function UpdatePause() {
    document.getElementById('button-pause').style.display  = paused ? 'none' : '';
    document.getElementById('button-resume').style.display = paused ? '' : 'none';
}

function UpdateFav(fav) {
    document.getElementById('button-favorite-no').style.display  = fav ? 'none' : '';
    document.getElementById('button-favorite-yes').style.display = fav ? '' : 'none';
}

function BuildPlayerSelect(selectId, playerKey) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    sel.innerHTML = '';

    const optHuman = document.createElement('option');
    optHuman.value = '';
    optHuman.textContent = t('common.human');
    sel.appendChild(optHuman);

    levels.forEach((lvl, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = translateLevelLabel(lvl.label) || lvl.name || t('common.level', { n: i + 1 });
        sel.appendChild(opt);
    });

    // "Joueur distant" : entree d'ETAT uniquement, jamais un choix. Le jeu
    // a distance ne se configure que par la fenetre Invitation (le libelle
    // "(via Invitation)" le dit dans la liste elle-meme) ; l'option est
    // desactivee, le navigateur empeche donc de la choisir -- mais
    // syncFooterSelect() peut toujours la poser programmatiquement pour
    // refleter un cote devenu distant par l'invitation.
    const optRemote = document.createElement('option');
    optRemote.value = 'remote';
    optRemote.disabled = true;
    optRemote.title = t('common.remoteViaInvitationTip');
    optRemote.textContent = t('common.remoteViaInvitation');
    sel.appendChild(optRemote);

    // Defaut : A = humain, B = premier niveau IA (si disponible)
    if (playerKey === Jocly.PLAYER_B && levels.length > 0) {
        players[playerKey] = levels[0];
        sel.value = '0';
    } else {
        players[playerKey] = null;
        sel.value = '';
    }

    sel.addEventListener('change', async () => {
        const v = sel.value;
        if (v === 'remote') {
            // Inatteignable en principe (option desactivee) -- garde
            // defensive : on se contente de re-refleter l'etat reel.
            syncFooterSelect(playerKey);
            return;
        }
        const wasRemote = !!players[playerKey]?.remote;
        players[playerKey] = v === '' ? null : levels[parseInt(v, 10)];
        updateRemoteRestrictedButtons();
        await joclyMatch?.abortUserTurn().catch(() => {});
        await joclyMatch?.abortMachineSearch().catch(() => {});
        cancelRemoteWait('players reconfigured (footer)');
        if (wasRemote && ![Jocly.PLAYER_A, Jocly.PLAYER_B].some(k => players[k]?.remote))
            disposeRemoteChannel();
    });
}

function hasRemoteSide() {
    return [Jocly.PLAYER_A, Jocly.PLAYER_B].some(k => players[k]?.remote);
}

// Reculer/recommencer face a un joueur DISTANT desynchronise la partie : le
// relai (fileio.php) comme le pair TCP n'ont aucune notion de retrait de
// coup -- c'etait la « limite connue » documentee depuis l'etape 3. On ferme
// la porte en amont : ces boutons sont GRISES tant qu'un cote est distant
// (l'infobulle explique pourquoi), et les handlers gardent une garde de
// fond. Ils redeviennent actifs des que plus aucun cote n'est distant
// (partie rapide, chronometree, locale...).
const REMOTE_RESTRICTED_BUTTONS = ['button-takeback', 'button-restart', 'quick-takeback', 'quick-restart'];

function updateRemoteRestrictedButtons() {
    const remote = hasRemoteSide();
    for (const id of REMOTE_RESTRICTED_BUTTONS) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.disabled = remote;
        const normalKey = el.getAttribute('data-i18n-title');
        el.title = remote ? t('play.remoteRestricted') : (normalKey ? t(normalKey) : el.title);
    }
}

// Bascule les deux camps en HUMAIN. Utilise a l'ouverture d'une partie ou
// d'une solution : par defaut le camp B est une IA, qui jouerait aussitot
// par-dessus les coups qu'on vient de charger -- et surtout des qu'on
// reviendrait en arriere dans la fenetre Historique pour naviguer.
function SetBothHuman() {
    for (const key of [Jocly.PLAYER_A, Jocly.PLAYER_B]) {
        players[key] = null;
        syncFooterSelect(key);
    }
}

// Aligne le select rapide du footer (select-player-a/-b) sur l'etat reel de
// players[key] -- humain (''), IA (index en string), ou distant ('remote').
// A appeler chaque fois que players[key] change ailleurs que par ce select
// lui-meme (invitation, fenetre Players). Met aussi a jour les boutons
// restreints en mode distant : ce point de passage est traverse par TOUS
// les chemins qui changent players (invitation, fenetre Players, footer).
function syncFooterSelect(key) {
    updateRemoteRestrictedButtons();
    const selId = key === Jocly.PLAYER_A ? 'select-player-a' : 'select-player-b';
    const sel = document.getElementById(selId);
    if (!sel) return;
    const value = players[key];
    sel.value = value?.remote ? 'remote' : value ? String(levels.indexOf(value)) : '';
}

// -- Communication avec les fenetres satellites --------------------------------
// Protocole simple via Tauri events :
//   satellite -> play.html : emit('play-req:{matchId}:{action}', payload)
//   play.html -> satellite : emit('play-rep:{matchId}:{action}', result)
function initSatelliteListeners() {
    const prefix = `play-req:${matchId}:`;

    // get-view-options : retourne viewOptions actuelles + config vue
    listen(prefix + 'get-view-options', async () => {
        if (!joclyMatch) return;
        const opts   = await joclyMatch.getViewOptions().catch(() => ({}));
        const cfg    = await joclyMatch.getConfig().catch(() => ({}));
        await emit(`play-rep:${matchId}:get-view-options`, { options: opts, config: cfg.view || {} });
    });

    // set-view-options : applique les options de vue
    listen(prefix + 'set-view-options', async ({ payload }) => {
        if (!joclyMatch) return;
        await joclyMatch.setViewOptions(payload || {}).catch(e => console.warn('[play] setViewOptions:', e));
        // RE-ARMER LE TOUR EN COURS. setViewOptions() reconstruit la vue
        // (GameDestroyView/GameInitView/DisplayBoard) mais ne rejoue PAS
        // HumanTurn() -- or c'est HumanTurn() qui dessine les indices de
        // coups possibles, avec la valeur de mShowMoves du moment. Sans ce
        // re-armement, decocher « montrer les coups » ne prend effet qu'au
        // tour SUIVANT : les indices deja affiches restent a l'ecran jusqu'a
        // ce qu'on joue (constate par l'utilisateur, puis reproduit au
        // navigateur : 10 cellules d'indice a l'opacite 1 avant, toujours 10
        // apres setViewOptions seul, 0 apres re-armement).
        // abortUserTurn() fait rejeter le userTurn() en attente : gameLoop
        // attrape, `continue`, et rappelle userTurn() -- donc HumanTurn()
        // avec les nouvelles options. C'est exactement ce que fait
        // examples/browser/control.html de jocly (RunMatch() juste apres
        // setViewOptions()). Sans tour utilisateur en cours (IA en reflexion,
        // attente d'un coup distant, partie finie), l'appel est sans effet :
        // on ne touche NI a la recherche de l'IA NI a l'attente distante,
        // pour ne rien relancer inutilement.
        await joclyMatch.abortUserTurn().catch(() => {});
        // Persister dans le store pour la prochaine ouverture
        store?.set('view-options:' + gameName, payload || {});
        // Synchroniser le sélecteur de skin du footer et la garde capture 2D/3D
        const sel = document.getElementById('select-skin');
        if (sel && payload?.skin) sel.value = payload.skin;
        if (payload?.skin) UpdateCaptureButtons(payload.skin);
    });

    // get-players : retourne les joueurs actuels + niveaux disponibles
    listen(prefix + 'get-players', async () => {
        if (!joclyMatch) return;
        const cfg = await joclyMatch.getConfig().catch(() => ({}));
        await emit(`play-rep:${matchId}:get-players`, {
            levels:  cfg.model?.levels || [],
            players: {
                [Jocly.PLAYER_A]: describePlayer(players[Jocly.PLAYER_A]),
                [Jocly.PLAYER_B]: describePlayer(players[Jocly.PLAYER_B]),
            },
        });
    });

    // set-players : change les types de joueurs
    // payload : { [PLAYER_A]: {type:'human'} | {type:'ai',levelIndex:N} |
    //             {type:'remote',matchId,relayUrl}, ... }
    listen(prefix + 'set-players', async ({ payload }) => {
        if (!joclyMatch || !payload) return;
        const abort = async () => {
            await joclyMatch.abortUserTurn().catch(() => {});
            await joclyMatch.abortMachineSearch().catch(() => {});
            cancelRemoteWait('players reconfigured');
        };
        let changed = false;
        for (const [playerKey, info] of Object.entries(payload)) {
            const key = parseInt(playerKey, 10);
            const newValue = buildPlayerValue(info);
            if (JSON.stringify(players[key]) !== JSON.stringify(newValue)) {
                if (newValue?.remote) {
                    await activateRemoteSide(key, newValue);   // cree le canal tout de suite
                } else {
                    players[key] = newValue;
                }
                changed = true;
            }
        }
        if (changed) {
            await abort();
            // Plus aucun cote distant configure -> on arrete le canal tout de
            // suite (sinon gameLoop en (re)cree/reutilise un au bon moment,
            // via ensureRemoteChannel, quand c'est le tour du cote distant).
            const stillRemote = [Jocly.PLAYER_A, Jocly.PLAYER_B].some(k => players[k]?.remote);
            if (!stillRemote) disposeRemoteChannel();
        }
        // Mettre a jour les selects rapides du footer (humain/IA/distant)
        [Jocly.PLAYER_A, Jocly.PLAYER_B].forEach(key => syncFooterSelect(key));
    });

    // Ce que la fenetre Historique ecrit dans les tags du PJN a la
    // sauvegarde : qui a joue, et le resultat s'il y en a un. Sans ca elle
    // n'avait rien a mettre dans [White]/[Black] et les fichiers relus
    // s'affichaient "? vs ?".
    const HistoryMeta = () => ({
        tsume:  tsumeMatch,
        white:  PlayerLabel(Jocly.PLAYER_A),
        black:  PlayerLabel(Jocly.PLAYER_B),
        result: gameResult,
    });

    // get-played-moves : retourne l'historique des coups comme strings lisibles
    listen(prefix + 'get-played-moves', async () => {
        if (!joclyMatch) return;
        const moves = await joclyMatch.getPlayedMoves().catch(() => []);
        if (!moves || moves.length === 0) {
            await emit(`play-rep:${matchId}:get-played-moves`, { moves: [], gameName, ...HistoryMeta() });
            return;
        }
        // getMoveString accepte un array et retourne un array de strings
        // en une seule transaction avec l'iframe -- plus fiable que n appels
        // séquentiels où la sérialisation JSON des objets move peut les corrompre.
        const strings = await joclyMatch.getMoveString(moves).catch(() => null);
        // initialBoard : position de DEPART de la partie (null si c'est la
        // position standard). La fenetre Historique en a besoin pour ecrire
        // un tag [FEN] a la sauvegarde, sans quoi une partie partie d'un
        // probleme se rechargerait depuis la position initiale du jeu.
        const saved = await SaveMatch();
        await emit(`play-rep:${matchId}:get-played-moves`, {
            moves: Array.isArray(strings) ? strings : moves.map(() => '?'),
            initialBoard: saved?.initialBoard || null,
            // Le jeu, pour que la fenetre Historique ecrive le bon tag
            // [JoclyGame] a la sauvegarde. Elle le lit AUSSI dans son URL,
            // mais cette reponse-ci fait autorite : elle vient du match.
            gameName,
            ...HistoryMeta(),
        });
    });

    // get-western-moves : la partie en notation occidentale, pour l'export PGN
    // de la fenetre Historique. Calcule A LA DEMANDE — il faut rejouer la
    // partie — et non joint a chaque reponse get-played-moves.
    listen(prefix + 'get-western-moves', async () => {
        if (!joclyMatch) return;
        let data = null;
        try { data = await WesternGame(); }
        catch (e) { console.warn('[play] export occidental:', e.message || e); }
        await emit(`play-rep:${matchId}:get-western-moves`, data || { moves: null, sfen: null });
    });

    // rollback-to : annuler jusqu'a l'index demande
    listen(prefix + 'rollback-to', async ({ payload }) => {
        if (!joclyMatch) return;
        await joclyMatch.abortUserTurn().catch(() => {});
        await joclyMatch.abortMachineSearch().catch(() => {});
        cancelRemoteWait('rollback');
        await joclyMatch.rollback(payload?.index ?? 0).catch(e => console.warn('[play] rollback:', e));
        await resyncRemoteChannelBaseline();
        // Accuse de reception : la fenetre Historique enchaine sa lecture
        // automatique SUR CET EVENEMENT, et non sur un minuteur fixe, pour ne
        // pas empiler les demandes quand un coup est lent a redessiner.
        emit(`play-rep:${matchId}:rollback-to`, { index: payload?.index ?? 0 }).catch(() => {});
    });

    // get-template-data : données complètes pour "Save template"
    // (save-template.html les transmet ensuite à la commande Rust save_template)
    listen(prefix + 'get-template-data', async () => {
        if (!joclyMatch) return;
        const gameData = await SaveMatch();
        await emit(`play-rep:${matchId}:get-template-data`, {
            gameName,
            gameData,
            clock: clockConfig || null,
        });
    });

    // get-board-state : état du plateau (FEN ou équivalent Jocly) pour la
    // fenêtre show-position ("Display board state" de la fenêtre History)
    listen(prefix + 'get-board-state', async () => {
        if (!joclyMatch) return;
        const state = await joclyMatch.getBoardState().catch(() => null);
        await emit(`play-rep:${matchId}:get-board-state`, { state });
    });

    // load-board-state : recharge la partie depuis un état saisi dans la
    // fenêtre open-position (équivalent joclyboard::loadBoardState avec match)
    listen(prefix + 'load-board-state', async ({ payload }) => {
        if (!joclyMatch || !payload?.state) return;
        await joclyMatch.abortUserTurn().catch(() => {});
        await joclyMatch.abortMachineSearch().catch(() => {});
        cancelRemoteWait('load-board-state');
        try {
            await joclyMatch.load({ game: gameName, playedMoves: [], initialBoard: payload.state });
            await resyncRemoteChannelBaseline();
            paused = false;
            UpdatePause();
            UpdateFooter('');
            emit(`play-event:${matchId}:move-played`, null).catch(() => {});
            await rearmAfterPositionChange();
        } catch (e) {
            console.warn('[play] load-board-state:', e.message || e);
            UpdateFooter(t('play.loadFailed'));
        }
    });

    // get-clock : état de l'horloge pour la fenêtre clock.html
    listen(prefix + 'get-clock', async () => {
        await emit(`play-rep:${matchId}:get-clock`, ClockPayload());
    });

    // get-possible-moves : retourne les coups possibles depuis la position actuelle
    listen(prefix + 'get-possible-moves', async () => {
        if (!joclyMatch) return;
        const moves = await joclyMatch.getPossibleMoves().catch(() => []);
        const strMoves = await joclyMatch.getMoveString(moves).catch(() => []);
        await emit(`play-rep:${matchId}:get-possible-moves`, { moves: moves || [], strMoves: strMoves || [] });
    });

    // input-move : joue un coup choisi dans la fenêtre "Possible moves"
    // (équivalent joclyboard::inputMove) — on interrompt le userTurn en
    // attente puis on applique ; la boucle reprend sur le tour suivant.
    // Ce chemin contourne gameLoop() (playMove direct, pas userTurn) : on
    // reproduit donc ici l'envoi au relai distant que gameLoop fait pour tout
    // coup joué localement, sinon l'adversaire distant ne le recevrait jamais.
    listen(prefix + 'input-move', async ({ payload }) => {
        if (!joclyMatch || !payload?.move) return;
        await joclyMatch.abortUserTurn().catch(() => {});
        cancelRemoteWait('input-move');
        await joclyMatch.playMove(payload.move).catch(e => console.warn('[play] input-move:', e));
        await ClockTurn(await joclyMatch.getTurn().catch(() => null)).catch(() => {});
        if (remoteChannel) {
            const moves = await joclyMatch.getPlayedMoves().catch(() => []);
            const state = await joclyMatch.save().catch(() => null);
            remoteChannel.push({ nbTurns: moves.length, lastMove: moves[moves.length - 1] ?? null, state })
                .catch(e => console.warn('[play] envoi du coup au relai distant échoué :', e.message || e));
        }
        emit(`play-event:${matchId}:move-played`, null).catch(() => {});
    });

    // show-move : aperçu d'un coup au survol (best-effort : selon le jeu,
    // le viewControl Jocly peut ne pas supporter la mise en évidence — on
    // ignore alors silencieusement)
    listen(prefix + 'show-move', async ({ payload }) => {
        if (!joclyMatch) return;
        await joclyMatch.viewControl('showMoves', { moves: payload?.move ? [payload.move] : [] })
            .catch(() => {});
    });

    // get-camera / set-camera : pilotage caméra 3D (fenêtre camera-view),
    // équivalent des messages getCamera/setCamera de joclyboard via
    // l'API Jocly viewControl.
    listen(prefix + 'get-camera', async () => {
        if (!joclyMatch) return;
        const camera = await joclyMatch.viewControl('getCamera').catch(() => null);
        await emit(`play-rep:${matchId}:get-camera`, { camera });
    });
    listen(prefix + 'set-camera', async ({ payload }) => {
        if (!joclyMatch) return;
        await joclyMatch.viewControl('setCamera', payload || {}).catch(e => console.warn('[play] set-camera:', e));
    });
}

// -- DOMContentLoaded ---------------------------------------------------------
// ── Notations d'export (USI, occidentale) ────────────────────────────────────
//
// Au niveau MODULE, et non dans le callback DOMContentLoaded ou elles se
// trouvaient : les ecouteurs d'evenements sont installes par
// initSatelliteListeners(), une autre fonction, d'ou ces helpers etaient
// invisibles. Le symptome ne designait pas la cause -- « Can't find variable:
// WesternGame » a l'appel, alors que la declaration est bien la, quelques
// centaines de lignes plus bas et en colonne 0.

// La lettre que porte le plateau sur chaque case, lue dans le FEN courant.
//
// C'est l'abreviation FEN de la piece — precisement ce qu'ecrit la notation de
// ChuShogiLite ("+H"), la ou jocly ecrit son abreviation naturelle ("+DH").
// Plutot que de transporter une table de correspondance entre les deux, on lit
// la lettre a la source : le plateau la donne, et il est deja a notre portee.
function BoardLetters(fen, options) {
    // Le xiangqi de jocly nomme ses rangees a partir de 0, les autres jeux a
    // partir de 1. L'appelant le sait, la fonction non.
    const base = (options && options.zeroBased) ? 1 : 0;
    // La reserve du crazyhouse est collee au plateau, entre crochets
    // (« …/RNBQKBNR[Nn] »). Sans la retirer, les crochets comptent comme des
    // cases et decalent toute la derniere rangee : la lettre lue n'est plus
    // celle de la piece, et un coup parfaitement identifie se voit refuse.
    const rows = String(fen || '').split(' ')[0].replace(/\[[^\]]*\]/g, '').split('/');
    const map = {};
    rows.forEach((row, index) => {
        const rank = rows.length - index - base;
        let file = 0;
        for (let k = 0; k < row.length; ) {
            const c = row[k];
            if (c >= '0' && c <= '9') {
                let n = c;
                while (row[k + 1] >= '0' && row[k + 1] <= '9') n += row[++k];
                file += parseInt(n, 10); k++; continue;
            }
            let piece = c; k++;
            if (c === '+') { piece += row[k]; k++; }   // piece promue : deux caracteres
            map[String.fromCharCode(97 + file) + rank] = piece;
            file++;
        }
    });
    return (square) => map[square] || null;
}

// Le coup que designe un jeton en notation « occidentale » (ChuShogiLite),
// ou null. Meme exigence que pour l'USI : exact, ou rien.
async function MoveFromWestern(token) {
    const parsed = ParseWesternMove(token);
    if (!parsed) return null;
    const moves = await joclyMatch.getPossibleMoves();
    if (!moves || !moves.length) return null;
    const natural = await joclyMatch.getMoveString(moves);
    const letterAt = BoardLetters(await joclyMatch.getBoardState());
    let found = null;
    for (let i = 0; i < moves.length; i++) {
        if (!WesternMatches(parsed, natural[i], letterAt)) continue;
        if (found) { console.warn('[play] notation ambiguë:', token); return null; }
        found = moves[i];
    }
    return found;
}

// Un index de plateau USI ramene aux coordonnees de jocly.
//
// Le numero de colonne se compte depuis la DROITE et la lettre de rangee
// depuis le HAUT — l'exact inverse de jocly. `files` est la largeur du
// plateau, que l'appelant tient de la position : la formule de ChuShogiLite
// vaut pour ses 12 colonnes, elle ne s'y limite pas.
function UsiToJocly(square, files) {
    const m = /^(\d+)([a-z])$/.exec(square || '');
    if (!m) return null;
    const file = files - parseInt(m[1], 10);
    const rank = files - (m[2].charCodeAt(0) - 97);
    if (file < 0 || rank < 1) return null;
    return String.fromCharCode(97 + file) + rank;
}

// La partie reecrite en notation occidentale, pour un export que
// ChuShogiLite relit.
//
// Il faut REJOUER la partie : la lettre de la piece se lit sur le plateau
// AVANT le coup, et la desambiguisation depend des autres coups legaux a cet
// instant. On revient donc au depart, on avance coup par coup, puis on
// restaure la position ou l'utilisateur se trouvait — l'Historique fait
// exactement ce va-et-vient a chaque clic, ce n'est pas un detour exotique.
//
// Renvoie null si le jeu ne sait pas ecrire l'USI (pas de sfen-model.js) :
// l'appelant retombe alors sur le PJN, plutot que d'ecrire un fichier
// bancal dans un format qu'il annonce.
async function WesternGame() {
    const played = await joclyMatch.getPlayedMoves().catch(() => []);
    if (!played || !played.length) return { moves: [], sfen: null };
    // La position de depart est FACULTATIVE : ChuShogiLite n'ecrit [FEN] que
    // pour une position non standard, et une partie jouee depuis le debut n'en
    // a pas besoin. La refuser faute de SFEN privait d'export toutes les
    // parties ordinaires -- le cas le plus courant, et celui qui a ete
    // signale.
    const raw = await joclyMatch.getBoardState('sfen').catch(() => null);
    const sfenOk = !!raw && raw.trim().split(/\s+/).length <= 4;
    if (!sfenOk) console.info('[play] pas de SFEN pour ce jeu — PGN sans [FEN] :', raw);
    const board = (raw || '').split(' ')[0];
    const files = (board.split('/')[0].match(/\d+|\+?[A-Za-z]/g) || [])
        .reduce((n, tok) => n + (/^\d+$/.test(tok) ? parseInt(tok, 10) : 1), 0) || 12;

    // Le xiangqi est le seul a numeroter ses rangees a partir de 0. Le janggi,
    // sur le meme plateau, ecrit « a4-a5 » : la geometrie ne dit rien de la
    // notation, seul le jeu la dit.
    const zeroBasedRanks = gameName === 'xiangqi';
    // La lettre du plateau n'est fiable que si le FEN et les NOMS de cases ont
    // la meme largeur : les jeux a reserve (shogi, crazyhouse) ont des
    // colonnes de main qui ne portent pas de nom et decalent toute lecture.
    const fenBoard = (await joclyMatch.getBoardState().catch(() => '') || '').split(' ')[0];
    const fenWidth = (fenBoard.split('/')[0].match(/\d+|\+?[A-Za-z]/g) || [])
        .reduce((n, tok) => n + (/^\d+$/.test(tok) ? parseInt(tok, 10) : 1), 0);
    const reliableLetters = fenWidth === files || gameName === 'chu-shogi';

    const here = played.length;
    const out = [];
    try {
        await joclyMatch.rollback(0);
        const first = await joclyMatch.getBoardState('sfen').catch(() => null);
        const start = (sfenOk && first && first.trim().split(/\s+/).length <= 4) ? first : null;
        for (let ply = 0; ply < here; ply++) {
            const legal = await joclyMatch.getPossibleMoves();
            const naturals = await joclyMatch.getMoveString(legal);
            const letterAt = BoardLetters(await joclyMatch.getBoardState(),
                                          { zeroBased: zeroBasedRanks });
            const index = legal.findIndex(m => m.f === played[ply].f && m.t === played[ply].t
                && (m.via || null) === (played[ply].via || null)
                && (m.pr || null) === (played[ply].pr || null));
            if (index < 0) {
                console.warn('[play] export : coup', ply + 1, 'introuvable dans la liste legale');
                out.push('?'); await joclyMatch.rollback(ply + 1); continue;
            }

            const mine = ParseNaturalMove(naturals[index]) || { steps: [] };
            if (!mine.from) {
                const usi = await joclyMatch.getMoveString(legal[index], 'usi').catch(() => null);
                const first = /^(\d+[a-z])/.exec(usi || '');
                mine.from = first ? UsiToJocly(first[1], files) : null;
            }
            const letter = mine.from ? letterAt(mine.from) : null;

            // Les rivales : les autres coups legaux de la MEME piece menant
            // aux memes cases. La piece n'est pas sa propre rivale — elle
            // offre deux coups pour un seul deplacement, promouvoir ou non.
            const rivals = [];
            for (let i = 0; i < legal.length; i++) {
                if (i === index) continue;
                const other = ParseNaturalMove(naturals[i]);
                if (!other || other.steps.length !== mine.steps.length) continue;
                if (!other.steps.every((st, k) => st.square === mine.steps[k].square)) continue;
                if (other.from && other.from !== mine.from && letterAt(other.from) === letter)
                    rivals.push(other.from);
            }
            // DEUX notations, selon le destinataire. Le chu shogi va chez
            // ChuShogiLite, qui attend la notation occidentale ; tous les
            // autres jeux vont chez PyChess, qui attend du SAN. Le jeu tranche
            // seul, il n'y a rien a demander a l'utilisateur.
            let token;
            if (gameName === 'chu-shogi') {
                token = BuildWesternMove(mine, letter, rivals);
            } else {
                const usiMove = await joclyMatch.getMoveString(legal[index], 'usi').catch(() => null);
                token = BuildSanMove(naturals[index], rivals, gameName, {
                    letterAt: reliableLetters ? letterAt : undefined,
                    // Le xiangqi numerote ses rangees a partir de 0 et n'ecrit
                    // ni separateur ni prise : l'appelant fournit les deux.
                    rankOffset: zeroBasedRanks ? 1 : 0,
                    capture: legal[index].c !== null && legal[index].c !== undefined,
                    promoted: (typeof usiMove === 'string' && usiMove !== '??')
                        ? usiMove.endsWith('+') : undefined,
                });
            }
            if (!token) console.warn('[play] export : coup', ply + 1,
                '(' + naturals[index] + ') non traduisible');
            out.push(token || '?');
            await joclyMatch.rollback(ply + 1);
        }
        return { moves: out, sfen: start };
    } finally {
        // Quoi qu'il arrive, l'utilisateur retrouve la position qu'il avait.
        await joclyMatch.rollback(here).catch(() => {});
    }
}

// Le coup que designe un jeton de KIF : « depart-arrivee », ou
// « depart-passage-arrivee » pour les coups a deux pas du Lion, avec « + »
// pour une promotion et « = » pour un refus explicite.
//
// Resolution par les CASES, et non par le nom de la piece : le KIF donne la
// case de depart de chaque coup, ce qui suffit a le designer sans ambiguite --
// c'est meme plus simple que le PGN, ou l'origine est omise. Le nom de piece
// qui figure dans le fichier n'est donc pas necessaire ici.
//
// jocly n'ecrit pas la case de depart sur un coup a deux pas : on compare
// alors les seules cases qu'il donne, passage puis arrivee.
async function MoveFromSquares(token) {
    // Parachutage : « P@c6 », la piece nommee et la case, sans depart.
    const drop = /^([A-Z+]*)@([a-l]\d{1,2})$/.exec(String(token || '').trim());
    if (drop) {
        const moves = await joclyMatch.getPossibleMoves();
        if (!moves || !moves.length) return null;
        const naturals = await joclyMatch.getMoveString(moves);
        let found = null;
        for (let i = 0; i < moves.length; i++) {
            const d = /^([A-Z+]*)@([a-l]\d{1,2})[+#]?$/.exec(naturals[i]);
            if (!d || d[2] !== drop[2] || d[1] !== drop[1]) continue;
            if (found) { console.warn('[play] KIF : parachutage ambigu', token); return null; }
            found = moves[i];
        }
        return found;
    }
    const m = /^([a-l]\d{1,2}(?:-[a-l]\d{1,2})+)([+=]?)$/.exec(String(token || '').trim());
    if (!m) return null;
    const want = m[1].split('-');
    const promote = m[2] === '+' ? true : (m[2] === '=' ? false : null);
    const moves = await joclyMatch.getPossibleMoves();
    if (!moves || !moves.length) return null;
    const naturals = await joclyMatch.getMoveString(moves);
    let found = null;
    for (let i = 0; i < moves.length; i++) {
        const parsed = ParseNaturalMove(naturals[i]);
        if (!parsed) continue;
        const squares = [parsed.from, ...parsed.steps.map(st => st.square)].filter(Boolean);
        const target = squares.length === want.length ? want : want.slice(want.length - squares.length);
        if (squares.length !== target.length) continue;
        if (!squares.every((sq, k) => sq === target[k])) continue;
        // La promotion n'est comparee que si jocly a offert le choix.
        if (promote !== null && parsed.promote !== null && parsed.promote !== promote) continue;
        if (found) { console.warn('[play] KIF : jeton ambigu', token); return null; }
        found = moves[i];
    }
    return found;
}

// Le coup que designe un jeton WXF (xiangqi), ou null.
//
// La notation est ecrite du point de vue du joueur : colonnes comptees depuis
// sa droite, « + » vers l'avant. Le camp au trait est donc indispensable pour
// la lire, et c'est le moteur qui le donne — pas le fichier.
async function MoveFromWxf(token) {
    const parsed = ParseWxfMove(token);
    if (!parsed) return null;
    const moves = await joclyMatch.getPossibleMoves();
    if (!moves || !moves.length) return null;
    const naturals = await joclyMatch.getMoveString(moves);
    const state = await joclyMatch.getBoardState();
    const letterAt = BoardLetters(state);
    const width = (state.split(' ')[0].split('/')[0].match(/\d+|[A-Za-z]/g) || [])
        .reduce((n, tok2) => n + (/^\d+$/.test(tok2) ? parseInt(tok2, 10) : 1), 0) || 9;
    const red = (await joclyMatch.getTurn()) === Jocly.PLAYER_A;
    let found = null;
    for (let i = 0; i < moves.length; i++) {
        const m = /^([a-z]\d{1,2})([a-z]\d{1,2})$/.exec(naturals[i]);
        if (!m) continue;
        if (!WxfMatches(parsed, m[1], m[2], letterAt(m[1]), red, width)) continue;
        if (found) { console.warn('[play] WXF : jeton ambigu', token); return null; }
        found = moves[i];
    }
    return found;
}

// Le coup que designe un jeton SAN (echecs et variantes), ou null.
//
// Resolution EXACTE, comme pour les autres notations etrangeres : pickMove
// choisirait par distance d'edition et jouerait « Nbd2 » comme « Nf3 » sans le
// dire. Ici la case d'arrivee, la prise, la desambiguisation et la promotion
// doivent toutes correspondre, et la piece est identifiee par la lettre que
// porte le PLATEAU a la case de depart -- pas par une table d'abreviations,
// qui differe d'une variante a l'autre.
// Decalage de rangee entre le fichier et jocly, DETERMINE et non devine.
//
// jocly numerote les rangees du xiangqi a partir de 0 (« c0e2 ») quand PyChess
// compte a partir de 1 (« Hc3 ») : le meme point du plateau s'ecrit
// differemment. Le decalage ne se lit nulle part, mais il se verifie -- une
// seule des deux lectures resout le premier coup. On l'essaie donc, et on le
// retient pour la partie.
let sanRankOffset = null;

// Repond au prelude, s'il y en a un, en essayant les choix offerts.
//
// Renvoie true si un choix a ete joue. Le critere est le premier coup du
// fichier : sans lui (partie sans coups), on prend le premier choix, faute de
// mieux, et on le dit.
// Un coup de prelude, reconnaissable a son nom : « #0 », « #1 »... pour un
// choix, « -- » pour une etape qui ne demande rien mais qu'il faut franchir.
const PRELUDE_MOVE = /^(#\d+|--)$/;

async function AnswerPrelude(firstToken, recorded) {
    // Un fichier ecrit par Tabulon PORTE la reponse : « 1. #2 -- ». Quand
    // elle est la, on la suit au lieu de la deviner -- et il le faut, parce
    // que la deviner ne peut pas marcher : le seul jeton dont on disposait
    // pour departager etait « #2 » lui-meme, qui ne designe aucun coup une
    // fois le prelude franchi. Aucun choix ne le resolvait, le repli prenait
    // le premier arrangement, et une partie de Malett se serait rechargee en
    // Gardner -- si la lecture etait allee au bout.
    const queue = (recorded || []).slice();
    // PLUSIEURS ETAPES. Sho Shogi en a deux : le choix de la regle, puis un
    // passage. N'en franchir qu'une laissait la partie sur un coup « -- »
    // unique, et le premier coup du fichier restait introuvable -- exactement
    // le symptome qu'on croyait venir de la notation.
    const stages = [];
    for (let depth = 0; depth < 4; depth++) {
        const moves = await joclyMatch.getPossibleMoves().catch(() => []);
        if (!moves || !moves.length) break;
        const names = await joclyMatch.getMoveString(moves).catch(() => []);
        if (!PRELUDE_MOVE.test(names[0] || '')) break;

        // Le fichier dit quelle etape a ete franchie et comment.
        if (queue.length) {
            const want = queue.shift();
            const i = names.indexOf(want);
            if (i >= 0) {
                await joclyMatch.playMove(moves[i]);
                stages.push(names[i]);
                continue;
            }
            console.warn('[play] prelude : « ' + want + ' » ne figure pas parmi '
                + names.join(' ') + ' — on devine');
        }
        // Une etape sans choix se franchit sans se poser de question.
        if (moves.length === 1) {
            await joclyMatch.playMove(moves[0]);
            stages.push(names[0]);
            continue;
        }
        // Une etape a plusieurs choix : le bon est celui sous lequel le
        // premier coup du fichier se resout. Sans coup pour departager, on
        // prend le premier et on le dit.
        let chosen = null;
        for (let i = 0; i < moves.length && firstToken; i++) {
            await joclyMatch.playMove(moves[i]);
            const rest = await AnswerPrelude(null);      // franchir les suivantes
            const resolved = await MoveFromSan(firstToken).catch(() => null)
                || await joclyMatch.pickMove(firstToken).catch(() => null);
            if (resolved) { chosen = names[i]; break; }
            await joclyMatch.rollback(stages.length).catch(() => {});
            void rest;
        }
        if (chosen === null) {
            await joclyMatch.playMove(moves[0]).catch(() => {});
            chosen = names[0];
            if (firstToken) console.warn('[play] prelude : aucun choix ne resout le premier coup, « '
                + chosen + ' » retenu');
        }
        stages.push(chosen);
    }
    if (stages.length) console.info('[play] prelude :', stages.join(' '));
    return stages.length > 0;
}

async function MoveFromSan(token) {
    const parsed = ParseSanMove(token);
    if (!parsed) return null;
    const moves = await joclyMatch.getPossibleMoves();
    if (!moves || !moves.length) return null;
    const naturals = await joclyMatch.getMoveString(moves);
    const letterAt = BoardLetters(await joclyMatch.getBoardState(), { zeroBased: true });

    // La promotion se lit dans l'USI, dont le « + » final est sans ambiguite.
    // La notation naturelle, elle, ne la montre pas de facon fiable : pour le
    // shogi jocly n'ecrit rien du tout, et le « + » qu'on y voit parfois est
    // un echec. Les jeux qui ne savent pas ecrire l'USI n'ont pas de
    // promotion a departager, et l'absence de reponse convient.
    const usi = await joclyMatch.getMoveString(moves, 'usi').catch(() => null);

    const tryOffset = (offset) => {
        let found = null, ambiguous = false;
        for (let i = 0; i < moves.length; i++) {
            // Le nom du jeu accompagne la comparaison : la table d'alias est
            // organisee par jeu, la meme lettre y designant des pieces
            // differentes selon la variante.
            const options = { rankOffset: offset, game: gameName };
            if (usi && typeof usi[i] === 'string') options.promoted = usi[i].endsWith('+');
            if (!SanMatches(parsed, naturals[i], letterAt, options)) continue;
            if (found) { ambiguous = true; continue; }
            found = moves[i];
        }
        return ambiguous ? null : found;
    };

    if (sanRankOffset !== null) return tryOffset(sanRankOffset);
    for (const offset of [0, 1]) {
        const move = tryOffset(offset);
        if (move) {
            sanRankOffset = offset;
            if (offset) console.info('[play] SAN : rangées décalées de', offset, '— notation de PyChess');
            return move;
        }
    }
    return null;
}

// Le coup que designe un jeton USI dans la position courante, ou null.
//
// On NE PASSE PAS par pickMove : celui-ci appelle GetBestMatchingMove, qui
// choisit par distance d'edition sur la notation naturelle et ne peut pas
// echouer -- « 12i12h » y trouverait toujours un plus proche, joue en silence.
// On demande donc au moteur d'ecrire chaque coup legal en USI (format ajoute
// par shogi/sfen-model.js) et on compare litteralement.
//
// Deux refus explicites, comme MoveFromUSI cote jocly : aucun coup ne
// correspond, ou plusieurs -- auquel cas on ne choisit pas.
async function MoveFromUSI(token) {
    const moves = await joclyMatch.getPossibleMoves();
    if (!moves || !moves.length) return null;
    let strings;
    try { strings = await joclyMatch.getMoveString(moves, 'usi'); }
    catch (e) { console.warn('[play] USI indisponible pour ce jeu:', e.message || e); return null; }
    let found = null;
    for (let i = 0; i < moves.length; i++) {
        if (strings[i] !== token) continue;
        if (found) { console.warn('[play] USI ambigu:', token); return null; }
        found = moves[i];
    }
    return found;
}

document.addEventListener('DOMContentLoaded', async () => {
    await initI18n();
    console.info('[play] DOMContentLoaded, game:', gameName, 'id:', matchId);
    store = await Store.load('tabulon.json');

    const config = await Jocly.getGameConfig(gameName);
    await twu.init(t('play.title', { game: config.model['title-en'], id: matchId }), '.game-header');

    levels = config.model.levels || [];
    BuildPlayerSelect('select-player-a', Jocly.PLAYER_A);
    BuildPlayerSelect('select-player-b', Jocly.PLAYER_B);

    // Favoris
    tRpc.call('is_favorite', gameName).then(UpdateFav).catch(() => {});
    document.getElementById('button-favorite-no')
        ?.addEventListener('click', () =>
            tRpc.call('set_favorite', gameName, true).then(() => UpdateFav(true)));
    document.getElementById('button-favorite-yes')
        ?.addEventListener('click', () =>
            tRpc.call('set_favorite', gameName, false).then(() => UpdateFav(false)));

    document.getElementById('button-fullscreen')
        ?.addEventListener('click', () =>
            document.querySelector('.game-area').webkitRequestFullscreen?.());

    const btn = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);

    document.getElementById('play-warning-close')?.addEventListener('click', HideWarning);

    // Bouton '…' : montre/masque la barre de boutons (état persisté).
    // Remplace le survol .ephemeral-actions:hover de JoclyBoard, inutilisable
    // sur tablette.
    const ephemeralActions = document.querySelector('.ephemeral-actions');
    if (await store.get('play-footer-bar').catch(() => false))
        ephemeralActions?.classList.add('bar-visible');
    btn('button-toggle-bar', () => {
        const visible = ephemeralActions?.classList.toggle('bar-visible');
        store?.set('play-footer-bar', !!visible);
    });

    btn('button-history',  () => tRpc.call('open_history', matchId, gameName));
    btn('button-clock',    () => tRpc.call('open_clock', matchId));
    btn('button-players',  () => tRpc.call('open_players', matchId));
    btn('button-options',  () => tRpc.call('open_view_options', matchId));
    btn('button-help',     () => tRpc.call('open_info', gameName));
    btn('button-template', () => tRpc.call('open_save_template', matchId));
    btn('button-clone', async () => {
        if (!joclyMatch) return;
        // Sauvegarder la position courante dans le store sous une cle
        // ephemere, que le nouveau play.html lira et chargera au demarrage.
        const saveData = await joclyMatch.save().catch(() => null);
        if (saveData) {
            await store?.set('fork:' + matchId, saveData);
        }
        await tRpc.call('new_match', gameName, null, String(matchId));
    });
    btn('button-camera',   () => tRpc.call('open_camera_view', matchId, gameName));

    btn('button-takeback', async () => {
        if (!joclyMatch) return;
        // Garde de fond (le bouton est deja grise en mode distant) : reculer
        // desynchroniserait la partie distante, relai comme pair-a-pair.
        if (hasRemoteSide()) { UpdateFooter(t('play.remoteRestricted')); return; }
        await joclyMatch.abortUserTurn().catch(() => {});
        await joclyMatch.abortMachineSearch().catch(() => {});
        cancelRemoteWait('takeback');

        const moves = await joclyMatch.getPlayedMoves().catch(() => []);
        const n = moves?.length || 0;
        if (n === 0) return;

        // Reculer coup par coup jusqu'à trouver une position où c'est
        // au tour d'un humain de jouer, en utilisant getTurn() comme
        // source de vérité (fiable pour tous les jeux, y compris ceux
        // où le premier joueur n'est pas PLAYER_A).
        for (let target = n - 1; target >= 0; target--) {
            await joclyMatch.rollback(target);
            if (target === 0) break;  // début de partie, on s'arrête
            const turn = await joclyMatch.getTurn().catch(() => null);
            if (!players[turn]) break;  // tour humain trouvé
        }
        await resyncRemoteChannelBaseline();
        UpdateFooter('');
        emit(`play-event:${matchId}:move-played`, null).catch(() => {});
        await rearmAfterPositionChange();
    });

    btn('button-restart', async () => {
        if (!joclyMatch) return;
        if (hasRemoteSide()) { UpdateFooter(t('play.remoteRestricted')); return; }
        await joclyMatch.abortUserTurn().catch(() => {});
        await joclyMatch.abortMachineSearch().catch(() => {});
        cancelRemoteWait('restart');
        await joclyMatch.rollback(0);
        await resyncRemoteChannelBaseline();
        paused = false;
        UpdatePause();
        UpdateFooter('');
        // Nouvelle partie : le moteur peut redevenir disponible, l'avertissement
        // doit pouvoir se represente s'il replie a nouveau.
        fairyFallbackWarned = false;
        HideWarning();
        await rearmAfterPositionChange();
    });

    btn('button-pause', () => {
        paused = true;
        joclyMatch?.abortUserTurn().catch(() => {});
        joclyMatch?.abortMachineSearch().catch(() => {});
        UpdatePause();
    });

    btn('button-resume', () => {
        paused = false;
        UpdatePause();
    });

    btn('button-replay', async () => {
        if (!joclyMatch) return;
        const moves = await joclyMatch.getPlayedMoves();
        if (moves?.length > 0)
            await joclyMatch.rollback(moves.length - 1).catch(() => {});
    });

    // Save : équivalent du download JSON de JoclyBoard. Le `data:` URI +
    // a.click() d'Electron ne déclenche rien dans la WebView Tauri (pas de
    // download manager) : on passe par le dialogue natif "Enregistrer sous"
    // (plugin dialog) puis la commande Rust save_text_file écrit le fichier.
    btn('button-save', async () => {
        if (!joclyMatch) return;
        const data = await joclyMatch.save().catch(() => null);
        if (!data) return;
        const path = await saveDialog({
            defaultPath: gameName + '.json',
            filters: [{ name: t('play.saveFilter'), extensions: ['json'] }],
        }).catch(() => null);
        if (!path) return;   // dialogue annulé
        await tRpc.call('save_text_file', path, JSON.stringify(data, null, 2))
            .catch(e => console.warn('[play] save failed:', e));
    });

    // Load : équivalent de loadMatch → MatchAction → KeepPlaying de JoclyBoard.
    // L'ancien code forçait loopActive=false puis relançait gameLoop()
    // immédiatement : l'ancienne boucle, réveillée par l'abort (branche
    // `continue`), retrouvait loopActive=true posé par la NOUVELLE boucle →
    // deux boucles concurrentes s'avortant mutuellement. Comme JoclyBoard
    // (KeepPlaying), on charge et on laisse la boucle en cours continuer sur
    // la nouvelle position ; on ne redémarre que si elle était arrêtée
    // (partie terminée).
    const fileElem = document.getElementById('fileElem');
    fileElem?.addEventListener('change', async () => {
        if (!joclyMatch || !fileElem.files[0]) return;
        const reader = new FileReader();
        reader.readAsText(fileElem.files[0]);
        reader.onload = async (e) => {
            fileElem.value = '';   // permet de recharger le même fichier
            let data;
            try { data = JSON.parse(e.target.result); }
            catch { console.warn('[play] load: invalid JSON'); return; }
            await joclyMatch.abortUserTurn().catch(() => {});
            await joclyMatch.abortMachineSearch().catch(() => {});
            cancelRemoteWait('load-file');
            try { await joclyMatch.load(data); await resyncRemoteChannelBaseline(); }
            catch (err) {
                // ex. "Trying to load X to Y match" (mauvais jeu)
                console.warn('[play] load failed:', err.message);
                UpdateFooter(t('play.loadFailed'));
                if (!loopActive) gameLoop();
                return;
            }
            paused = false;
            UpdatePause();
            UpdateFooter('');
            // Rafraîchir les satellites (history) sur la nouvelle position
            emit(`play-event:${matchId}:move-played`, null).catch(() => {});
            await rearmAfterPositionChange();
        };
    });
    btn('button-load', () => fileElem?.click());

    // ── Capture vidéo ─────────────────────────────────────────────────────
    // Réparation vs JoclyBoard (Linux) : la pompe n'est plus un setInterval
    // 30 fps — quand takeSnapshot dépasse 33 ms (3D/WebGL), les captures
    // s'empilaient en concurrence (frames désordonnées, UI asphyxiée). Ici
    // une boucle SÉQUENTIELLE auto-replanifiée : capture → envoi → attente
    // du reliquat de la période. Les options de JoclyBoard sont reprises :
    //   video-record:quality               qualité JPEG (store, optionnel)
    //   video-record:ignoreIdenticalFrames après N frames identiques
    //                                      consécutives, on cesse d'envoyer
    //                                      (la vidéo saute les temps morts)
    let videoRecording = false;
    let videoLastFrame = null;
    let videoIdenticalCount = 0;

    async function PumpFrame(quality, ignoreIdentical) {
        if (!videoRecording) return;
        const t0 = Date.now();
        let snapshot = await joclyMatch.viewControl('takeSnapshot', { format: 'jpeg', quality })
            .catch(() => null);
        if (!videoRecording) return;   // arrêté pendant la capture
        if (snapshot) {
            if (snapshot === videoLastFrame) {
                videoIdenticalCount++;
                if (videoIdenticalCount > ignoreIdentical) snapshot = null;
            } else {
                videoIdenticalCount = 0;
                videoLastFrame = snapshot;
            }
        }
        if (snapshot) {
            try { await tRpc.call('record_frame', matchId, snapshot); }
            catch (e) {
                // ffmpeg mort (disque plein, codec…) : arrêter proprement et
                // remonter la cause au lieu de marteler des erreurs à 30 fps
                console.warn('[play] record_frame:', e);
                StopRecording(e.message || String(e));
                return;
            }
        }
        setTimeout(() => PumpFrame(quality, ignoreIdentical),
            Math.max(0, 1000 / 30 - (Date.now() - t0)));
    }

    async function StartRecording() {
        if (videoRecording || !joclyMatch) return;
        try { await tRpc.call('start_recording', matchId); }
        catch (e) {
            // "Recording cancelled" = dialogue annulé : silencieux
            if (!/cancel/i.test(String(e.message || e))) UpdateFooter(t('play.videoError', { error: e.message || e }));
            return;
        }
        videoRecording = true;
        videoLastFrame = null;
        videoIdenticalCount = 0;
        document.getElementById('button-stop-video')?.classList.remove('hidden');
        // Le bouton 'Record video' devient une BASCULE : re-cliquer arrête
        // l'enregistrement (état visuel .recording + tooltip 'Stop recording')
        const vbtn = document.getElementById('button-video');
        vbtn?.classList.add('recording');
        if (vbtn) vbtn.title = t('tip.stopRecording');
        const quality = await store?.get('video-record:quality').catch(() => undefined);
        const ignoreIdentical = await store?.get('video-record:ignoreIdenticalFrames').catch(() => null) || 30;
        PumpFrame(quality, ignoreIdentical);
    }

    async function StopRecording(error) {
        if (!videoRecording) return;
        videoRecording = false;
        document.getElementById('button-stop-video')?.classList.add('hidden');
        const vbtn = document.getElementById('button-video');
        vbtn?.classList.remove('recording');
        if (vbtn) vbtn.title = t('tip.recordVideo');
        if (error) { UpdateFooter(t('play.videoError', { error })); tRpc.call('stop_recording', matchId).catch(() => {}); return; }
        try {
            const path = await tRpc.call('stop_recording', matchId);
            UpdateFooter(t('play.videoSaved', { path }));
        } catch (e) {
            UpdateFooter(t('play.videoError', { error: e.message || e }));
        }
    }

    // Actions rapides du footer (barre masquée) : proxys vers les boutons
    // de la barre — un seul handler par action, zéro duplication de logique.
    btn('quick-takeback', () => document.getElementById('button-takeback')?.click());
    btn('quick-restart',  () => document.getElementById('button-restart')?.click());

    // Bascule : démarrer si à l'arrêt, arrêter si en cours (demande UX)
    btn('button-video',      () => videoRecording ? StopRecording() : StartRecording());
    // Filet JS : finaliser si la fenêtre se ferme pendant l'enregistrement
    // (doublé côté Rust par le hook WindowEvent::Destroyed de lib.rs, qui
    // couvre aussi le cas où cet invoke n'a pas le temps de partir)
    window.addEventListener('beforeunload', () => {
        if (videoRecording) { videoRecording = false; tRpc.call('stop_recording', matchId).catch(() => {}); }
        disposeRemoteChannel();
    });
    btn('button-stop-video', () => StopRecording());

    // Take snapshot : viewControl('takeSnapshot') retourne un data-URI ; le
    // download a.click() d'Electron ne fait rien sous Tauri → dialogue natif
    // + commande Rust save_data_uri_file (écriture binaire du PNG).
    btn('button-snapshot', async () => {
        if (!joclyMatch) return;
        const snapshot = await joclyMatch.viewControl('takeSnapshot')
            .catch(e => { console.warn('[play] Snapshot error:', e); return null; });
        if (!snapshot) return;
        const path = await saveDialog({
            defaultPath: gameName + '.png',
            filters: [{ name: 'PNG', extensions: ['png'] }],
        }).catch(() => null);
        if (!path) return;
        await tRpc.call('save_data_uri_file', path, snapshot)
            .catch(e => console.warn('[play] snapshot save failed:', e));
    });

    // Init Jocly
    console.info('[play] creating Jocly match for', gameName);
    joclyMatch = await Jocly.createMatch(gameName);

    const fullConfig = await joclyMatch.getConfig();
    const supports3D = (() => {
        try { return !!window.WebGLRenderingContext &&
              !!document.createElement('canvas').getContext('experimental-webgl'); }
        catch (e) { return false; }
    })();
    const skins = (fullConfig?.view?.skins || []).filter(s => supports3D || !s['3d']);
    const storedOptions = await store.get('view-options:' + gameName).catch(() => null);
    const defaultSkin = skins[0]?.name;
    let viewOptions = Object.assign({
        sounds: true, notation: false, moves: true,
        autoComplete: false, viewAs: Jocly.PLAYER_A,
    }, fullConfig?.view?.defaultOptions || {}, storedOptions || {}, viewOptionsFromUrl || {});
    if (defaultSkin && !skins.find(s => s.name === viewOptions.skin))
        viewOptions.skin = defaultSkin;

    const gameArea = document.querySelector('.game-area');
    if (!gameArea) throw new Error('[play] .game-area not found in DOM');

    const attachOptions = { viewOptions };
    if (clockConfig) attachOptions.clock = clockConfig;
    await joclyMatch.attachElement(gameArea, attachOptions);

    // Niveaux « Expert » : router fairy-stockfish vers le moteur NATIF plutot
    // que vers la build wasm multi-thread, qui ne peut pas rendre de coup dans
    // une webview Tauri (voir engine-native.js). Sans binaire installe, Jocly
    // se rabat sur son IA native et le bandeau #play-warning s'affiche.
    installNativeEngine(gameArea, tRpc);

    // Sélecteur de skin (2D/3D) du footer, à côté des joueurs A/B — visible
    // seulement quand la barre de boutons est masquée (classe
    // player-select-wrap, exclusion gérée en CSS par .bar-visible).
    // Capture d'écran / vidéo : disponibles uniquement en 3D (limitation
    // Jocly : viewControl('takeSnapshot') rejette "Snapshot only available
    // on 3D views" en 2D — c'est le rendu WebGL qui est capturé). On grise
    // les deux boutons quand le skin courant est un 2D CONNU ; si les
    // métadonnées manquent, on laisse actif (jocly signalera).
    function UpdateCaptureButtons(skinName) {
        const entry = skins.find(sk => sk.name === skinName);
        const disable = entry ? !entry['3d'] : false;
        for (const [id, tipKey] of [['button-snapshot', 'tip.snapshot'], ['button-video', 'tip.recordVideo']]) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.disabled = disable;
            el.title = disable ? t('play.capture3dOnly') : t(tipKey);
        }
        if (disable && videoRecording) StopRecording();   // passage en 2D pendant la capture
    }
    UpdateCaptureButtons(viewOptions.skin);

    const skinSel = document.getElementById('select-skin');
    if (skinSel && skins.length > 1) {
        skins.forEach(sk => {
            const opt = document.createElement('option');
            opt.value = sk.name;
            opt.textContent = sk.title;
            skinSel.appendChild(opt);
        });
        skinSel.value = viewOptions.skin;
        skinSel.addEventListener('change', async () => {
            const opts = await joclyMatch.getViewOptions().catch(() => ({}));
            opts.skin = skinSel.value;
            await joclyMatch.setViewOptions(opts).catch(e => console.warn('[play] setViewOptions:', e));
            store?.set('view-options:' + gameName, opts);
            UpdateCaptureButtons(skinSel.value);
        });
        document.getElementById('skin-select-wrap').style.display = '';
    }
    console.info('[play] element attached', clockConfig ? '(with clock)' : '', forkId ? '(fork)' : '');

    // Rejoue une partie de livre (PGN/PJN) : coups SAN résolus un par un via
    // l'API Jocly pickMove (qui matche la notation contre les coups légaux)
    // puis appliqués par playMove. On tolère les décorations (+ # ! ?) en
    // retentant sans elles si pickMove ne trouve pas.

// Pourquoi ce jeton n'a-t-il pas ete resolu ? On le redemande a la position
// courante et on compte les correspondances : zero veut dire que le fichier
// ne parle pas de cette position, plusieurs qu'il est ambigu.
async function ExplainUnresolved(token) {
    try {
        const parsed = ParseSanMove(token);
        if (!parsed) { console.warn('[play] book: jeton illisible'); return; }
        const moves = await joclyMatch.getPossibleMoves();
        const naturals = await joclyMatch.getMoveString(moves);
        const letterAt = BoardLetters(await joclyMatch.getBoardState(),
                                      { zeroBased: gameName === 'xiangqi' });
        const matches = [];
        for (let i = 0; i < moves.length; i++)
            if (SanMatches(parsed, naturals[i], letterAt,
                           { game: gameName, rankOffset: sanRankOffset || 0 }))
                matches.push(naturals[i]);
        if (matches.length > 1)
            console.warn('[play] book: « ' + token +' » est ambigu —',
                matches.length, 'coups y correspondent :', matches.join(', '),
                '— le fichier omet la désambiguïsation');
        else if (matches.length === 0)
            console.warn('[play] book: « ' + token + ' » ne correspond à aucun coup légal ici');
    } catch (e) { console.warn('[play] book: diagnostic impossible:', e.message || e); }
}

async function BookReplay(book) {
        // Tag [FEN] du PGN/PJN : la partie ne commence PAS a la position
        // standard (probleme, finale, position d'etude). Sans ce chargement
        // prealable, pickMove chercherait les coups dans la position initiale
        // du jeu et echouerait des le premier.
        // Un [FEN] de PGN ChuShogiLite porte CINQ champs (plateau, trait, case
        // de la derniere prise de Lion, puis « 0 1 ») : ni un FEN jocly, qui
        // en a six, ni un SFEN, qui en a trois ou quatre et que jocly
        // reconnait seul. On le recompose ; tout le reste passe inchange.
        // Deux dialectes de [FEN] a ramener a ce que jocly lit : celui du chu
        // shogi (cinq champs) et celui du shogi de PyChess (reserve entre
        // crochets, a la maniere du crazyhouse). L'ordre importe peu, les deux
        // formes s'excluent.
        if (book.initialBoard) {
            book.initialBoard = PgnFenToJocly(book.initialBoard)
                || PgnFenToShogiSfen(book.initialBoard)
                || VariantFen(book.initialBoard, gameName);
        }
        // `tsume` accompagne la position partout ou elle est rechargee : la
        // fenetre Historique fait revenir play.js a la position de depart pour
        // rejouer jusqu'au coup demande, et sans l'option ce rechargement
        // rendrait la partie injouable au milieu de la navigation.
        if (book.tsume) { tsumeMatch = true; console.info('[play] book: position de tsume'); }
        if (book.initialBoard) {
            try {
                await joclyMatch.load({ game: gameName, playedMoves: [], initialBoard: book.initialBoard, tsume: tsumeMatch });
            } catch (e) {
                // La position est refusee : on ARRETE la. Rejouer les coups
                // depuis la position standard n'a aucun sens -- ils ne s'y
                // rapportent pas -- et les premiers passeraient parfois,
                // laissant croire a un chargement partiel plutot qu'a un
                // echec. Mieux vaut un plateau vierge et un message.
                console.warn('[play] book: position de depart refusee:', e.message || e);
                UpdateFooter(t('play.loadFailed'));
                return;
            }
        }
        // La resolution des jetons (decorations, coups colles) vit dans
        // book-format.js -- module pur, donc testable sans Jocly ; ici on ne
        // fournit que les operations qui touchent au moteur.
        // Choix de la notation. USI et « occidentale » exigent une resolution
        // EXACTE : ce sont des systemes de coordonnees etrangers a celui de
        // jocly, et pickMove -- qui choisit par distance d'edition et ne peut
        // pas echouer -- y jouerait le coup le plus ressemblant sans le dire.
        //
        // « occidentale » n'est qu'une candidature : la notation SAN des
        // echecs se lit de la meme facon. On l'ESSAIE donc sur le premier
        // coup, et on ne s'y engage que s'il se resout ; sinon on retombe sur
        // le chemin tolerant, qui reste le comportement de tous les fichiers
        // ouverts jusqu'ici.
        // Un livre venu d'un KIF porte ses coups en CASES : le hub l'a dit
        // (`book.kif`), et c'est necessaire — « e4-e5 » est aussi la notation
        // naturelle d'un pion chez jocly, les deux formes ne se distinguent
        // pas a la lecture du seul jeton.
        sanRankOffset = null;   // redetermine a chaque livre charge
        // Prelude : certains jeux ouvrent par un choix qui compte pour un
        // coup -- les dix dispositions de Capablanca, les deux regles de Sho
        // Shogi. jocly les nomme « #0 », « #1 »... et tant qu'il n'est pas
        // repondu, aucun coup de la partie n'est legal.
        //
        // Quand la position est fournie, jocly saute le prelude de lui-meme
        // pour les jeux dont le choix se LIT sur le plateau. Reste ceux dont
        // le choix est une REGLE : rien dans le fichier ne dit laquelle, et
        // on ne devine pas -- on essaie. Le bon choix est celui sous lequel
        // le premier coup du fichier se resout.
        // Les jetons de prelude en tete du fichier ne sont pas des coups a
        // rejouer : ils sont la reponse au dialogue d'ouverture. Les laisser
        // dans la liste faisait echouer la lecture sur le tout premier jeton
        // -- « #0 » ne designe aucun coup legal une fois le prelude franchi,
        // donc zero coup joue et le fichier declare illisible. Ils faussaient
        // aussi MoveFormat(), qui les lisait comme des coups pour deviner la
        // notation du fichier.
        const recordedPrelude = [];
        while (book.moves && book.moves.length && PRELUDE_MOVE.test(book.moves[0]))
            recordedPrelude.push(book.moves.shift());
        await AnswerPrelude(book.moves && book.moves[0], recordedPrelude);

        const format = book.kif ? 'kif' : MoveFormat(book.moves);
        let exact = null;
        if (format === 'kif') exact = MoveFromSquares;
        else if (format === 'wxf') exact = MoveFromWxf;
        else if (format === 'san') exact = MoveFromSan;
        else if (format === 'usi') exact = MoveFromUSI;
        else if (format === 'western' && await MoveFromWestern(book.moves[0]).catch(() => null))
            exact = MoveFromWestern;
        if (exact) console.info('[play] book: notation', format, '— résolution exacte');

        const replay = () => ReplayBookMoves(book.moves, {
            pick: (s) => joclyMatch.pickMove(s).catch(() => null),
            exact,
            play: (m) => joclyMatch.playMove(m),
        });
        let { played, unresolved } = await replay();

        // Le trait d'un SFEN arrive a l'envers quand il vient du tag [FEN]
        // d'un PGN ChuShogiLite (voir FlipSfenTurn). Plutot que de deviner le
        // producteur du fichier, on le VERIFIE : si le tout premier coup ne se
        // resout pas, on relit la meme position avec le trait inverse. Rien
        // n'est perdu -- aucun coup n'a ete joue -- et un fichier valide dans
        // l'autre convention se charge sans que l'utilisateur ait a le savoir.
        const flipped = played === 0 && unresolved && book.initialBoard
            ? FlipSfenTurn(book.initialBoard) : null;
        if (flipped) {
            try {
                await joclyMatch.load({ game: gameName, playedMoves: [], initialBoard: flipped, tsume: tsumeMatch });
                const retry = await replay();
                if (retry.played > 0) {
                    console.info('[play] book: trait inversé — position lue comme un [FEN] de PGN');
                    ({ played, unresolved } = retry);
                } else {
                    // Le trait n'etait pas le probleme : on remet la position
                    // telle que le fichier la donne, pour que le message
                    // d'erreur porte sur ce qu'il contient vraiment.
                    await joclyMatch.load({ game: gameName, playedMoves: [], initialBoard: book.initialBoard, tsume: tsumeMatch });
                }
            } catch (e) { console.warn('[play] book: relecture trait inversé:', e.message || e); }
        }
        if (unresolved) {
            console.warn('[play] book: coup non résolu:', unresolved, 'après', played, 'coups');
            // Un jeton peut echouer pour deux raisons opposees : AUCUN coup
            // legal ne lui correspond (le fichier decrit une autre position),
            // ou PLUSIEURS y correspondent (le fichier omet la
            // desambiguisation). Les distinguer epargne une enquete.
            await ExplainUnresolved(unresolved);
        }
        // L'issue declaree par le fichier. « * » veut dire « partie en cours »
        // et ne vaut pas un resultat : on le laisse a null, comme une partie
        // qu'on vient de commencer. Sans cela, une partie gagnee, rechargee
        // puis reexportee ressortait en « * ».
        if (book.result && book.result !== '*') gameResult = book.result;
        // Humain contre humain, en pause : sans ca l'IA du camp B rejouerait
        // par-dessus la partie chargee, et surtout des qu'on reculerait d'un
        // coup pour naviguer dans la fenetre Historique.
        //
        // SAUF si le fichier ne portait aucun coup. C'est ce que « Essayer »
        // charge : une position seule, sans sa solution. Il n'y a alors rien
        // a proteger et rien ou naviguer -- ce qu'on veut, c'est CHERCHER,
        // donc jouer pour de bon, avec l'adversaire habituel.
        // « * » veut dire partie EN COURS : le fichier ne s'arrete pas sur un
        // resultat, il s'interrompt. On rend alors la main au joueur plutot
        // que de figer le plateau -- c'est ce qu'on attend en rouvrant une
        // partie qu'on n'a pas finie.
        //
        // Avec un resultat, au contraire, il n'y a plus rien a jouer : on
        // passe en humain contre humain et en pause, sans quoi l'IA du camp B
        // rejouerait par-dessus la partie chargee, et surtout des qu'on
        // reculerait d'un coup pour naviguer dans la fenetre Historique.
        const ongoing = book.result === '*';
        if (played > 0 && !ongoing) {
            SetBothHuman();
            paused = true;
            UpdatePause();
        }
        if (played > 0 && ongoing) console.info('[play] book: partie en cours — le trait est rendu');
        // Libelle calcule par book.js (qui a les tags ET le nom du fichier).
        // Ancien affichage : "? vs ?", les tags [White]/[Black] etant absents
        // de tout fichier ecrit par Tabulon.
        UpdateFooter(book.label || gameName);
        emit(`play-event:${matchId}:move-played`, null).catch(() => {});
        console.info('[play] book: ' + played + ' coups rejoués');
    }

    // Si fork : charger la position sauvegardee par la fenetre parente.
    // Cas particulier : payload {book} déposé par book.js → rejeu PGN/PJN.
    if (forkId) {
        const saveData = await store?.get('fork:' + forkId).catch(() => null);
        if (saveData?.book) {
            await BookReplay(saveData.book);
            store?.delete('fork:' + forkId).catch(() => {});
        } else if (saveData?.solution) {
            // Solution de probleme chargee depuis un fichier JSON : c'est deja
            // le format de joclyMatch.save(), donc rien a interpreter. On MET
            // EN PAUSE -- sinon l'IA jouerait aussitot par-dessus la solution
            // qu'on vient d'ouvrir -- et on previent la fenetre Historique,
            // qui n'a aucun autre moyen de savoir que des coups existent.
            try {
                // Le mode est relu dans la sauvegarde et retenu pour la suite :
                // la navigation dans l'Historique rechargera la position, et
                // chaque rechargement doit reposer l'option.
                if (saveData.solution.tsume) {
                    tsumeMatch = true;
                    console.info('[play] solution: position de tsume');
                }
                await joclyMatch.load({ ...saveData.solution, tsume: tsumeMatch });
                // Meme regle que pour un livre : une sauvegarde sans coup est
                // une POSITION, pas une partie a relire. On la laisse jouable.
                if ((saveData.solution.playedMoves || []).length > 0) {
                    SetBothHuman();
                    paused = true;
                    UpdatePause();
                }
                emit(`play-event:${matchId}:move-played`, null).catch(() => {});
            } catch (e) {
                console.warn('[play] solution: chargement refuse:', e.message || e);
                UpdateFooter(t('play.loadFailed'));
            }
            store?.delete('fork:' + forkId).catch(() => {});
        } else if (saveData) {
            if (saveData.tsume) tsumeMatch = true;
            await joclyMatch.load({ ...saveData, tsume: tsumeMatch })
                .catch(e => console.warn('[play] fork load failed:', e));
            store?.delete('fork:' + forkId).catch(() => {});
        }
    }

    // Si invite : rejoindre -- ou heberger -- une partie via un lien
    // d'invitation jocly-simple-match (voir invitation.js). "player" dans le
    // lien/la creation est le cote que JE joue localement -- l'AUTRE cote
    // est donc distant, avec le codec compatible control.js.
    console.info('[play] inviteId depuis l\'URL :', inviteId);
    if (inviteId) {
        const invite = await store?.get('invite:' + inviteId).catch(() => null);
        console.info('[play] invite lu depuis le store :', invite);
        if (invite?.matchId && (invite?.relayUrl || invite?.peer)) {
            const remoteSide = invite.player === 'b' ? Jocly.PLAYER_A : Jocly.PLAYER_B;
            const localSide  = invite.player === 'b' ? Jocly.PLAYER_B : Jocly.PLAYER_A;
            players[localSide] = null;
            await activateRemoteSide(remoteSide, invite.peer ? {
                // Pair-a-pair : la session est deja etablie (voir
                // invitation.js) ; les deux cotes sont forcement Tabulon,
                // donc enveloppe 'tabulon' -- pas de codec jocly-simple-match.
                remote: true, peer: true, matchId: invite.matchId,
                gameName: invite.gameName || gameName,
            } : {
                remote: true, matchId: invite.matchId, relayUrl: invite.relayUrl,
                codec: 'jocly-simple-match', gameName: invite.gameName || gameName,
            });
            syncFooterSelect(localSide);
            console.info('[play] joueur distant configure sur le cote', remoteSide, players[remoteSide]);
            if (invite.creator) {
                // On vient de creer cette partie (Invitation > Create) : on
                // publie tout de suite l'etat de depart (avant meme notre
                // premier coup), pour que le relai ne soit jamais "vide" si
                // l'autre joueur ouvre son lien avant qu'on ait joue --
                // fileio.php renvoie une erreur PHP (pas du JSON) pour un
                // identifiant jamais sauvegarde, ce qui fait planter le
                // JSON.parse du client jocly-simple-match reel (bug cote
                // relai, mais qu'on peut eviter cote nous).
                const startState = await joclyMatch.save().catch(() => null);
                remoteChannel?.push({ nbTurns: 0, lastMove: null, state: startState })
                    .catch(e => console.warn('[play] publication de l\'etat initial échouée :', e.message || e));
            }
        } else {
            console.warn('[play] invite: donnees introuvables pour', inviteId);
        }
        store?.delete('invite:' + inviteId).catch(() => {});
    }

    // Câblage des fenêtres satellites : elles envoient des events Tauri
    // vers play.html pour lire/modifier l'état du match (view options, players,
    // historique, coups possibles). play.html répond en émettant un event retour.
    // Convention : requête  = 'play-req:{matchId}:{action}'
    //              réponse  = 'play-rep:{matchId}:{action}'
    initSatelliteListeners();

    UpdatePause();
    await twu.ready();
    gameLoop();
});
