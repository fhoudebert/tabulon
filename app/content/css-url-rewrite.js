// app/content/css-url-rewrite.js — réécriture des `url(...)` d'un texte CSS.
//
// Pourquoi : les pages de règles des jeux (res/rules/<jeu>/*.html, chargées
// par info.js) peuvent illustrer les pièces avec un SPRITE, donc en CSS :
//   .u-icon { background-image: url({GAME}/res/ultima/ultima-picto-sprites.png) }
// Avec un dist EXTERNE, les URL d'assets doivent passer par le protocole
// tabulon-dist:// (voir asset-rewrite.js). Or les hooks d'asset-rewrite
// couvrent les attributs (img/src, link/href), fetch/XHR et le CSSOM (styles
// posés en JS) — mais PAS le texte CSS d'un <style> : celui-là est analysé
// par le moteur, aucun hook JS ne le voit passer. Résultat constaté avec le
// dist externe : la page de règles d'Ultima demandait le PNG sur le
// protocole d'app (assets embarqués, où le jeu n'est pas) → 500, icônes
// absentes ; les pages qui utilisent <img> (werewolf) marchaient, elles,
// via le hook d'attributs.
//
// Ce module est PUR (aucun DOM, aucun réseau) pour être testable sous Node :
// tests/test-css-url-rewrite.mjs.

/**
 * Réécrit les `url(...)` d'un texte CSS (ou d'un fragment HTML contenant du
 * CSS) en appliquant `mapUrl` à chaque URL.
 *
 * @param {string} text  texte CSS/HTML
 * @param {(url: string) => (string|null|undefined)} mapUrl
 *        renvoie l'URL de remplacement, ou une valeur fausse pour laisser
 *        l'URL inchangée.
 * @returns {string}
 */
export function rewriteCssUrls(text, mapUrl) {
    if (typeof text !== 'string' || typeof mapUrl !== 'function') return text;
    return text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, quote, url) => {
        // data:/blob: ne désignent aucun fichier du dist : ne jamais toucher.
        if (/^(data|blob):/i.test(url)) return whole;
        let mapped;
        try {
            mapped = mapUrl(url);
        } catch {
            return whole;
        }
        return (typeof mapped === 'string' && mapped) ? `url(${quote}${mapped}${quote})` : whole;
    });
}
