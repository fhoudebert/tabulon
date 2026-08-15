// app/content/camera-view.js
import tRpc       from './tabulon-rpc.js';
import { initI18n, t } from './tabulon-i18n.js';
import twu        from './tabulon-winutils.js';
import { open, message as dlgMessage, ask, Store, listen, emit } from './tauri-bridge.js';

const gameName = (function () {
    const m = /\?.*\bgame=([^&]+)/.exec(window.location.href);
    return m && m[1] || 'classic-chess';
})();
const matchId = (function () {
    const m = /\?.*\bid=([0-9]+)/.exec(window.location.href);
    return m && m[1] || 0;
})();

let viewPoints = [], viewPointsIndex = 1;
let speeds = [], speedsIndex = 1, selectedSpeed = 0;
let store;

function SaveViewPoints() { store.set('camera-view:' + gameName, viewPoints); store.save(); }
function SaveSpeeds()     { store.set('camera-view-speeds:' + gameName, speeds); store.save(); }

function AddViewPoint(camera, id, title) {
    id = id || viewPointsIndex++;
    const vp = { id, title: title || 'View point #' + id, camera };
    viewPoints.push(vp);

    const li = document.createElement('li');
    li.innerHTML = `<span>${vp.title}</span>`;

    // Bouton supprimer
    const del = document.createElement('div');
    del.className = 'small-button small-button-red';
    del.textContent = 'X';
    del.addEventListener('click', (e) => {
        e.stopPropagation();
        li.remove();
        const idx = viewPoints.findIndex(v => v.id === vp.id);
        if (idx >= 0) { viewPoints.splice(idx, 1); SaveViewPoints(); }
    });

    // Bouton renommer
    const ren = document.createElement('div');
    ren.className = 'small-button small-button-blue';
    ren.textContent = 'T';
    ren.addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = await ask('New viewpoint name', { title: 'Rename', kind: 'info' });
        if (!name) return;
        // ask() retourne true/false — on utilise un prompt natif via dialog
        // TODO: quand tauri-plugin-dialog supporte prompt(), utiliser ça
        // Pour l'instant on utilise window.prompt (supporté dans Tauri WebView)
        const newName = window.prompt('New viewpoint name', vp.title);
        if (!newName) return;
        const idx = viewPoints.findIndex(v => v.id === vp.id);
        if (idx >= 0) {
            viewPoints[idx].title = newName;
            li.querySelector('span').textContent = newName;
            SaveViewPoints();
        }
    });

    li.appendChild(del);
    li.appendChild(ren);
    li.addEventListener('click', () => {
        emit(`play-req:${matchId}:set-camera`, {
            type: 'move', camera: vp.camera,
            speed: selectedSpeed,
            smooth: parseFloat(document.getElementById('kalman').value) || 0.001
        }).catch(e => dlgMessage(e.message, { title: 'Setting camera', kind: 'error' }));
    });

    document.querySelector('.view-points').appendChild(li);
    SaveViewPoints();
}

function AddSpeed(speedValue, id) {
    id = id || speedsIndex++;
    const sp = { id, title: speedValue + ' seconds', speed: speedValue };
    speeds.push(sp);

    const li = document.createElement('li');
    li.innerHTML = `<span>${sp.title}</span>`;

    const del = document.createElement('div');
    del.className = 'small-button small-button-red';
    del.textContent = 'X';
    del.addEventListener('click', () => {
        li.remove();
        const idx = speeds.findIndex(s => s.id === sp.id);
        if (idx >= 0) { speeds.splice(idx, 1); SaveSpeeds(); }
    });

    li.appendChild(del);
    li.addEventListener('click', () => {
        document.querySelectorAll('.speeds li').forEach(el => el.classList.remove('selected'));
        li.classList.add('selected');
        selectedSpeed = sp.speed;
    });

    document.querySelector('.speeds').appendChild(li);
    SaveSpeeds();
}

function Spin(direction) {
    emit(`play-req:${matchId}:set-camera`, {
        type: 'spin', direction,
        speed: selectedSpeed,
        smooth: parseFloat(document.getElementById('kalman').value) || 0.001
    }).catch(e => dlgMessage(e.message, { title: 'Setting camera', kind: 'error' }));
}

document.addEventListener('DOMContentLoaded', async () => {
    // Réponses de play.js aux requêtes get-camera ("Add view point")
    await listen(`play-rep:${matchId}:get-camera`, ({ payload }) => {
        if (payload?.camera) AddViewPoint(payload.camera);
    });
    store = await Store.load('tabulon.json');

    const storedVPs = await store.get('camera-view:' + gameName) || [];
    storedVPs.forEach(vp => {
        if (vp.id >= viewPointsIndex) viewPointsIndex = vp.id + 1;
        AddViewPoint(vp.camera, vp.id, vp.title);
    });

    document.querySelector('.add-view-point').addEventListener('click', () => {
        // La caméra courante arrive par play-rep:get-camera (listener ci-dessous)
        emit(`play-req:${matchId}:get-camera`, null);
    });

    const storedSpeeds = await store.get('camera-view-speeds:' + gameName) || [];
    storedSpeeds.forEach(sp => {
        if (sp.id >= speedsIndex) speedsIndex = sp.id + 1;
        AddSpeed(sp.speed, sp.id);
    });

    document.querySelector('.add-speed').addEventListener('click', async () => {
        const val = window.prompt('Speed (seconds)', '1');
        if (val === null) return;
        AddSpeed(parseFloat(val) || 0);
    });

    const kalman = document.getElementById('kalman');
    kalman.value = await store.get('camera-view-kalman:' + gameName) || 0.001;
    kalman.addEventListener('change', async () => {
        await store.set('camera-view-kalman:' + gameName, kalman.value);
        await store.save();
    });

    document.getElementById('spin-cw').addEventListener('click',  () => Spin('cw'));
    document.getElementById('spin-ccw').addEventListener('click', () => Spin('ccw'));
    document.getElementById('pause').addEventListener('click', () => {
        emit(`play-req:${matchId}:set-camera`, { type: 'stop' })
            .catch(e => dlgMessage(e.message, { title: 'Stop camera', kind: 'error' }));
    });

    document.getElementById('help').addEventListener('click', () => {
        open('https://github.com/mi-g/joclyboard/wiki/Camera-View');
    });

    await initI18n();
    await twu.init(t('cameraView.title', { id: matchId }));
    document.getElementById('button-close').addEventListener('click', () => tRpc.close());
    twu.ready();
});
