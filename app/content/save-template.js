// app/content/save-template.js
import tRpc from './tabulon-rpc.js';
import { initI18n, t } from './tabulon-i18n.js';
import twu  from './tabulon-winutils.js';
import { listen, emit } from './tauri-bridge.js';

const matchId = (function () {
    const m = /\?.*\bid=([0-9]+)/.exec(window.location.href);
    return m && m[1] || 0;
})();

const initialName = (function () {
    const m = /\?.*\bname=([0-9A-Za-z\-_]+)/.exec(window.location.href);
    return m && m[1] || 'Template-X';
})();

// Données du template, fournies par play.js (satellite get-template-data)
let templateData = null;

document.addEventListener('DOMContentLoaded', async () => {
    await initI18n();
    await twu.init(t('saveTemplate.title', { id: matchId }));

    const input      = document.querySelector('input');
    const btnSave    = document.getElementById('button-save');
    const btnCancel  = document.getElementById('button-cancel');

    // Récupérer l'état de la partie auprès de play.js — sans lui, rien à
    // sauvegarder (l'ancien flux Rust stockait un placeholder {matchId} inutile)
    await listen(`play-rep:${matchId}:get-template-data`, ({ payload }) => {
        templateData = payload;
        Validate();
    });
    await emit(`play-req:${matchId}:get-template-data`, null);

    input.value = initialName;
    input.focus();

    function Validate() {
        const name = input.value.replace(/[^0-9A-Za-z\-_]/g, '');
        input.value = name;
        btnSave.disabled = true;
        if (!templateData || !name) return;
        tRpc.call('is_template_name_valid', name).then(valid => {
            btnSave.disabled = !valid || !templateData;
        });
    }
    input.addEventListener('input', Validate);
    Validate();   // valider aussi le nom initial (aucun événement input au chargement)

    btnCancel.addEventListener('click', () => tRpc.close());
    btnSave.addEventListener('click', () => {
        // matchId en Number : la commande Rust attend un u32 (une String
        // ferait échouer la désérialisation en silence, cf. fork_id)
        tRpc.call('save_template', Number(matchId), input.value, {
            ...templateData,
            lastUsed: Date.now(),
        }).then(() => tRpc.close())
          .catch(e => console.warn('[save-template]', e));
    });

    twu.ready();
});
