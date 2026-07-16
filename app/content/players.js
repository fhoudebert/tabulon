// app/content/players.js
// Fenetre satellite : configuration des joueurs (humain / IA niveau X /
// distant). Communique avec play.html via Tauri events
// (play-req/play-rep:{matchId}:*).

import tRpc from './tabulon-rpc.js';
import { initI18n, t, translateLevelLabel } from './tabulon-i18n.js';
import twu  from './tabulon-winutils.js';
import { listen, emit, httpFetch } from './tauri-bridge.js';
import { DEFAULT_RELAY_URL, buildLoadBody } from './remote-relay-protocol.js';

const matchId = parseInt(new URLSearchParams(window.location.search).get('id') || '0', 10);
// Preserve codec/gameName (ex. venus d'une invitation jocly-simple-match)
// tant que le match id n'est pas change ici -- le formulaire ne les affiche
// pas, on ne veut pas les perdre silencieusement a un simple Save.
const lastReceivedRemote = { a: null, b: null };

function BuildSelect(sel, levels, currentType, currentLevelIndex) {
    sel.innerHTML = '';
    const optHuman = document.createElement('option');
    optHuman.value = 'human'; optHuman.textContent = t('common.human');
    sel.appendChild(optHuman);
    levels.forEach((lvl, i) => {
        const opt = document.createElement('option');
        opt.value = 'ai:' + i;
        opt.textContent = translateLevelLabel(lvl.label) || lvl.name || t('common.level', { n: i + 1 });
        sel.appendChild(opt);
    });
    const optRemote = document.createElement('option');
    optRemote.value = 'remote'; optRemote.textContent = t('common.remote');
    sel.appendChild(optRemote);

    sel.value = currentType === 'ai' && currentLevelIndex >= 0 ? 'ai:' + currentLevelIndex
        : currentType === 'remote' ? 'remote'
        : 'human';
}

// Affiche/masque les champs match-id/relay-url selon le type sélectionné, et
// pré-remplit l'URL du relai par défaut si le champ est vide.
function SyncRemoteFields(form) {
    const sel = form.querySelector('select');
    const remoteFields = form.querySelector('.remote-fields');
    const relayInput = form.querySelector('.relay-url');
    const show = sel.value === 'remote';
    if (remoteFields) remoteFields.style.display = show ? '' : 'none';
    if (show && relayInput && !relayInput.value) relayInput.value = DEFAULT_RELAY_URL;
}

document.addEventListener('DOMContentLoaded', async () => {
    await initI18n();
    await twu.init(t('players.title', { id: matchId }));

    // Libellés des champs distants (placeholders + boutons) -- pas
    // gérés par data-i18n dans le HTML statique, posés ici comme le reste
    // du texte dynamique de cette fenêtre.
    document.querySelectorAll('.match-id').forEach(el => el.placeholder = t('players.matchId'));
    document.querySelectorAll('.relay-url').forEach(el => el.placeholder = t('players.relayUrl'));
    document.querySelectorAll('.btn-copy').forEach(el => el.textContent = t('players.copy'));
    document.querySelectorAll('.btn-test').forEach(el => el.textContent = t('players.test'));

    listen('play-rep:' + matchId + ':get-players', ({ payload }) => {
        const { levels, players } = payload;
        ['a', 'b'].forEach(which => {
            const key  = which === 'a' ? 1 : -1;  // PLAYER_A=1, PLAYER_B=-1
            const form = document.querySelector('.players-' + which);
            const sel  = form?.querySelector('select');
            if (!sel) return;
            const info = players[key] || {};
            BuildSelect(sel, levels, info.type, info.levelIndex);
            const nameInput = form.querySelector('input[type=text]:not(.match-id):not(.relay-url)');
            if (nameInput) nameInput.value = which === 'a' ? t('common.playerA') : t('common.playerB');
            const matchIdInput = form.querySelector('.match-id');
            const relayInput   = form.querySelector('.relay-url');
            if (info.type === 'remote') {
                if (matchIdInput) matchIdInput.value = info.matchId || '';
                // Cote pair-a-pair : pas de relai du tout -- champ laisse
                // vide plutot que d'afficher une URL de relai qui ne sert pas.
                if (relayInput)   relayInput.value   = info.peer ? '' : (info.relayUrl || DEFAULT_RELAY_URL);
                // Retenu pour Save : si le match id n'est pas modifié dans ce
                // formulaire, on rend au moteur le codec/gameName d'origine
                // (ex. jocly-simple-match venu d'une invitation) plutôt que
                // de le faire silencieusement retomber sur notre codec par
                // défaut, qui casserait l'interop avec l'autre client.
                lastReceivedRemote[which] = { matchId: info.matchId, codec: info.codec, gameName: info.gameName, peer: !!info.peer };
            } else {
                lastReceivedRemote[which] = null;
            }
            SyncRemoteFields(form);
        });
        twu.ready();
    });

    // Bascule d'affichage des champs distants + copie du match id
    document.querySelectorAll('.players-a, .players-b').forEach(form => {
        form.querySelector('select')?.addEventListener('change', () => SyncRemoteFields(form));
        form.querySelector('.btn-copy')?.addEventListener('click', async () => {
            const input = form.querySelector('.match-id');
            const btn = form.querySelector('.btn-copy');
            if (!input?.value || !btn) return;
            try {
                await navigator.clipboard.writeText(input.value);
                const original = btn.textContent;
                btn.textContent = t('players.copied');
                setTimeout(() => { btn.textContent = original; }, 1200);
            } catch (e) {
                console.warn('[players] clipboard write failed:', e.message || e);
            }
        });
        form.querySelector('.btn-test')?.addEventListener('click', async () => {
            const relayUrl = form.querySelector('.relay-url')?.value.trim() || DEFAULT_RELAY_URL;
            const matchIdVal = form.querySelector('.match-id')?.value.trim() || 'tabulon-test';
            const status = form.querySelector('.remote-test-status');
            if (status) { status.textContent = t('players.testChecking'); status.className = 'remote-test-status'; }
            try {
                const res = await httpFetch(relayUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: buildLoadBody(matchIdVal).toString(),
                });
                await res.text();   // le contenu importe peu ici -- seule l'atteignabilité compte
                if (status) { status.textContent = t('players.testOk'); status.className = 'remote-test-status ok'; }
            } catch (e) {
                console.warn('[players] test relay failed:', e.message || e);
                if (status) { status.textContent = t('players.testFail'); status.className = 'remote-test-status fail'; }
            }
        });
    });

    document.getElementById('button-cancel')?.addEventListener('click', () => tRpc.close());

    document.getElementById('button-save')?.addEventListener('click', async () => {
        const result = {};
        ['a', 'b'].forEach(which => {
            const key  = which === 'a' ? 1 : -1;
            const form = document.querySelector('.players-' + which);
            const sel  = form?.querySelector('select');
            if (!sel) return;
            const val  = sel.value;
            if (val === 'human') {
                result[key] = { type: 'human', levelIndex: -1 };
            } else if (val === 'remote') {
                const matchIdVal = form.querySelector('.match-id')?.value.trim();
                const relayUrlVal = form.querySelector('.relay-url')?.value.trim() || DEFAULT_RELAY_URL;
                if (matchIdVal) {
                    const prev = lastReceivedRemote[which];
                    const unchanged = prev && prev.matchId === matchIdVal;
                    // Meme regle de preservation que codec/gameName : un cote
                    // pair-a-pair (etabli par la fenetre Invitation) reste
                    // pair-a-pair tant que le match id n'est pas modifie ici
                    // -- sinon Save le degraderait silencieusement en config
                    // relai (le formulaire n'a pas de notion de p2p).
                    result[key] = (unchanged && prev.peer) ? {
                        type: 'remote', peer: true, matchId: matchIdVal,
                        gameName: prev.gameName,
                    } : {
                        type: 'remote', matchId: matchIdVal, relayUrl: relayUrlVal,
                        codec: unchanged ? prev.codec : 'tabulon',
                        gameName: unchanged ? prev.gameName : undefined,
                    };
                } else {
                    result[key] = { type: 'human', levelIndex: -1 };  // pas d'id -> repli humain
                }
            } else {
                const idx = parseInt(val.replace('ai:', ''), 10);
                result[key] = { type: 'ai', levelIndex: idx };
            }
        });
        await emit('play-req:' + matchId + ':set-players', result);
        tRpc.close();
    });

    await emit('play-req:' + matchId + ':get-players', null);
});
