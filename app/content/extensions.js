// app/content/extensions.js — écran de gestion des extensions.
//
// Disponible UNIQUEMENT quand un dist/ externe est actif (get_dist_info) :
// l'embarqué est en lecture seule. Trois actions, toutes côté Rust
// (commands/extension_cmds.rs), l'écran n'accédant jamais au disque lui-même :
//   - export  : jeu du dist externe → fichier <jeu>.tabulon-ext
//   - import  : fichier .tabulon-ext → dist externe + entrée d'index
//   - remove  : retrait de l'index + fichiers déclarés du jeu (les ressources
//               partagées du module ne sont jamais touchées)
// Après import/désinstallation, le hub est notifié (relay_to_window →
// extensionsChanged) pour recharger sa liste de jeux.
import tRpc from './tabulon-rpc.js';
import { save as saveDialog, openDialog, ask } from './tauri-bridge.js';
import { initI18n, t } from './tabulon-i18n.js';
import twu from './tabulon-winutils.js';

let allGames = [];   // [{name, title, summary, module}]
let distWritable = true;   // faux : dist externe en lecture seule (droits)

function status(msg, isError = false) {
    const el = document.getElementById('ext-status');
    el.textContent = msg || '';
    el.style.color = isError ? '#c00' : '';
}

function notifyHub() {
    // Fire-and-forget : le hub relit son index (ListGames) et se re-rend.
    tRpc.call('relay_to_window', 'main', 'extensionsChanged', {}).catch(() => {});
}

function render() {
    const filter = document.getElementById('ext-filter').value.trim().toLowerCase();
    const ul = document.getElementById('ext-list');
    ul.textContent = '';
    for (const g of allGames) {
        if (filter && !(`${g.title} ${g.name} ${g.module}`.toLowerCase().includes(filter))) continue;
        const li = document.createElement('li');
        li.className = 'list-group-item ext-item';

        const info = document.createElement('div');
        info.className = 'ext-item-info';
        const title = document.createElement('strong');
        title.textContent = g.title;
        const meta = document.createElement('div');
        meta.className = 'ext-item-meta';
        meta.textContent = `${g.name} — ${t('ext.module')} ${g.module}`;
        info.append(title, meta);

        const actions = document.createElement('div');
        actions.className = 'ext-item-actions';
        const btnExport = document.createElement('button');
        btnExport.className = 'btn btn-default';
        btnExport.textContent = t('ext.export');
        btnExport.addEventListener('click', () => exportGame(g));
        const btnRemove = document.createElement('button');
        btnRemove.className = 'btn btn-negative';
        btnRemove.textContent = t('ext.remove');
        btnRemove.disabled = !distWritable;   // lecture seule : export possible, pas la désinstallation
        btnRemove.addEventListener('click', () => removeGame(g));
        actions.append(btnExport, btnRemove);

        li.append(info, actions);
        ul.append(li);
    }
}

async function reload() {
    const r = await tRpc.call('list_extension_games');
    allGames = (r.games || []).slice()
        .sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name));
    document.getElementById('ext-dist-path').textContent = r.path || '';
    render();
}

async function exportGame(g) {
    try {
        const dest = await saveDialog({
            defaultPath: `${g.name}.tabulon-ext`,
            filters: [{ name: 'Tabulon extension', extensions: ['tabulon-ext'] }],
        });
        if (!dest) return;
        const r = await tRpc.call('export_extension', g.name, dest);
        status(t('ext.exported', { game: g.title, files: r.files }));
    } catch (e) {
        status(t('ext.error', { msg: String(e) }), true);
    }
}

async function importExtension() {
    try {
        const src = await openDialog({
            multiple: false,
            filters: [{ name: 'Tabulon extension', extensions: ['tabulon-ext'] }],
        });
        if (!src) return;
        const r = await tRpc.call('import_extension', src);
        status(t(r.updated ? 'ext.updated' : 'ext.imported', { game: r.game }));
        await reload();
        notifyHub();
    } catch (e) {
        status(t('ext.error', { msg: String(e) }), true);
    }
}

async function removeGame(g) {
    try {
        const yes = await ask(t('ext.removeConfirm', { game: g.title }), { kind: 'warning' });
        if (!yes) return;
        await tRpc.call('remove_extension', g.name);
        status(t('ext.removed', { game: g.title }));
        await reload();
        notifyHub();
    } catch (e) {
        status(t('ext.error', { msg: String(e) }), true);
    }
}

window.addEventListener('DOMContentLoaded', async () => {
    await initI18n();
    await twu.init(t('ext.title'));

    document.getElementById('ext-import').addEventListener('click', importExtension);
    document.getElementById('ext-filter').addEventListener('input', render);

    const info = await tRpc.call('get_dist_info').catch(() => ({ external: false }));
    if (!info || !info.external) {
        document.getElementById('ext-nodist').style.display = '';
        document.getElementById('ext-import').disabled = true;
        return;
    }
    document.getElementById('ext-main').style.display = '';
    // Dist présent mais NON inscriptible (droits, montage ro) : l'export reste
    // possible (lecture + fichier de destination choisi par l'utilisateur),
    // l'import et la désinstallation sont désactivés avec un message clair.
    distWritable = !!info.writable;
    if (!distWritable) {
        document.getElementById('ext-readonly').style.display = '';
        document.getElementById('ext-import').disabled = true;
    }
    try { await reload(); }
    catch (e) { status(t('ext.error', { msg: String(e) }), true); }
    twu.ready?.();
});
