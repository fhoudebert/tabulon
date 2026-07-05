// app/content/view-options.js
// Fenetre satellite : options de vue (skin, sons, notation, etc.)
// Communique avec play.html via Tauri events (play-req/play-rep:{matchId}:*).

import tRpc from './tabulon-rpc.js';
import { initI18n, t } from './tabulon-i18n.js';
import twu  from './tabulon-winutils.js';
import { listen, emit } from './tauri-bridge.js';

const matchId = parseInt(new URLSearchParams(window.location.search).get('id') || '0', 10);

let viewConfig = {};

function supports3D() {
    try { return !!window.WebGLRenderingContext &&
          !!document.createElement('canvas').getContext('experimental-webgl'); }
    catch { return false; }
}

function ApplyOptions(data) {
    const { options, config } = data;
    viewConfig = config;

    const skinWrap = document.getElementById('skin');
    const skinSel  = skinWrap?.querySelector('select');
    if (skinSel && config.skins) {
        skinSel.innerHTML = '';
        config.skins.filter(s => supports3D() || !s['3d']).forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.name; opt.textContent = s.title;
            skinSel.appendChild(opt);
        });
        skinWrap.classList.remove('hidden');
        skinSel.value = options.skin || skinSel.options[0]?.value;
    }

    const soundsWrap = document.getElementById('sounds');
    soundsWrap?.classList.remove('hidden');
    const soundsInput = soundsWrap?.querySelector('input');
    if (soundsInput) soundsInput.checked = !!options.sounds;

    const notationWrap = document.getElementById('notation');
    if (config.useNotation) {
        notationWrap?.classList.remove('hidden');
        const inp = notationWrap?.querySelector('input');
        if (inp) inp.checked = !!options.notation;
    }

    const autoWrap = document.getElementById('autoComplete');
    if (config.useAutoComplete) {
        autoWrap?.classList.remove('hidden');
        const inp = autoWrap?.querySelector('input');
        if (inp) inp.checked = !!options.autoComplete;
    }

    const showWrap = document.getElementById('showMoves');
    if (config.useShowMoves) {
        showWrap?.classList.remove('hidden');
        const inp = showWrap?.querySelector('input');
        if (inp) inp.checked = !!options.showMoves;
    }

    const anaWrap = document.getElementById('anaglyph');
    anaWrap?.classList.remove('hidden');
    const anaInput = anaWrap?.querySelector('input');
    if (anaInput) anaInput.checked = !!options.anaglyph;
}

function ReadOptions() {
    const config = viewConfig;
    const opts = {
        skin:     document.querySelector('#skin select')?.value,
        sounds:   !!document.querySelector('#sounds input')?.checked,
        anaglyph: !!document.querySelector('#anaglyph input')?.checked,
    };
    if (config.useNotation)     opts.notation     = !!document.querySelector('#notation input')?.checked;
    if (config.useAutoComplete) opts.autoComplete = !!document.querySelector('#autoComplete input')?.checked;
    if (config.useShowMoves)    opts.showMoves    = !!document.querySelector('#showMoves input')?.checked;
    return opts;
}

document.addEventListener('DOMContentLoaded', async () => {
    await initI18n();
    await twu.init(t('viewOptions.title', { id: matchId }));

    // Recevoir la reponse de play.html
    listen('play-rep:' + matchId + ':get-view-options', ({ payload }) => {
        ApplyOptions(payload);
        twu.ready();
    });

    // Appliquer immediatement chaque changement
    document.querySelector('.view-options')?.addEventListener('change', () => {
        emit('play-req:' + matchId + ':set-view-options', ReadOptions());
    });

    document.getElementById('button-close')?.addEventListener('click', () => tRpc.close());

    // Demander les options actuelles a play.html
    await emit('play-req:' + matchId + ':get-view-options', null);
});
