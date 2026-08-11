// app/content/hub.js  —  Fenêtre principale Tabulon
//
// Navigation unifiée : liste des jeux à gauche + panneau de détail à droite
// (fusion de l'ancien game.html/game.js — la fiche jeu ne s'ouvre plus dans
// une fenêtre séparée, la sélection est une navigation interne JS).
import tRpc       from './tabulon-rpc.js';
import twu        from './tabulon-winutils.js';
import { open, Store, listen } from './tauri-bridge.js';
import { initI18n, t, getLocale } from './tabulon-i18n.js';
import { pickLocalized } from './localized-field.js';
import { ParseSolution, BookGame } from './book-format.js';
import { parseInvitationUrl } from './remote-relay-protocol.js';
import { joinPeerMatch } from './remote-peer-channel.js';

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
// Jeu selectionne, au moment de l'appel. Fonction et non valeur : les
// gestionnaires d'evenements sont lies UNE FOIS au chargement, ils doivent
// lire currentGame a chaque clic et non le null du demarrage. Defini ici, au
// niveau du module, et non dans InitDetailButtons() : OpenGameFile() s'en
// sert aussi, et une copie locale y etait invisible (ReferenceError a
// l'ouverture d'un fichier).
const g = () => currentGame;
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
        li.innerHTML = `
            <img class="media-object pull-left" src="${distURL(game.thumbnail)}" width="48" height="48"/>
            <div class="media-body"><strong>${game.title}</strong><p>${game.summary}</p></div>
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
        ul.appendChild(li);
    });
}

async function ListGames() {
    const games = await Jocly.listGames();
    // Le resume d'un jeu peut etre une chaine ou un objet {locale: texte}
    // (comme le champ "rules" du manifeste). On le reduit A L'ENTREE, une
    // seule fois : tout ce qui suit -- liste, panneau de detail, filtre
    // (qui fait .toLowerCase() dessus) -- manipule alors une vraie chaine.
    const loc = getLocale();
    for (const n of Object.keys(games)) {
        games[n] = { ...games[n], summary: pickLocalized(games[n].summary, loc) };
    }
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
    document.querySelector('#game-detail .game-summary').textContent =
        pickLocalized(config.model.summary, getLocale());
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
    const required = ['quickplay', 'clockedplay', 'invitation', 'info', 'boardstate',
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

    document.getElementById('quickplay').addEventListener('click',   () => g() && tRpc.call('new_match', g()));
    document.getElementById('clockedplay').addEventListener('click', () => g() && tRpc.call('open_clock_setup', g()));
    document.getElementById('invitation').addEventListener('click',  () => g() && tRpc.call('open_invitation', g()));
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

    document.getElementById('openbook').addEventListener('click', () => {
        if (g()) document.getElementById('fileElem').click();
    });

    // Retour liste sur écran étroit
    document.getElementById('detail-back').addEventListener('click', () => {
        document.getElementById('game-list-pane').classList.remove('show-detail');
    });
}

// Ouverture d'un fichier de partie. Deux points d'entree, meme circuit : le
// bouton "Ouvrir un livre" de la fiche (un jeu est selectionne) et l'entree
// "Charger une partie" de la barre laterale (aucun jeu choisi -- c'est alors
// le fichier qui doit dire de quel jeu il s'agit).
//
// Cable a part de InitDetailButtons() : celle-ci abandonne en bloc si un
// SEUL element du panneau de detail manque, ce qui laissait aussi "Charger
// une partie" sans gestionnaire alors que ce chemin ne depend pas du detail.
function InitFileInput() {
    const input = document.getElementById('fileElem');
    if (!input) { console.error('[hub] #fileElem absent — chargement de fichier indisponible'); return; }
    input.addEventListener('change', function () {
        const name = this.value;
        const file = this.files[0];
        this.value = '';
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (e) => {
            try { await OpenGameFile(e.target.result, name); }
            catch (err) {
                console.error('[hub] chargement:', err);
                Notify(t('hub.loadFailed'));
            }
        };
        reader.readAsText(file);
    });
}

// Message dans la banniere du bas (meme zone que les notifications poussees
// depuis Rust), avec un lien pour la refermer.
function Notify(text) {
    const notifier = document.querySelector('.hub-notifier');
    if (!notifier) { console.warn('[hub]', text); return; }
    document.querySelectorAll('.hub-notifier > *').forEach(el => el.style.display = 'none');
    const el = document.querySelector('.hub-notifier-text');
    el.style.display = ''; el.textContent = text;
    const ok = document.querySelector('.hub-notifier-ok');
    ok.style.display = ''; ok.textContent = t('common.close');
    ok.onclick = () => { notifier.classList.add('hidden'); ok.onclick = null; };
    notifier.classList.remove('hidden');
}

// Choisit le jeu d'un fichier : celui qu'il declare s'il existe dans le
// catalogue, sinon celui de la fiche affichee. Le fichier fait autorite parce
// que rejouer sa notation dans un AUTRE jeu ne peut pas marcher -- plateau et
// notation different, les coups seraient refuses des le premier.
function ResolveGame(declared, selected) {
    if (declared && gamesMap[declared]) return { game: declared, mismatch: !!selected && declared !== selected };
    return { game: selected || null, unknown: !!declared };
}

async function OpenGameFile(text, fileName) {
    const selected = g();

    // 1. Solution/sauvegarde Jocly (JSON) : deja au format de joclyMatch.load().
    const solution = ParseSolution(text);
    if (solution) {
        const r = ResolveGame(solution.game, selected);
        if (!r.game) return Notify(t('hub.loadNoGame'));
        if (r.mismatch) console.info('[hub] le fichier designe', r.game, '— ouvert dans ce jeu');
        const id = 'sol-' + Date.now();
        await store.set('fork:' + id, { solution });
        return tRpc.call('new_match', r.game, null, id);
    }

    // 2. PGN/PJN : on lit d'abord les tags pour savoir de quel jeu il s'agit
    //    ([JoclyGame] ecrit par Tabulon, [Game] a la main ou par des tiers).
    let declared = null;
    try {
        const matches = await tRpc.call('parse_pjn', text);
        declared = BookGame(matches?.[0]?.tags);
    } catch (e) { console.warn('[hub] parse_pjn:', e.message || e); }

    const r = ResolveGame(declared, selected);
    if (!r.game) return Notify(r.unknown ? t('hub.loadUnknownGame') : t('hub.loadNoGame'));
    if (r.mismatch) console.info('[hub] le fichier designe', r.game, '— ouvert dans ce jeu');
    await store.set('book:' + r.game, { fileName, data: text });
    tRpc.call('open_book', r.game, fileName, '');
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
            <img class="media-object pull-left" src="${distURL(game.thumbnail || '')}" width="48" height="48"/>
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
// ── Panneau Invitation (côté invité) ──────────────────────────────────────────
//
// Sous-ensemble INVITÉ de la fenêtre Invitation (invitation.js) : rejoindre
// une partie dont l'identifiant vient d'ailleurs. Les deux chemins ci-dessous
// tirent le nom du jeu de la saisie elle-même -- aucun jeu n'a besoin d'être
// sélectionné, ce qui est justement le cas d'usage d'un invité.
// Les chemins CRÉATEUR (Create sur le relai, hébergement d'un code p2p)
// restent dans la fenêtre Invitation : ils exigent un jeu choisi.
function InitInvitationPane() {
    const urlInput      = document.getElementById('hub-invitation-url');
    const joinStatus    = document.getElementById('hub-invitation-status');
    const codeInput     = document.getElementById('hub-peer-code-input');
    const peerStatus    = document.getElementById('hub-peer-join-status');
    if (!urlInput || !codeInput) return;   // hub.html obsolète : mode dégradé

    const setStatus = (el, text, cls) => {
        if (!el) return;
        el.textContent = text || '';
        el.className = 'invitation-status' + (cls ? ' ' + cls : '');
    };

    // Même dépôt "invite:{id}" + new_match(..., inviteId) que invitation.js :
    // play.js lit ce store au démarrage.
    async function startMatch({ gameName, matchId, relayUrl, player, peer }) {
        const inviteId = 'inv-' + Date.now();
        await store.set('invite:' + inviteId, { matchId, relayUrl, gameName, player, creator: false, peer: !!peer });
        await tRpc.call('new_match', gameName, null, undefined, inviteId);
    }

    document.getElementById('hub-button-join')?.addEventListener('click', async () => {
        const parsed = parseInvitationUrl(urlInput.value || '');
        if (!parsed) { setStatus(joinStatus, t('invitation.invalidLink'), 'fail'); return; }
        setStatus(joinStatus, '');
        try { await startMatch(parsed); }
        catch (e) {
            console.warn('[hub] join invitation failed:', e.message || e);
            setStatus(joinStatus, String(e.message || e), 'fail');
        }
    });

    document.getElementById('hub-button-peer-join')?.addEventListener('click', async () => {
        const raw = codeInput.value || '';
        if (!raw.trim()) { setStatus(peerStatus, t('invitation.peerInvalidCode'), 'fail'); return; }
        setStatus(peerStatus, t('invitation.peerConnecting'), '');
        try {
            const { gameName, token } = await joinPeerMatch(raw);
            await startMatch({ gameName, matchId: 'p2p:' + token.slice(0, 12), player: 'b', peer: true });
            setStatus(peerStatus, '');
        } catch (e) {
            console.warn('[hub] peer join failed:', e.message || e);
            setStatus(peerStatus,
                e.message === 'code d\'invitation invalide'
                    ? t('invitation.peerInvalidCode') : t('invitation.peerConnectFail'), 'fail');
        }
    });
}

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
    // Import/désinstallation d'extension : l'index du dist a changé, mais le
    // BrowserScriptLoader de Jocly CACHE jocly-allgames.js pour la durée de
    // vie de la page (cache[url] fermé sur le module) — relancer ListGames()
    // relirait l'index périmé. Seul un rechargement de la page repart d'un
    // cache vierge ; le hub restaure ensuite sa navigation depuis le store.
    extensionsChanged: () => {
        location.reload();
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
    document.getElementById('nav-loadgame').addEventListener('click', () => {
        document.getElementById('fileElem').click();
    });
    document.getElementById('nav-invitation').addEventListener('click', () => {
        SetNav('invitation'); document.getElementById('invitation-pane').style.display = '';
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
    try { InitInvitationPane(); }
    catch (e) { console.error('[hub] InitInvitationPane:', e); }
    try { InitDetailButtons(); }
    catch (e) { detailAvailable = false; console.error('[hub] InitDetailButtons:', e); }
    try { InitFileInput(); }
    catch (e) { console.error('[hub] InitFileInput:', e); }

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
