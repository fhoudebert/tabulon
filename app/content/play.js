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
                    const result = await joclyMatch.userTurn();
                    finished = result?.finished || false;
                    winner   = result?.winner;
                    playedLocally = true;

                } else {
                    // Tour IA.
                    // machineSearch() en mode proxy iframe retourne {move, ...}
                    // mais NE joue PAS le coup -- il faut appeler playMove().
                    UpdateFooter(t('play.thinking'));
                    const result = await joclyMatch.machineSearch({ level });
                    UpdateFooter('');

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
                const state = await joclyMatch.save().catch(() => null);
                remoteChannel.push({ nbTurns: moves.length, lastMove: moves[moves.length - 1] ?? null, state })
                    .catch(e => console.warn('[play] envoi du coup au relai distant échoué :', e.message || e));
            }

            if (finished) {
                ClockStop();
                UpdateFooter(winner === 0 ? t('play.draw')
                    : winner > 0 ? t('play.aWins')
                    : t('play.bWins'));
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

// -- Helpers UI ---------------------------------------------------------------
function UpdateFooter(text) {
    const el = document.getElementById('board-footer-text');
    if (el) el.textContent = text || '';
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
        await joclyMatch?.abortUserTurn().catch(() => {});
        await joclyMatch?.abortMachineSearch().catch(() => {});
        cancelRemoteWait('players reconfigured (footer)');
        if (wasRemote && ![Jocly.PLAYER_A, Jocly.PLAYER_B].some(k => players[k]?.remote))
            disposeRemoteChannel();
    });
}

// Aligne le select rapide du footer (select-player-a/-b) sur l'etat reel de
// players[key] -- humain (''), IA (index en string), ou distant ('remote').
// A appeler chaque fois que players[key] change ailleurs que par ce select
// lui-meme (invitation, fenetre Players).
function syncFooterSelect(key) {
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

    // get-played-moves : retourne l'historique des coups comme strings lisibles
    listen(prefix + 'get-played-moves', async () => {
        if (!joclyMatch) return;
        const moves = await joclyMatch.getPlayedMoves().catch(() => []);
        if (!moves || moves.length === 0) {
            await emit(`play-rep:${matchId}:get-played-moves`, { moves: [] });
            return;
        }
        // getMoveString accepte un array et retourne un array de strings
        // en une seule transaction avec l'iframe -- plus fiable que n appels
        // séquentiels où la sérialisation JSON des objets move peut les corrompre.
        const strings = await joclyMatch.getMoveString(moves).catch(() => null);
        await emit(`play-rep:${matchId}:get-played-moves`, {
            moves: Array.isArray(strings) ? strings : moves.map(() => '?')
        });
    });

    // rollback-to : annuler jusqu'a l'index demande
    listen(prefix + 'rollback-to', async ({ payload }) => {
        if (!joclyMatch) return;
        await joclyMatch.abortUserTurn().catch(() => {});
        await joclyMatch.abortMachineSearch().catch(() => {});
        cancelRemoteWait('rollback');
        await joclyMatch.rollback(payload?.index ?? 0).catch(e => console.warn('[play] rollback:', e));
        await resyncRemoteChannelBaseline();
    });

    // get-template-data : données complètes pour "Save template"
    // (save-template.html les transmet ensuite à la commande Rust save_template)
    listen(prefix + 'get-template-data', async () => {
        if (!joclyMatch) return;
        const gameData = await joclyMatch.save().catch(() => null);
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
            if (!loopActive) gameLoop();
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

    btn('button-history',  () => tRpc.call('open_history', matchId));
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
        await joclyMatch.abortUserTurn().catch(() => {});
        await joclyMatch.abortMachineSearch().catch(() => {});
        cancelRemoteWait('takeback');
        // LIMITE CONNUE : si un canal distant est actif, reculer localement
        // ne "desjoue" rien cote relai (fileio.php n'a pas de notion de
        // retrait de coup) -- la partie distante peut se retrouver
        // desynchronisee du relai jusqu'au prochain coup local repousse.
        // Pas traite a cette etape (voir DEVELOPMENT.md § Remote play).

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
    });

    btn('button-restart', async () => {
        if (!joclyMatch) return;
        await joclyMatch.abortUserTurn().catch(() => {});
        await joclyMatch.abortMachineSearch().catch(() => {});
        cancelRemoteWait('restart');
        await joclyMatch.rollback(0);
        await resyncRemoteChannelBaseline();
        paused = false;
        UpdatePause();
        UpdateFooter('');
        if (!loopActive) gameLoop();
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
            if (!loopActive) gameLoop();
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
    async function BookReplay(book) {
        let played = 0;
        for (const tok of book.moves || []) {
            let move = await joclyMatch.pickMove(tok).catch(() => null);
            if (!move) move = await joclyMatch.pickMove(tok.replace(/[+#!?]+$/, '')).catch(() => null);
            if (!move) { console.warn('[play] book: coup non résolu:', tok, 'après', played, 'coups'); break; }
            await joclyMatch.playMove(move);
            played++;
        }
        paused = true;
        UpdatePause();
        UpdateFooter(`${book.playerA || t('common.playerA')} vs ${book.playerB || t('common.playerB')}`);
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
        } else if (saveData) {
            await joclyMatch.load(saveData).catch(e => console.warn('[play] fork load failed:', e));
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
