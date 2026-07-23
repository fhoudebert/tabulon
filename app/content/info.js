// app/content/info.js
import twu  from './tabulon-winutils.js';
import { open } from './tauri-bridge.js';
import { initI18n, t, getLocale } from './tabulon-i18n.js';
import { rewriteCssUrls } from './css-url-rewrite.js';

const gameName = (function () {
    const m = /\?.*\bgame=([^&]+)/.exec(window.location.href);
    return m && m[1] || 'classic-chess';
})();

function TabSelected(what) {
    document.querySelectorAll('.tab-group .tab-item[data-tab]').forEach(el => el.classList.remove('active'));
    document.querySelector(`.tab-group .tab-item[data-tab="${what}"]`)?.classList.add('active');
    document.querySelectorAll('.window-content [data-tab]').forEach(el => el.style.display = 'none');
    document.querySelector(`.window-content [data-tab="${what}"]`)?.style.removeProperty('display');
}

function DefaultTab() {
    for (const t of ['rules', 'description', 'credits']) {
        const tab = document.querySelector(`.tab-group .tab-item[data-tab="${t}"]`);
        if (tab && tab.style.display !== 'none') { TabSelected(t); return; }
    }
}

// Candidats d'URL pour un document (rules/description/credits), du plus
// spécifique au plus générique selon la locale :
//   1. descriptor[locale] si la config du jeu le déclare explicitement
//      (ex. makromachy : rules.fr = ".../makromachy-rules_fr.html")
//   2. sonde du suffixe _fr sur le fichier en (ex. "x-rules.html" →
//      "x-rules_fr.html") : couvre les traductions ajoutées dans les
//      ressources sans mise à jour de la config
//   3. le fichier en / la chaîne brute (toujours en dernier recours)
function DocCandidates(descriptor) {
    const lang = getLocale();
    const base = (descriptor && descriptor.en) || (typeof descriptor === 'string' ? descriptor : null);
    const candidates = [];
    if (lang !== 'en' && descriptor && typeof descriptor === 'object' && descriptor[lang])
        candidates.push(descriptor[lang]);
    if (lang !== 'en' && base && /\.html?$/i.test(base))
        candidates.push(base.replace(/(\.html?)$/i, `_${lang}$1`));
    if (base) candidates.push(base);
    return [...new Set(candidates)];
}

async function GetHtml(config, what) {
    const candidates = DocCandidates(config.model[what]);
    if (!candidates.length) return;

    try {
        let text = null;
        for (const htmlUrl of candidates) {
            try {
                const resp = await fetch(config.view.fullPath + '/' + htmlUrl);
                if (resp.ok) { text = await resp.text(); break; }
            } catch { /* candidat suivant */ }
        }
        if (text === null) throw new Error('no readable document among: ' + candidates.join(', '));
        let html = text.replace(/\{GAME\}/g, config.view.fullPath);
        // Dist EXTERNE : les url(...) du CSS de la page de règles (sprites de
        // pièces, ex. Ultima) doivent viser tabulon-dist://. On les réécrit
        // AVANT l'insertion : le texte d'un <style> échappe à tous les hooks
        // d'asset-rewrite.js (le moteur CSS l'analyse sans passer par le JS),
        // et le réécrire après coup laisserait déjà partir une requête vers
        // les assets embarqués (→ 500 en console). Sans dist externe,
        // window.__distURL n'existe pas : rien n'est touché.
        if (typeof window.__distURL === 'function') {
            html = rewriteCssUrls(html, (u) => window.__distURL(u));
        }

        const tab     = document.querySelector(`.tab-group .tab-item[data-tab="${what}"]`);
        const content = document.querySelector(`.window-content [data-tab="${what}"]`);
        if (!tab || !content) return;
        tab.style.removeProperty('display');   // rendre l'onglet visible
        content.innerHTML = html;

        content.querySelectorAll('a[href]').forEach(a => {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                open(a.getAttribute('href'));
            });
        });

        DefaultTab();
    } catch (e) {
        console.warn('[info] GetHtml failed for', what, ':', e);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await initI18n();
    const config = await Jocly.getGameConfig(gameName);
    await twu.init(t('info.title', { game: config.model['title-en'] }));

    await Promise.all(['rules', 'description', 'credits'].map(t => GetHtml(config, t)));

    document.querySelectorAll('.tab-group .tab-item[data-tab]').forEach(el => {
        el.addEventListener('click', function () { TabSelected(this.dataset.tab); });
    });
});
