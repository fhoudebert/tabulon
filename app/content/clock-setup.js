// app/content/clock-setup.js
import tRpc  from './tabulon-rpc.js';
import twu   from './tabulon-winutils.js';
import { Store } from './tauri-bridge.js';

const gameName = (function () {
    const m = /\?.*\bgame=([^&]+)/.exec(window.location.href);
    return m && m[1] || 'classic-chess';
})();

let selectedPlayer = 0;
let store;

function UpdateSymmetry(symmetry) {
    symmetry = symmetry || document.querySelector('.symmetry').value;
    document.querySelectorAll('.form-group').forEach(el => el.style.display = 'none');
    if (symmetry === 'same') {
        document.querySelectorAll('.form-group.group-same').forEach(el => el.style.display = '');
    } else {
        document.querySelectorAll('.form-group.group-different.player-sel').forEach(el => el.style.display = '');
        document.querySelectorAll('.player-selector').forEach(el => el.classList.remove('highlighted'));
        document.querySelector('.player-selector.player' + selectedPlayer).classList.add('highlighted');
        document.querySelectorAll('.form-group.group-different.player' + selectedPlayer)
            .forEach(el => el.style.display = '');
    }
}

function SetForm(setup) {
    document.querySelector('.symmetry').value = setup.symmetry;
    UpdateSymmetry(setup.symmetry);
    document.querySelector('.group-same input.time').value   = setup.timing.same.value;
    document.querySelector('.group-same select.unit').value  = setup.timing.same.factor;
    document.querySelector('.group-same input.xtrasec').value = setup.timing.same.xtrasec;
    document.querySelector('.group-same input.mps').value    = setup.timing.same.mps;
    [0, 1].forEach((which) => {
        document.querySelector(`.group-different.player${which} input.time`).value    = setup.timing.different[which].value;
        document.querySelector(`.group-different.player${which} select.unit`).value   = setup.timing.different[which].factor;
        document.querySelector(`.group-different.player${which} input.xtrasec`).value = setup.timing.different[which].xtrasec;
        document.querySelector(`.group-different.player${which} input.mps`).value     = setup.timing.different[which].mps;
    });
}

// Les champs time/xtrasec/mps d'un même réglage sont répartis sur PLUSIEURS
// .form-group frères (un par champ). Il faut donc des sélecteurs descendants
// sur tout le document (`.group-same input.xtrasec`), pas des recherches dans
// le premier .form-group trouvé : l'ancien code faisait
// `document.querySelector('.group-same')` (→ uniquement le groupe Time) puis
// `g.querySelector('input.xtrasec')` (→ null → exception → GetClock() null),
// ce qui laissait le bouton Play grisé en permanence.
function GetTiming(prefix) {
    const value = parseInt(document.querySelector(`${prefix} input.time`).value);
    if (isNaN(value) || value <= 0) throw new Error('invalid time');
    return 1000 * value * parseInt(document.querySelector(`${prefix} select.unit`).value);
}

function GetClock() {
    const clock = { mode: 'countdown' };
    const symmetry = document.querySelector('.symmetry').value;
    const num = (sel) => parseInt(document.querySelector(sel).value) || 0;
    try {
        // PLAYER_A=1, PLAYER_B=-1 (constantes Jocly, pas besoin que Jocly soit charge)
        if (symmetry === 'same') {
            clock[1] = clock[-1] = GetTiming('.group-same');
            clock['xtrasec_1'] = clock['xtrasec_-1'] = num('.group-same input.xtrasec');
            clock['mps_1']     = clock['mps_-1']     = num('.group-same input.mps');
        } else {
            [[0, 1], [1, -1]].forEach(([which, player]) => {
                const prefix = `.group-different.player${which}`;
                clock[player]              = GetTiming(prefix);
                clock['xtrasec_' + player] = num(`${prefix} input.xtrasec`);
                clock['mps_' + player]     = num(`${prefix} input.mps`);
            });
        }
        return clock;
    } catch (e) { return null; }
}

function OnChange() {
    UpdateSymmetry(document.querySelector('.symmetry').value);
    const ok = !!GetClock();
    const btn = document.getElementById('button-save');
    btn.classList.toggle('disabled', !ok);
    btn.disabled = !ok;
}

document.addEventListener('DOMContentLoaded', async () => {
    store = await Store.load('tabulon.json');

    await Jocly.getGameConfig(gameName)
        .then(config => twu.init(config.model['title-en'] + ' clock setup'));

    document.querySelectorAll('.player-selector').forEach(el => {
        el.addEventListener('click', function () {
            selectedPlayer = this.classList.contains('player0') ? 0 : 1;
            UpdateSymmetry();
        });
    });

    document.getElementById('button-save').addEventListener('click', async () => {
        const clock = GetClock();
        if (!clock) return;
        const sym = document.querySelector('.symmetry').value;
        await store.set('clock', {
            symmetry: sym,
            timing: {
                same: {
                    value:   document.querySelector('.group-same input.time').value,
                    factor:  document.querySelector('.group-same select.unit').value,
                    xtrasec: document.querySelector('.group-same input.xtrasec').value,
                    mps:     document.querySelector('.group-same input.mps').value,
                },
                different: [0, 1].map(which => ({
                    value:   document.querySelector(`.group-different.player${which} input.time`).value,
                    factor:  document.querySelector(`.group-different.player${which} select.unit`).value,
                    xtrasec: document.querySelector(`.group-different.player${which} input.xtrasec`).value,
                    mps:     document.querySelector(`.group-different.player${which} input.mps`).value,
                }))
            }
        });
        await store.save();
        await tRpc.call('new_match', gameName, clock);
        tRpc.close();
    });

    document.getElementById('button-cancel').addEventListener('click', () => tRpc.close());

    // Charger les réglages persistés
    const saved = await store.get('clock');
    const setup = Object.assign({
        symmetry: 'same',
        timing: { same: {}, different: [{}, {}] }
    }, saved || {});
    Object.assign(setup.timing.same, { value: 5, factor: 60, xtrasec: 0, mps: 0 }, setup.timing.same);
    [0, 1].forEach(w => {
        setup.timing.different[w] = Object.assign({ value: 5, factor: 60, xtrasec: 0, mps: 0 }, setup.timing.different[w] || {});
    });
    SetForm(setup);

    document.querySelector('.clock-setup-content').addEventListener('change', OnChange);
    document.querySelector('.clock-setup-content').addEventListener('input',  OnChange);
    OnChange();

    twu.ready();
});
