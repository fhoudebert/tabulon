// app/content/save-template.js
import tRpc from './tabulon-rpc.js';
import twu  from './tabulon-winutils.js';

const matchId = (function () {
    const m = /\?.*\bid=([0-9]+)/.exec(window.location.href);
    return m && m[1] || 0;
})();

const initialName = (function () {
    const m = /\?.*\bname=([0-9A-Za-z\-_]+)/.exec(window.location.href);
    return m && m[1] || 'Template-X';
})();

document.addEventListener('DOMContentLoaded', async () => {
    await twu.init(`Save #${matchId} as template`);

    const input      = document.querySelector('input');
    const btnSave    = document.getElementById('button-save');
    const btnCancel  = document.getElementById('button-cancel');

    input.value = initialName;
    input.focus();

    input.addEventListener('input', () => {
        const name = input.value.replace(/[^0-9A-Za-z\-_]/g, '');
        input.value = name;
        btnSave.disabled = true;
        tRpc.call('is_template_name_valid', name).then(valid => {
            btnSave.disabled = !valid;
        });
    });

    btnCancel.addEventListener('click', () => tRpc.close());
    btnSave.addEventListener('click', () => {
        tRpc.call('save_template', matchId, input.value).then(() => tRpc.close());
    });

    twu.ready();
});
