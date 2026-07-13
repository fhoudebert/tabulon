// app/content/hub.js  —  Fenêtre principale Tabulon
//
// Navigation unifiée : liste des jeux à gauche + panneau de détail à droite
// (fusion de l'ancien game.html/game.js — la fiche jeu ne s'ouvre plus dans
// une fenêtre séparée, la sélection est une navigation interne JS).
import tRpc       from './tabulon-rpc.js';
import twu        from './tabulon-winutils.js';
import { open, Store, listen } from './tauri-bridge.js';
import { initI18n, t, getLocale } from './tabulon-i18n.js';

// Réécrit un chemin d'asset vers le dist externe si actif (window.__distURL
// est fourni par asset-rewrite.js ; sinon chemin inchangé).
function distURL(u) { return (window.__distURL ? window.__distURL(u) : u); }

let store;
let gameList = [], gamesMap = {};
let allGameList = [], favGameList = [], templateList = [];
let favoritesMap = {};   // gameName -> timestamp ; état des étoiles de la liste
let filterTimer = null;
let appInfo = { name: 'Tabulon', version: '', homepage: '' };

// ── Panneau de détail (ex-game.js) ────────────────────────────────────────────
let currentGame = null;     // gameName actuellement affiché dans le détail
let visualTimer = null;     // interval de rotation des visuels 600x600
// Passe à false si hub.html ne contient pas le panneau de détail (fichier
// obsolète / cache) : le hub reste alors utilisable en mode dégradé (liste
// + raccourcis) au lieu de planter avant ListGames().
let detailAvailable = true;

const defaultFavorites = {
    'classic-chess': 100, 'draughts': 90, 'scrum': 80, 'reversi': 70,
    '9-men-morris': 65, 'fourinarow': 60, 'tafl-hnefatafl': 55,
    'yohoho': 50, 'margo6': 40, 'pensoc': 30,
};

// ── Filtrage ──────────────────────────────────────────────────────────────────
function Filter() {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(DoFilter, 200);
}
function DoFilter(q) {
    const str = document.getElementById('gamefilter').value;
    q = q || { title: str, summary: str, module: str };
    document.querySelectorAll('#game-list li.list-group-item').forEach(li => {
        const game = gamesMap[li.dataset.game];
        if (!game) return;
        const show = Object.entries(q).some(([k, v]) =>
            v === '' || (game[k] || '').toLowerCase().includes(v.toLowerCase()));
        li.style.display = show ? '' : 'none';
    });
}

// ── Listes de jeux ────────────────────────────────────────────────────────────
function UpdateGameList() {
    const ul = document.getElementById('game-list');
    ul.querySelectorAll('.list-group-item').forEach(el => el.remove());
    gameList.forEach(game => {
        const li = document.createElement('li');
        li.className = 'list-group-item object-list-item';
        li.dataset.game = game.gameName;
        if (game.gameName === currentGame) li.classList.add('active');
        const isFav = !!favoritesMap[game.gameName];
        li.innerHTML = `
            <img class="media-object pull-left" src="${game.thumbnail}" width="48" height="48"/>
            <div class="media-body"><strong>${game.title}</strong><p>${game.summary}</p></div>
            <div title="${isFav ? t('tip.unfavorite') : t('tip.favorite')}" class="media-object pull-right list-shortcut list-shortcut-fav">
                <span class="icon ${isFav ? 'icon-star' : 'icon-star-empty'}"></span>
            </div>
            <div title="${t('tip.rules')}" class="media-object pull-right list-shortcut list-shortcut-info">
                <span class="icon icon-info-circled"></span>
            </div>
            <div title="${t('tip.quickPlay')}" class="media-object pull-right list-shortcut list-shortcut-play">
                <span class="icon icon-play"></span>
            </div>`;
        li.addEventListener('click', () => SelectGame(game.gameName));
        const shortcut = (sel, fn) => li.querySelector(sel).addEventListener('click', (e) => {
            e.stopPropagation();
            fn();
        });
        shortcut('.list-shortcut-play',  () => tRpc.call('new_match', game.gameName));
        shortcut('.list-shortcut-info',  () => tRpc.call('open_info', game.gameName));
        shortcut('.list-shortcut-fav',   async () => {
            const nowFav = !favoritesMap[game.gameName];
            // Optimiste : refléter l'étoile tout de suite ; le push
            // updateFavorites de Rust réconciliera l'état.
            if (nowFav) favoritesMap[game.gameName] = Date.now();
            else        delete favoritesMap[game.gameName];
            const icon = li.querySelector('.list-shortcut-fav .icon');
            icon.className = 'icon ' + (nowFav ? 'icon-star' : 'icon-star-empty');
            li.querySelector('.list-shortcut-fav').title = nowFav ? t('tip.unfavorite') : t('tip.favorite');
            await tRpc.call('set_favorite', game.gameName, nowFav);
            if (game.gameName === currentGame) UpdateDetailFavorite();
        });
        ul.appendChild(li);
    });
}

async function ListGames() {
    const games = await Jocly.listGames();
    gamesMap = games;
    allGameList = Object.keys(games)
        .map(n => ({ gameName: n, ...games[n] }))
        .sort((a, b) => a.title.localeCompare(b.title));

    // Nettoyer les favoris par défaut qui n'existent pas
    for (const g in defaultFavorites)
        if (!gamesMap[g]) delete defaultFavorites[g];

    await UpdateFavoriteGames();   // alimente favoritesMap pour les étoiles

    const navLast = await store.get('nav-last') || 'games-fav';
    document.getElementById('nav-' + navLast)?.click();
}

async function UpdateFavoriteGames(favorites) {
    favorites = favorites || await store.get('favoriteGames') || defaultFavorites;
    favoritesMap = favorites;
    favGameList = Object.keys(favorites)
        .map(n => ({ gameName: n, lastSet: favorites[n] || 0, ...gamesMap[n] }))
        .sort((a, b) => b.lastSet - a.lastSet);
}

// ── Panneau de détail : sélection d'un jeu ────────────────────────────────────
//
// Remplace tRpc.call('open_game', gameName) — plus aucune fenêtre ouverte,
// la fiche est rendue dans le panneau droit du hub.
//
// opts.reveal : sur écran étroit (tablette portrait), true bascule la vue
// liste → détail (classe .show-detail). false pour la restauration au
// démarrage, afin de ne pas masquer la liste sans action de l'utilisateur.
async function SelectGame(gameName, opts = {}) {
    if (!detailAvailable || !gamesMap[gameName]) return;
    currentGame = gameName;
    store.set('last-game', gameName);

    // Surligner l'élément sélectionné dans la liste
    document.querySelectorAll('#game-list li.list-group-item').forEach(li =>
        li.classList.toggle('active', li.dataset.game === gameName));

    if (opts.reveal !== false)
        document.getElementById('game-list-pane').classList.add('show-detail');

    const config = await Jocly.getGameConfig(gameName);
    if (currentGame !== gameName) return;   // sélection changée entre-temps

    document.getElementById('game-detail-empty').style.display = 'none';
    document.getElementById('game-detail-body').style.display  = '';

    document.querySelector('#game-detail .game-title').textContent = config.model['title-en'];
    document.querySelector('#game-detail .game-summary').textContent = config.model.summary;
    document.querySelector('#game-detail .game-thumbnail').style.backgroundImage =
        `url(${distURL(config.view.fullPath + '/' + config.model.thumbnail)})`;

    SetupVisuals(config.view);
    await UpdateDetailFavorite();
    await UpdateDetailTemplates();
}

// Visuels animés 600x600 (rotation crossfade toutes les 5 s), repris de
// l'ancienne game.html. Contrairement à game.js (une fenêtre par jeu),
// il faut nettoyer l'interval et le conteneur à chaque changement de jeu.
function SetupVisuals(view) {
    clearInterval(visualTimer);
    visualTimer = null;
    const container = document.querySelector('#game-detail .visuals > div');
    container.innerHTML = '';

    if (!view.visuals?.['600x600']) return;
    const visuals = [view.visuals['600x600']].flat().map(v => distURL(view.fullPath + '/' + v));

    visuals.forEach((url, index) => {
        const div = document.createElement('div');
        div.dataset.index = index;
        div.style.backgroundImage = `url(${url})`;
        div.style.opacity = '0';
        container.appendChild(div);
    });

    let visualIndex = -1;
    function NextVisual() {
        visualIndex = (visualIndex + 1) % visuals.length;
        container.querySelectorAll('div').forEach(el => el.style.opacity = '0');
        container.querySelector(`div[data-index="${visualIndex}"]`).style.opacity = '1';
    }
    NextVisual();
    if (visuals.length > 1)
        visualTimer = setInterval(NextVisual, 5000);
}

async function UpdateDetailFavorite() {
    if (!currentGame) return;
    const fav = await tRpc.call('is_favorite', currentGame);
    document.getElementById('favorite').style.display   = fav ? 'none' : '';
    document.getElementById('unfavorite').style.display = fav ? '' : 'none';
}

// Templates filtrés par le jeu sélectionné (repris de game.js)
async function UpdateDetailTemplates() {
    if (!currentGame) return;
    const templates = await store.get('templates') || {};
    const block     = document.querySelector('#game-detail .templates-block');
    const container = document.querySelector('#game-detail .templates');
    container.innerHTML = '';
    const list = Object.entries(templates)
        .map(([name, t]) => ({ templateName: name, ...t }))
        .filter(t => t.gameName === currentGame)
        .sort((a, b) => b.lastUsed - a.lastUsed);
    block.style.display = list.length ? '' : 'none';
    list.forEach(template => {
        const div = document.createElement('div');
        div.className = 'template';
        div.textContent = template.templateName;
        div.addEventListener('click', () => PlayTemplate(template.templateName));
        container.appendChild(div);
    });
}

// Boutons d'action du panneau de détail — liés une seule fois au chargement,
// ils opèrent sur currentGame.
function InitDetailButtons() {
    // hub.js et hub.html doivent être de la même version. Si le panneau de
    // détail manque (ancien hub.html encore servi), on désactive le panneau
    // avec un message actionnable au lieu de laisser un TypeError bloquer
    // tout le DOMContentLoaded (et donc le chargement de la liste des jeux).
    const required = ['quickplay', 'clockedplay', 'info', 'boardstate',
        'favorite', 'unfavorite', 'fileElem', 'openbook', 'detail-back',
        'game-detail-body', 'game-detail-empty'];
    const missing = required.filter(id => !document.getElementById(id));
    if (missing.length) {
        detailAvailable = false;
        console.error('[hub] hub.html obsolète — éléments manquants :', missing.join(', '),
            '\nLe panneau de détail est désactivé. Vérifier que app/content/hub.html',
            'est à jour, puis supprimer src-tauri/target/ (assets embarqués périmés) et relancer.');
        return;
    }

    const g = () => currentGame;
    document.getElementById('quickplay').addEventListener('click',   () => g() && tRpc.call('new_match', g()));
    document.getElementById('clockedplay').addEventListener('click', () => g() && tRpc.call('open_clock_setup', g()));
    document.getElementById('info').addEventListener('click',        () => g() && tRpc.call('open_info', g()));
    document.getElementById('boardstate').addEventListener('click',  () => g() && tRpc.call('open_board_state', g()));

    document.getElementById('favorite').addEventListener('click', async () => {
        if (!g()) return;
        await tRpc.call('set_favorite', g(), true);
        UpdateDetailFavorite();
    });
    document.getElementById('unfavorite').addEventListener('click', async () => {
        if (!g()) return;
        await tRpc.call('set_favorite', g(), false);
        UpdateDetailFavorite();
    });

    document.getElementById('fileElem').addEventListener('change', function () {
        if (!g()) return;
        const reader = new FileReader();
        reader.readAsText(this.files[0]);
        reader.onload = async (e) => {
            // Le contenu passe par le store (trop gros pour l'URL) :
            // book.js le lira et le parsera via la commande Rust parse_pjn.
            await store.set('book:' + g(), { fileName: this.value, data: e.target.result });
            tRpc.call('open_book', g(), this.value, '');
        };
        this.value = '';
    });
    document.getElementById('openbook').addEventListener('click', () => {
        if (g()) document.getElementById('fileElem').click();
    });

    // Retour liste sur écran étroit
    document.getElementById('detail-back').addEventListener('click', () => {
        document.getElementById('game-list-pane').classList.remove('show-detail');
    });
}

// ── Templates ─────────────────────────────────────────────────────────────────
// Lance une partie depuis un template : play_template (Rust) retourne les
// données sauvegardées {gameName, gameData, clock} et marque lastUsed ;
// on transmet gameData par le canal fork puis new_match. L'ancien code
// appelait play_template et ignorait le retour : rien ne se lançait.
async function PlayTemplate(templateName) {
    const tpl = await tRpc.call('play_template', templateName).catch(e => {
        console.warn('[hub] play_template:', e);
        return null;
    });
    if (!tpl?.gameName) return;
    if (tpl.gameData) {
        const id = 'tpl-' + Date.now();
        await store.set('fork:' + id, tpl.gameData);
        tRpc.call('new_match', tpl.gameName, tpl.clock || null, id);
    } else {
        tRpc.call('new_match', tpl.gameName, tpl.clock || null);
    }
}

async function UpdateTemplates(templates) {
    templates = templates || await store.get('templates') || {};
    templateList = Object.keys(templates)
        .map(n => ({ templateName: n, ...templates[n] }))
        .sort((a, b) => b.lastUsed - a.lastUsed);
}

function UpdateTemplateList() {
    const ul = document.getElementById('template-list');
    ul.querySelectorAll('.list-group-item').forEach(el => el.remove());
    templateList.forEach(template => {
        const game = gamesMap[template.gameName] || {};
        const li = document.createElement('li');
        li.className = 'list-group-item object-list-item';
        li.dataset.template = template.templateName;
        li.innerHTML = `
            <img class="media-object pull-left" src="${game.thumbnail || ''}" width="48" height="48"/>
            <div class="media-body"><strong>${template.templateName}</strong><p>${game.title || ''}</p></div>
            <div title="${t('tip.removeTemplate')}" class="media-object pull-right list-shortcut list-shortcut-del">
                <span class="icon icon-cancel"></span>
            </div>`;
        li.addEventListener('click', () => PlayTemplate(template.templateName));
        li.querySelector('.list-shortcut').addEventListener('click', (e) => {
            e.stopPropagation();
            tRpc.call('remove_template', template.templateName);
        });
        ul.appendChild(li);
    });
}

// ── About ─────────────────────────────────────────────────────────────────────
function RenderAbout() {
    document.querySelectorAll('.appName').forEach(el => el.textContent = appInfo.name);
    document.querySelectorAll('.appVersion').forEach(el => el.textContent = appInfo.version);
    // Locale retenue (déduite du système), ex. "Français (fr)"
    document.querySelectorAll('.appLocale').forEach(el =>
        el.textContent = `${t('lang.' + getLocale())} (${getLocale()})`);
    // Le panneau About (réécrit côté HTML) contient des <a href> directs :
    // dans une webview Tauri, un clic les ferait naviguer DANS la fenêtre.
    // On les intercepte pour les ouvrir dans le navigateur système.
    document.querySelectorAll('#about a[href]').forEach(el => {
        if (el.dataset.extBound) return;   // RenderAbout peut être rappelé
        el.dataset.extBound = '1';
        el.style.cursor = 'pointer';
        el.addEventListener('click', (e) => { e.preventDefault(); open(el.getAttribute('href')); });
    });
}

// ── Navigation ────────────────────────────────────────────────────────────────
function SetNav(which) {
    document.querySelectorAll('.sidebar .nav-group-item').forEach(el => el.classList.remove('active'));
    document.getElementById('nav-' + which)?.classList.add('active');
    store.set('nav-last', which);
    document.querySelectorAll('.object-pane > .pane').forEach(el => el.style.display = 'none');
}

// ── notifyUser (push depuis Rust) ─────────────────────────────────────────────
// Le Rust émet "notifyUser" + token ; on affiche la bannière et on répond
// via invoke("notify_user_response", { token, result })
listen('notifyUser', ({ payload }) => {
    const { token, text, okText, koText } = payload;
    const notifier = document.querySelector('.hub-notifier');
    document.querySelectorAll('.hub-notifier > *').forEach(el => el.style.display = 'none');

    if (text)   { const el = document.querySelector('.hub-notifier-text'); el.style.display = ''; el.textContent = text; }
    if (okText) {
        const el = document.querySelector('.hub-notifier-ok');
        el.style.display = ''; el.textContent = okText;
        el.onclick = () => { notifier.classList.add('hidden'); tRpc.call('notify_user_response', token, true); el.onclick = null; };
    }
    if (koText) {
        const el = document.querySelector('.hub-notifier-ko');
        el.style.display = ''; el.textContent = koText;
        el.onclick = () => { notifier.classList.add('hidden'); tRpc.call('notify_user_response', token, false); el.onclick = null; };
    }
    notifier.classList.remove('hidden');
});

// Events de mise à jour depuis Rust
tRpc.listen({
    updateFavorites: async (favorites) => {
        await UpdateFavoriteGames(favorites);
        if (await store.get('nav-last') === 'games-fav') gameList = favGameList;
        UpdateGameList();           // re-rendre : les étoiles changent aussi dans All
        UpdateDetailFavorite();     // synchroniser le bouton Favorite du détail
    },
    // Import/désinstallation d'une extension : l'index du dist externe a
    // changé → relister les jeux (ListGames se termine par un clic sur la nav
    // courante, qui re-rend la liste).
    extensionsChanged: async () => {
        await ListGames();
    },
    updateTemplates: async (templates) => {
        await UpdateTemplates(templates);
        if (await store.get('nav-last') === 'templates') UpdateTemplateList();
        UpdateDetailTemplates();    // synchroniser les templates du détail
    },
    // update-available vient du plugin updater
});

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    console.info('[hub] DOMContentLoaded — start');
    await initI18n();   // locale système, avant tout rendu dynamique
    store   = await Store.load('tabulon.json');
    console.info('[hub] store loaded');
    appInfo = await tRpc.call('get_app_info');
    console.info('[hub] app info loaded:', appInfo);

    document.getElementById('nav-games-all').addEventListener('click', async () => {
        SetNav('games-all'); document.getElementById('game-list-pane').style.display = '';
        gameList = allGameList; UpdateGameList();
    });
    document.getElementById('nav-games-fav').addEventListener('click', async () => {
        SetNav('games-fav'); document.getElementById('game-list-pane').style.display = '';
        await UpdateFavoriteGames(); gameList = favGameList; UpdateGameList();
    });
    document.getElementById('nav-templates').addEventListener('click', async () => {
        SetNav('templates'); document.getElementById('template-list').style.display = '';
        await UpdateTemplates(); UpdateTemplateList();
    });
    // Écran Extensions : fenêtre dédiée, pas un panneau du hub (la nav
    // courante ne change pas).
    document.getElementById('nav-extensions').addEventListener('click', () => {
        tRpc.call('open_extensions');
    });

    document.getElementById('nav-about').addEventListener('click', () => {
        SetNav('about'); document.getElementById('about').style.display = '';
        RenderAbout();
    });

    document.getElementById('gamefilter').addEventListener('input', Filter);
    try { InitDetailButtons(); }
    catch (e) { detailAvailable = false; console.error('[hub] InitDetailButtons:', e); }

    // Garde : si ../browser/jocly.js n'a pas chargé (dist/ absent des assets
    // embarqués — build fait sans dist/ ou avec un src-tauri/target périmé),
    // afficher la cause dans l'interface au lieu d'une liste vide muette.
    if (typeof Jocly === 'undefined') {
        console.error('[hub] window.Jocly absent : ../browser/jocly.js n\'a pas chargé.',
            'Causes probables : dist/ manquant au moment du build, ou src-tauri/target',
            'périmé (assets embarqués sans dist) — supprimer target/ et rebuilder.');
        document.getElementById('game-list-pane').style.display = '';
        const ul = document.getElementById('game-list');
        const li = document.createElement('li');
        li.className = 'list-group-item';
        li.innerHTML = '<div class="media-body"><strong></strong><p></p></div>';
        li.querySelector('strong').textContent = t('hub.joclyMissing');
        li.querySelector('p').textContent = t('hub.joclyMissingHint');
        ul.appendChild(li);
        RenderAbout();
        await twu.init(appInfo.name + ' ' + appInfo.version);
        twu.ready();
        return;
    }

    console.info('[hub] calling ListGames()');
    await ListGames();
    console.info('[hub] ListGames() done — allGameList has', allGameList.length, 'games');

    // Restaurer la dernière fiche consultée (sans basculer la vue tablette)
    const lastGame = await store.get('last-game');
    if (lastGame && gamesMap[lastGame])
        SelectGame(lastGame, { reveal: false });

    RenderAbout();
    await twu.init(appInfo.name + ' ' + appInfo.version);
    twu.ready();
});
