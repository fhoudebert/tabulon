// app/content/key-test.js — fenetre « Test » des cles de communaute.
//
// A QUOI CA SERT. Une cle partagee qui ne correspond pas a celle de l'autre
// joueur ne se voit pas : les messages arrivent simplement verrouilles, et
// rien ne dit si c'est la cle, le relai ou le reseau. Ici on le verifie a
// froid, avant de jouer : je chiffre un mot, je l'envoie par mail, l'autre le
// dechiffre avec SA cle -- s'il lit le mot, nous avons la meme. L'empreinte
// (chat_key_id) permet la meme verification sans rien echanger que 16
// caracteres qu'on peut se lire au telephone.
//
// CE QUI EST TESTE EST CE QUI SERT EN PARTIE : memes commandes Rust
// (seal_text / open_text, via makeSealer), meme format de sceau. Ce n'est
// pas une reimplementation pour l'ecran.
//
// La cle n'est jamais passee dans l'URL : la fenetre ne recoit que
// l'IDENTIFIANT de la cle (?key=k-…) et relit la cle dans le store, comme
// les preferences. Seules les cles ENREGISTREES sont donc testables -- c'est
// voulu, le hub demande d'enregistrer d'abord.
import tRpc from './tabulon-rpc.js';
import { Store } from './tauri-bridge.js';
import { initI18n, t } from './tabulon-i18n.js';
import { makeSealer, chatKeyId, isSeed } from './remote-secret.js';
import twu from './tabulon-winutils.js';

let store;
let keys = [];

const $ = (id) => document.getElementById(id);

function say(id, key, ok) {
    const el = $(id);
    if (!el) return;
    el.textContent = key ? t(key) : '';
    el.classList.toggle('key-test-ok', ok === true);
    el.classList.toggle('key-test-bad', ok === false);
}

/** La cle choisie dans la liste, si elle est utilisable. */
function selectedKey() {
    const k = keys.find(x => x.id === $('kt-key')?.value);
    return k && isSeed(k.key) ? k.key : null;
}

/**
 * Relit les cles enregistrees et remplit la liste. `wanted` : l'identifiant
 * a selectionner (celui du bouton Test), sinon on garde la selection en
 * cours. Appele aussi au retour du focus : une cle ajoutee ou modifiee dans
 * les preferences pendant que cette fenetre est ouverte doit y apparaitre.
 */
async function loadKeys(wanted) {
    const list = $('kt-key');
    const keep = wanted || list.value;
    keys = ((await store.get('community-keys')) || []).filter(k => isSeed(k.key));
    list.innerHTML = '';
    for (const k of keys) {
        const opt = document.createElement('option');
        opt.value = k.id;
        opt.textContent = k.name || t('prefs.keyUnnamed');
        list.appendChild(opt);
    }
    if (keys.some(k => k.id === keep)) list.value = keep;
    const none = keys.length === 0;
    $('kt-nokey').style.display = none ? '' : 'none';
    for (const id of ['kt-key', 'kt-seal', 'kt-open']) $(id).disabled = none;
    await showFingerprint();
}

async function showFingerprint() {
    const key = selectedKey();
    $('kt-fingerprint').textContent = key ? await chatKeyId(key).catch(() => '?') : '';
}

/**
 * Chiffrer, puis rouvrir aussitot ce qu'on vient de sceller : un sceau que
 * notre propre cle ne sait pas rouvrir ne servira a personne, et c'est le
 * seul controle possible sans second poste.
 */
async function doSeal() {
    const key = selectedKey();
    const text = $('kt-plain').value;
    $('kt-sealed-out').value = '';
    if (!key) return;
    if (!text) { say('kt-seal-status', 'keyTest.emptyPlain', false); return; }
    const sealer = makeSealer(key);
    let sealed;
    try { sealed = await sealer.seal(text); }
    catch (e) {
        console.warn('[key-test] scellement :', e);
        say('kt-seal-status', 'keyTest.sealFailed', false);
        return;
    }
    $('kt-sealed-out').value = sealed;
    const back = await sealer.open(sealed);
    if (back === text) say('kt-seal-status', 'keyTest.roundTripOk', true);
    else say('kt-seal-status', 'keyTest.roundTripBad', false);
}

/**
 * Dechiffrer un texte colle. Un echec ne dit pas POURQUOI (autre cle, texte
 * tronque ou modifie) : Rust ne le distingue pas, et c'est voulu (voir
 * makeSealer). Le message le dit tel quel plutot que d'accuser la cle.
 */
async function doOpen() {
    const key = selectedKey();
    // Les retours a la ligne et espaces viennent du copier-coller d'un mail :
    // le base64 n'en contient jamais, on les retire.
    const sealed = $('kt-sealed-in').value.replace(/\s+/g, '');
    $('kt-plain-out').value = '';
    if (!key) return;
    if (!sealed) { say('kt-open-status', 'keyTest.emptySealed', false); return; }
    const text = await makeSealer(key).open(sealed);
    if (text === null) { say('kt-open-status', 'keyTest.openFailed', false); return; }
    $('kt-plain-out').value = text;
    say('kt-open-status', 'keyTest.openOk', true);
}

window.addEventListener('DOMContentLoaded', async () => {
    await initI18n();
    await twu.init(t('keyTest.title'));
    store = await Store.load('tabulon.json');

    await loadKeys(new URLSearchParams(window.location.search).get('key'));

    $('kt-key').addEventListener('change', async () => {
        say('kt-seal-status', null);
        say('kt-open-status', null);
        $('kt-sealed-out').value = '';
        $('kt-plain-out').value = '';
        await showFingerprint();
    });
    $('kt-seal').addEventListener('click', doSeal);
    $('kt-open').addEventListener('click', doOpen);
    window.addEventListener('focus', () => { loadKeys().catch(() => {}); });

    // Fenetre deja ouverte quand on reclique « Test » sur une autre cle :
    // Rust ne fait que la ramener au premier plan, le hub nous dit laquelle.
    tRpc.listen({
        keyTestSelect: async ({ id } = {}) => {
            await loadKeys(id);
            $('kt-key').dispatchEvent(new Event('change'));
        },
    });
    twu.ready?.();
});
