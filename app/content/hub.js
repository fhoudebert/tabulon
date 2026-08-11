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
import { ParseSolution, BookGame, BookVariant, FairyGameIndex, FairyVariantAlias,
         StripBookMoves, BookCommentary } from './book-format.js';
import { IsVariantsIni, ReadVariantsIni } from './fairy-variants.js';
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
// variante Fairy-Stockfish -> jeu Jocly, construit une fois depuis le
// catalogue (voir FairyGameIndex). Sert a ouvrir un PGN qui se declare par
// [Variant "shako"] plutot que par [JoclyGame "shako-chess"].
let fairyMap = {};

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
        const file = this.files[0];
        this.value = '';
        if (!file) return;
        // file.name et NON this.value : les navigateurs renvoient la
        // "C:\fakepath\" du selecteur natif, et rien du tout sous jsdom. Ce
        // nom sert de repli au libelle de la partie et au resume d'un
        // variants.ini -- avec this.value ils tombaient a vide.
        const name = file.name;
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

// Correspondance variante Fairy-Stockfish -> jeu Jocly. Construite A LA
// DEMANDE et une seule fois : elle demande de lire la config de chaque jeu du
// catalogue (une centaine), ce qui est trop cher pour le faire au demarrage
// alors que la plupart des sessions n'ouvrent jamais de fichier Fairy.
async function FairyMap() {
    if (Object.keys(fairyMap).length) return fairyMap;
    const configs = {};
    await Promise.all(Object.keys(gamesMap).map(async (n) => {
        configs[n] = await Jocly.getGameConfig(n).catch(() => null);
    }));
    fairyMap = FairyGameIndex(configs);
    console.info('[hub] variantes Fairy-Stockfish reconnues :', Object.keys(fairyMap).length);
    return fairyMap;
}

// Choisit le jeu d'un fichier : celui qu'il declare s'il existe dans le
// catalogue, sinon celui de la fiche affichee. Le fichier fait autorite parce
// que rejouer sa notation dans un AUTRE jeu ne peut pas marcher -- plateau et
// notation different, les coups seraient refuses des le premier.
function ResolveGame(declared, selected) {
    if (declared && gamesMap[declared]) return { game: declared, mismatch: !!selected && declared !== selected };
    return { game: selected || null, unknown: !!declared };
}

// `hintGame` : jeu suggere par le CONTEXTE et non par le fichier -- en
// pratique le sous-dossier de problems/ d'ou vient l'exemple. Il ne prime pas
// sur ce que le fichier declare (le fichier reste juge de son propre jeu),
// mais il remplace la fiche selectionnee comme repli, ce qui rend les
// exemples ouvrables sans avoir choisi un jeu au prealable.
async function OpenGameFile(text, fileName, hintGame) {
    const selected = (hintGame && gamesMap[hintGame]) ? hintGame : g();

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

    // 2. variants.ini de Fairy-Stockfish : ce n'est PAS une partie mais une
    //    declaration de regles. On ne peut donc pas l'"ouvrir" ; on dit ce
    //    qu'il contient, ce qui est deja la reponse a la question que se pose
    //    quelqu'un qui vient de le deposer ici.
    if (IsVariantsIni(text)) return OpenVariantsIni(text, fileName);

    // 3. PGN/PJN : on lit d'abord les tags pour savoir de quel jeu il s'agit
    //    ([JoclyGame] ecrit par Tabulon, [Game] a la main ou par des tiers,
    //    [Variant] par Fairy-Stockfish et les serveurs d'echecs).
    let declared = null;
    try {
        const matches = await tRpc.call('parse_pjn', text);
        const tags = matches?.[0]?.tags;
        declared = BookGame(tags);
        if (!declared || !gamesMap[declared]) {
            // Repechage. `declared` lui-meme est essaye comme nom de
            // variante : les deux nomenclatures se ressemblent assez pour
            // qu'on ecrive [JoclyGame "knightmate"] en croyant nommer un jeu
            // Jocly, alors que "knightmate" est le nom Fairy-Stockfish et que
            // le jeu s'appelle "knightmate-chess". Le catalogue tranche.
            const variant = FairyVariantAlias(BookVariant(tags) || declared);
            const mapped = variant ? (await FairyMap())[variant] : null;
            if (mapped) {
                console.info('[hub]', variant, 'est une variante Fairy-Stockfish — jeu Jocly :', mapped);
                declared = mapped;
            }
        }
    } catch (e) { console.warn('[hub] parse_pjn:', e.message || e); }

    const r = ResolveGame(declared, selected);
    if (!r.game) return Notify(r.unknown ? t('hub.loadUnknownGame') : t('hub.loadNoGame'));
    if (r.mismatch) console.info('[hub] le fichier designe', r.game, '— ouvert dans ce jeu');
    await store.set('book:' + r.game, { fileName, data: text });
    tRpc.call('open_book', r.game, fileName, '');
}

// Un variants.ini de Fairy-Stockfish ne contient aucune partie : c'est un
// fichier de REGLES. On ne fait donc pas semblant de l'ouvrir. Ce qu'on en
// tire de concret aujourd'hui, c'est la position de depart de chaque variante
// et la taille de son plateau : quand un jeu du catalogue joue deja la meme
// variante, cette position est ouvrable telle quelle.
//
// Le reste (faire jouer une variante que Jocly ne connait pas) suppose un
// module de jeu generique pilote par le moteur, cote jocly2 -- voir la note
// FAIRY-STOCKFISH du README. On le dit ici plutot que d'echouer en silence.
async function OpenVariantsIni(text, fileName) {
    const variants = ReadVariantsIni(text);
    if (!variants.length) return Notify(t('hub.iniEmpty'));
    const map = await FairyMap();
    const playable = variants.filter(v => map[v.name.toLowerCase()]);
    console.info('[hub] variants.ini :', variants.length, 'variantes,',
        playable.length, 'jouables par un jeu du catalogue :',
        playable.map(v => v.name + ' -> ' + map[v.name.toLowerCase()]).join(', '));

    SetNav('loadgame');
    document.getElementById('loadgame-pane').style.display = '';
    const status = document.getElementById('loadgame-status');
    if (status) {
        status.textContent = t('load.iniSummary', {
            file: String(fileName || '').replace(/^.*[/\\]/, ''),
            total: variants.length, playable: playable.length,
        });
    }
    // Les positions de depart des variantes reconnues deviennent des
    // vignettes lancables, au meme titre que les exemples livres.
    document.getElementById('loadgame-tabs').innerHTML = '';
    RenderSamples(playable.slice(0, 12).map(v => ({
        game: map[v.name.toLowerCase()],
        kind: 'position',
        fileName: v.name + '.pjn',
        text: '[JoclyGame "' + map[v.name.toLowerCase()] + '"]\n[Event "' + v.name + '"]\n'
            + (v.startFen ? '[FEN "' + v.startFen.replace(/"/g, "'") + '"]\n[SetUp "1"]\n' : '')
            + '[PlyCount "0"]\n\n',
    })));
}

// ── Ecran "Charger une partie" ────────────────────────────────────────────────
//
// Le clic sur l'entree de la barre laterale ouvrait directement le selecteur
// de fichier natif, sans un mot d'explication : rien ne disait quels formats
// passent, ni qu'un meme bouton accepte aussi bien un livre de plusieurs
// parties qu'un probleme d'une position et neuf coups.
//
// Les exemples ne sont plus ecrits en dur : ils viennent du dossier externe
// `problems/` (voir src-tauri/src/commands/problem_cmds.rs), un sous-dossier
// par jeu = un onglet. Consequence assumee : sans ce dossier, l'ecran n'a
// aucun exemple a montrer. Il dit alors ou le poser, ce qui est plus utile
// qu'une poignee d'exemples figes qu'on ne peut ni completer ni remplacer.

let problemGroups = [];      // [{ name, count }] -- un onglet chacun
let problemsDir   = null;    // chemin resolu, affiche a l'utilisateur
let problemTab    = null;    // onglet courant

// Rend une liste de "vignettes". Sert aux exemples du dossier ET aux
// positions extraites d'un variants.ini : meme presentation, meme circuit.
//   { game, title, fileName, text, thumbnail?, kind? }
function RenderSamples(samples) {
    const container = document.getElementById('loadgame-samples');
    if (!container) return;
    container.innerHTML = '';
    for (const sample of samples) {
        const game = gamesMap[sample.game];
        const div = document.createElement('div');
        div.className = 'loadgame-sample';
        div.innerHTML = `
            <img width="42" height="42" alt=""/>
            <div class="loadgame-sample-body">
              <div class="loadgame-sample-name"></div>
              <div class="loadgame-sample-desc"></div>
              <div class="loadgame-sample-note"></div>
              <div class="loadgame-sample-buttons">
                <button class="btn btn-positive sample-try"></button>
                <button class="btn btn-default sample-solve"></button>
              </div>
            </div>`;
        // Vignette fournie avec l'exemple, sinon miniature du jeu.
        const img = div.querySelector('img');
        let hasImage = true;
        if (sample.thumbnail) img.src = sample.thumbnail;
        else if (game) img.src = distURL(game.thumbnail);
        else { img.remove(); hasImage = false; }

        div.querySelector('.loadgame-sample-name').textContent = sample.title || sample.fileName;
        div.querySelector('.loadgame-sample-desc').textContent =
            game ? (game.title + (sample.kind ? ' — ' + t('load.kind.' + sample.kind) : ''))
                 : t('load.gameMissing', { game: sample.game });
        // L'enonce -- « Mat en 2 ici » -- vient du commentaire ecrit avant le
        // premier coup. C'est ce qu'il faut savoir AVANT de chercher, donc il
        // est sur la vignette et non derriere un clic. Tronque par le CSS,
        // lisible en entier au survol.
        const note = div.querySelector('.loadgame-sample-note');
        if (sample.blurb) { note.textContent = sample.blurb; note.title = sample.blurb; }
        else note.remove();

        // « Essayer » d'abord, et en bouton principal : un probleme est fait
        // pour etre cherche. « Resoudre » ouvre la meme position AVEC sa
        // solution rejouee -- utile, mais il ne doit pas etre le geste par
        // defaut, sinon il n'y a plus rien a trouver.
        const tryIt = div.querySelector('.sample-try');
        const solve = div.querySelector('.sample-solve');
        tryIt.textContent = t('load.try');
        solve.textContent = t('load.solve');
        tryIt.title = t('load.tryTip');
        solve.title = t('load.solveTip');
        // L'image ouvre elle aussi la position a chercher : c'est le geste
        // attendu devant une vignette, et une cible plus facile a viser.
        if (hasImage && game) {
            img.classList.add('clickable');
            img.title = t('load.tryTip');
            img.addEventListener('click', () => PlaySample(sample, true));
        }
        // Le jeu vise n'est pas installe : l'exemple reste visible -- le
        // dossier problems/ peut tres bien etre livre avant le dist qui
        // contient le jeu -- mais on ne propose pas un lancement qui ne peut
        // pas aboutir.
        if (!game) {
            for (const b of [tryIt, solve]) {
                b.disabled = true;
                b.title = t('load.gameMissing', { game: sample.game });
            }
        } else {
            tryIt.addEventListener('click', () => PlaySample(sample, true));
            solve.addEventListener('click', () => PlaySample(sample, false));
        }
        container.appendChild(div);
    }
}

// Lance un exemple. `stripped` retire les coups AVANT de passer par le
// circuit habituel : la position s'ouvre alors seule, sans sa solution, et
// play.js -- qui ne met en pause que lorsqu'il a rejoue au moins un coup --
// laisse la partie jouable contre l'adversaire habituel.
//
// Un seul chemin pour les deux boutons, et c'est exactement celui d'un
// fichier choisi a la main : si ce chemin casse un jour, les exemples cassent
// avec lui, ce qui est voulu -- ils servent aussi de banc d'essai.
async function PlaySample(sample, stripped) {
    let text = sample.text;
    if (stripped) {
        const solution = ParseSolution(text);
        text = solution
            ? JSON.stringify({ ...solution, playedMoves: [] })
            : StripBookMoves(text) || text;
    }
    try { await OpenGameFile(text, sample.fileName, sample.game); }
    catch (e) { console.error('[hub] exemple:', e); Notify(t('hub.loadFailed')); }
}

// Un onglet par sous-dossier. Le nom du sous-dossier EST le nom du jeu Jocly :
// c'est ce qui permet de dire si le jeu est installe, donc si l'exemple est
// lancable. On affiche le titre du catalogue quand il est connu, le nom brut
// du dossier sinon.
function RenderProblemTabs() {
    const tabs = document.getElementById('loadgame-tabs');
    if (!tabs) return;
    tabs.innerHTML = '';
    for (const grp of problemGroups) {
        const el = document.createElement('span');
        el.className = 'loadgame-tab' + (grp.name === problemTab ? ' active' : '');
        el.textContent = (gamesMap[grp.name]?.title || grp.name) + ' (' + grp.count + ')';
        if (!gamesMap[grp.name]) el.title = t('load.gameMissing', { game: grp.name });
        el.addEventListener('click', () => SelectProblemTab(grp.name));
        tabs.appendChild(el);
    }
}

async function SelectProblemTab(name) {
    problemTab = name;
    RenderProblemTabs();
    const container = document.getElementById('loadgame-samples');
    if (container) container.textContent = t('common.loading');
    let entries = [];
    try { entries = await tRpc.call('read_problem_group', name) || []; }
    catch (e) { console.error('[hub] problems:', e); if (container) container.textContent = t('hub.loadFailed'); return; }
    RenderSamples(await Promise.all(entries.map(Describe)));
}

// Titre et enonce d'un exemple, lus dans le fichier. Le nom de fichier
// (« matOpera.pgn ») n'apprend rien ; [Event] porte le nom que l'auteur a
// donne au probleme, et le commentaire d'introduction porte la consigne.
async function Describe(entry) {
    const base = {
        game: entry.group,
        title: entry.file,
        fileName: entry.file,
        text: entry.text,
        thumbnail: entry.thumbnail || null,
        blurb: null,
    };
    // Une sauvegarde JSON ne porte ni tag ni commentaire : rien a en tirer.
    if (ParseSolution(entry.text)) return base;
    let matches = [];
    try { matches = await tRpc.call('parse_pjn', entry.text) || []; }
    catch (e) { console.warn('[hub] description de', entry.file, ':', e.message || e); return base; }
    if (!matches.length) return base;

    const title = (matches[0].tags?.Event || '').trim();
    if (title) base.title = title;
    // Fichier a plusieurs problemes : le dire, le titre du premier seul
    // serait trompeur.
    if (matches.length > 1) base.blurb = t('load.severalGames', { n: matches.length });
    else {
        const intro = BookCommentary(matches[0].text).find(x => !x.move && x.comment);
        if (intro) base.blurb = intro.comment;
    }
    return base;
}

// Chargé une seule fois : le dossier ne bouge pas en cours de session, et
// relire les vignettes à chaque ouverture de l'écran serait gratuit.
async function LoadProblems() {
    if (problemGroups.length) return;
    let r;
    try { r = await tRpc.call('list_problem_groups'); }
    catch (e) { console.warn('[hub] problems:', e.message || e); return; }
    problemsDir   = r?.dir || null;
    problemGroups = r?.groups || [];
    console.info('[hub] exemples :', problemGroups.length, 'groupe(s) dans', problemsDir || '(aucun dossier)');
}

async function ShowLoadGame() {
    SetNav('loadgame');
    document.getElementById('loadgame-pane').style.display = '';
    const status = document.getElementById('loadgame-status');
    if (status) status.textContent = '';
    await LoadProblems();
    RenderProblemTabs();

    // Le chemin resolu est affiche meme quand le dossier existe : c'est la
    // seule facon pour l'utilisateur de savoir ou deposer un fichier de plus.
    const where = document.getElementById('loadgame-samples-intro');
    if (where) {
        where.textContent = problemsDir
            ? t('load.samplesFrom', { dir: problemsDir })
            : t('load.samplesNone');
    }
    if (problemGroups.length) await SelectProblemTab(problemTab && problemGroups.some(g => g.name === problemTab)
        ? problemTab : problemGroups[0].name);
    else RenderSamples([]);
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
    document.getElementById('nav-loadgame').addEventListener('click', ShowLoadGame);
    document.getElementById('loadgame-choose')?.addEventListener('click', () => {
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
