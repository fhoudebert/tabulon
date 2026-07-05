// app/content/clock.js
//
// Fenêtre satellite : affichage de l'horloge du match.
// L'état de l'horloge vit dans play.js (modèle JoclyBoard où il vivait dans
// le main process). Communication par events Tauri :
//   requête  : emit('play-req:{matchId}:get-clock')
//   réponse  : listen('play-rep:{matchId}:get-clock', {players, clock})
//   push     : listen('play-event:{matchId}:update-clock', {players, clock})
//              (émis par play.js à chaque changement de tour / fin de partie)
// L'ancien tRpc.call('get_clock') invoquait une commande Rust qui n'existe
// pas → promise rejeté → fenêtre vide.
import twu from './tabulon-winutils.js';
import { initI18n, t } from './tabulon-i18n.js';
import { listen, emit } from './tauri-bridge.js';

const matchId = (function () {
    const m = /\?.*\bid=([0-9]+)/.exec(window.location.href);
    return m && m[1] || 0;
})();

let timers = {}, clock = null;
let started = false;

function TimeFormat(ms) {
    let text = '';
    if (ms < 0) { text += '-'; ms = -ms; }
    const secs  = Math.floor(ms / 1000);
    const mins  = Math.floor(secs / 60) % 60;
    const hours = Math.floor(secs / 3600);
    const s     = secs % 60;
    if (hours > 0) text += hours + ':' + (mins < 10 ? '0' : '');
    text += mins + ':' + (s < 10 ? '0' : '') + s;
    return text;
}

function Update() {
    [Jocly.PLAYER_A, Jocly.PLAYER_B].forEach((which) => {
        let timer;
        if (clock && typeof clock[which] !== 'undefined') {
            let ms = clock[which];
            if (clock.turn === which)
                ms = clock.mode === 'countdown'
                    ? ms - (Date.now() - clock.t0)
                    : ms + (Date.now() - clock.t0);
            timer = TimeFormat(ms);
        } else {
            timer = '--:--';
        }
        if (timer !== timers[which]) {
            timers[which] = timer;
            document.getElementById('clock-time' + which).textContent = timer;
        }
    });
}

// Applique un état {players, clock} reçu de play.js (réponse ou push)
function ApplyClock({ players, clock: _clock }) {
    clock = _clock;
    document.querySelectorAll('.players > div, .times > div')
        .forEach(el => el.classList.remove('turn'));
    [Jocly.PLAYER_A, Jocly.PLAYER_B].forEach((which) => {
        document.getElementById('clock-player' + which).textContent = players[which].name;
        if (clock && clock.turn === which) {
            document.getElementById('clock-player' + which).classList.add('turn');
            document.getElementById('clock-time'   + which).classList.add('turn');
        }
    });
    Update();
    if (!started) {
        started = true;
        setInterval(Update, 100);
        twu.ready();
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await initI18n();
    await twu.init(t('clock.title', { id: matchId }));

    [Jocly.PLAYER_A, Jocly.PLAYER_B].forEach((which) => {
        const pd = document.createElement('div');
        pd.id = 'clock-player' + which;
        document.querySelector('.clock .players').appendChild(pd);

        const td = document.createElement('div');
        td.id = 'clock-time' + which;
        document.querySelector('.clock .times').appendChild(td);
    });

    await listen(`play-rep:${matchId}:get-clock`,      ({ payload }) => ApplyClock(payload));
    await listen(`play-event:${matchId}:update-clock`, ({ payload }) => ApplyClock(payload));
    await emit(`play-req:${matchId}:get-clock`, null);
});
