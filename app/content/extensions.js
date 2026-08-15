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
import { save as saveDialog, openDialog, ask, open as openExternal } from './tauri-bridge.js';
import { initI18n, t, getLocale } from './tabulon-i18n.js';
import { pickLocalized } from './localized-field.js';
import twu from './tabulon-winutils.js';

// Site où les extensions publiées seront téléchargeables (README « Extensions »).
const EXT_SITE = 'https://fhoudebert.github.io/tabulon/ext/';

let allGames = [];   // [{name, title, summary, module}]
let currentTab = 'games';   // 'games' | 'modules'
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

// Vue Modules : regroupement des jeux de l'index par module, avec export et
// désinstallation AU NIVEAU MODULE (dossier games/<module>/ entier + toutes
// ses entrées d'index). L'import reste unique : le manifeste décide du type.
function renderModules() {
    const filter = document.getElementById('ext-filter').value.trim().toLowerCase();
    const ul = document.getElementById('ext-list');
    ul.textContent = '';
    const byModule = new Map();
    for (const g of allGames) {
        if (!byModule.has(g.module)) byModule.set(g.module, []);
        byModule.get(g.module).push(g);
    }
    for (const [mod, games] of [...byModule.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (filter && !mod.toLowerCase().includes(filter)) continue;
        const li = document.createElement('li');
        li.className = 'list-group-item ext-item';

        const info = document.createElement('div');
        info.className = 'ext-item-info';
        const title = document.createElement('strong');
        title.textContent = mod;
        const meta = document.createElement('div');
        meta.className = 'ext-item-meta';
        meta.textContent = t('ext.moduleGames', { count: games.length });
        info.append(title, meta);

        const actions = document.createElement('div');
        actions.className = 'ext-item-actions';
        const btnExport = document.createElement('button');
        btnExport.className = 'btn btn-default';
        btnExport.textContent = t('ext.export');
        btnExport.addEventListener('click', () => exportModule(mod));
        const btnRemove = document.createElement('button');
        btnRemove.className = 'btn btn-negative';
        btnRemove.textContent = t('ext.remove');
        btnRemove.disabled = !distWritable;
        btnRemove.addEventListener('click', () => removeModule(mod, games.length));
        actions.append(btnExport, btnRemove);

        li.append(info, actions);
        ul.append(li);
    }
}

function render() {
    if (currentTab === 'modules') return renderModules();
    const filter = document.getElementById('ext-filter').value.trim().toLowerCase();
    const ul = document.getElementById('ext-list');
    ul.textContent = '';
    for (const g of allGames) {
        if (filter && !(`${g.title} ${g.name} ${g.module} ${g.summary}`.toLowerCase().includes(filter))) continue;
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
        if (g.summary) {
            const summary = document.createElement('div');
            summary.className = 'ext-item-summary';
            summary.textContent = g.summary;
            info.append(summary);
        }

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
    // Le resume d'un jeu peut etre une chaine ou un objet {locale: texte}
    // (manifeste traduit) : on le reduit A L'ENTREE, comme dans hub.js, pour
    // que l'affichage et le filtre manipulent une vraie chaine.
    const loc = getLocale();
    allGames = (r.games || [])
        .map(g => ({ ...g, summary: pickLocalized(g.summary, loc) }))
        .sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name));
    document.getElementById('ext-dist-path').textContent = r.path || '';
    render();
}

async function exportGame(g) {
    try {
        const dest = await saveDialog({
            defaultPath: `${g.name}.tabulon-ext`,
            // .tabulon-ext par défaut (identité claire, filtres nets), .zip
            // proposé : le format EST un zip standard, seul le nom change.
            filters: [{ name: 'Tabulon extension', extensions: ['tabulon-ext'] },
                      { name: 'Zip', extensions: ['zip'] }],
        });
        if (!dest) return;
        const r = await tRpc.call('export_extension', g.name, dest);
        status(t('ext.exported', { game: g.title, files: r.files }));
    } catch (e) {
        status(t('ext.error', { msg: String(e) }), true);
    }
}

async function exportModule(mod) {
    try {
        const dest = await saveDialog({
            defaultPath: `${mod}.tabulon-ext`,
            filters: [{ name: 'Tabulon extension', extensions: ['tabulon-ext'] },
                      { name: 'Zip', extensions: ['zip'] }],
        });
        if (!dest) return;
        const r = await tRpc.call('export_module', mod, dest);
        status(t('ext.moduleExported', { module: mod, files: r.files, count: r.games }));
    } catch (e) {
        status(t('ext.error', { msg: String(e) }), true);
    }
}

async function removeModule(mod, count) {
    try {
        const yes = await ask(t('ext.moduleRemoveConfirm', { module: mod, count }), { kind: 'warning' });
        if (!yes) return;
        const r = await tRpc.call('remove_module', mod);
        status(t('ext.moduleRemoved', { module: mod, count: r.removed_games }));
        await reload();
        notifyHub();
    } catch (e) {
        status(t('ext.error', { msg: String(e) }), true);
    }
}

async function importExtension() {
    try {
        const src = await openDialog({
            multiple: false,
            filters: [{ name: 'Tabulon extension', extensions: ['tabulon-ext', 'zip'] }],
        });
        if (!src) return;
        const r = await tRpc.call('import_extension', src);
        if (r.type === 'module')
            status(t('ext.moduleImported', { module: r.module, count: (r.added || 0) + (r.updated || 0) }));
        else
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
    document.getElementById('ext-site').addEventListener('click', (e) => {
        e.preventDefault();
        openExternal(EXT_SITE + (currentTab === 'modules' ? 'modules' : 'games'));
    });
    for (const tab of document.querySelectorAll('.tab-item')) {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab-item').forEach(x => x.classList.remove('active'));
            tab.classList.add('active');
            currentTab = tab.dataset.tab;
            document.getElementById('ext-filter').placeholder =
                t(currentTab === 'modules' ? 'ext.searchModule' : 'ext.search');
            render();
        });
    }

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
