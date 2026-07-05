// app/content/game.js
import tRpc  from './tabulon-rpc.js';
import twu   from './tabulon-winutils.js';
import { Store } from './tauri-bridge.js';

const gameName = (function () {
    const m = /\?.*\bgame=([^&]+)/.exec(window.location.href);
    return m && m[1] || 'classic-chess';
})();

let store, gamesMap = {};

// ── Visuels animés ────────────────────────────────────────────────────────────
let visuals = [], visualIndex = 0;

function SetupVisuals(view) {
    if (!view.visuals?.['600x600']) return;
    visuals = [view.visuals['600x600']].flat().map(v => view.fullPath + '/' + v);
    const container = document.querySelector('.visuals > div');
    visuals.forEach((url, index) => {
        const div = document.createElement('div');
        div.dataset.index = index;
        div.style.backgroundImage = `url(${url})`;
        div.style.opacity = '0';
        container.appendChild(div);
    });
    function NextVisual() {
        visualIndex = (visualIndex + 1) % visuals.length;
        container.querySelectorAll('div').forEach(el => el.style.opacity = '0');
        container.querySelector(`div[data-index="${visualIndex}"]`).style.opacity = '1';
    }
    setInterval(NextVisual, 5000);
    NextVisual();
}

// ── Infos du jeu ──────────────────────────────────────────────────────────────
async function UpdateFavorite() {
    const fav = await tRpc.call('is_favorite', gameName);
    document.getElementById('favorite').style.display   = fav ? 'none' : '';
    document.getElementById('unfavorite').style.display = fav ? '' : 'none';
}

async function SetupInfo(config) {
    document.querySelector('.game-title').textContent = config.model['title-en'];
    document.querySelector('.game-thumbnail').style.backgroundImage =
        `url(${config.view.fullPath}/${config.model.thumbnail})`;
    document.querySelector('.game-summary').textContent = config.model.summary;

    await UpdateFavorite();

    document.getElementById('favorite').addEventListener('click', async () => {
        await tRpc.call('set_favorite', gameName, true);
        UpdateFavorite();
    });
    document.getElementById('unfavorite').addEventListener('click', async () => {
        await tRpc.call('set_favorite', gameName, false);
        UpdateFavorite();
    });
    document.getElementById('quickplay').addEventListener('click',   () => tRpc.call('new_match', gameName));
    document.getElementById('clockedplay').addEventListener('click', () => tRpc.call('open_clock_setup', gameName));
    document.getElementById('info').addEventListener('click',        () => tRpc.call('open_info', gameName));
    document.getElementById('boardstate').addEventListener('click',  () => tRpc.call('open_board_state', gameName));

    document.getElementById('fileElem').addEventListener('change', function () {
        const reader = new FileReader();
        reader.readAsText(this.files[0]);
        reader.onload = (e) => tRpc.call('open_book', gameName, this.value, e.target.result);
        this.value = '';
    });
    document.getElementById('openbook').addEventListener('click', () => {
        document.getElementById('fileElem').click();
    });
}

async function UpdateTemplates() {
    const templates = await store.get('templates') || {};
    const container = document.querySelector('.templates');
    container.innerHTML = '';
    Object.entries(templates)
        .map(([name, t]) => ({ templateName: name, ...t }))
        .filter(t => t.gameName === gameName)
        .sort((a, b) => b.lastUsed - a.lastUsed)
        .forEach(template => {
            const div = document.createElement('div');
            div.className = 'template';
            div.textContent = template.templateName;
            div.addEventListener('click', () => tRpc.call('play_template', template.templateName));
            container.appendChild(div);
        });
}

document.addEventListener('DOMContentLoaded', async () => {
    store = await Store.load('tabulon.json');
    const config = await Jocly.getGameConfig(gameName);
    await twu.init(config.model['title-en']);
    SetupVisuals(config.view);
    await SetupInfo(config);
    await UpdateTemplates();
});
