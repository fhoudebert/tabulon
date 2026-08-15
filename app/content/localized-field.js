// app/content/localized-field.js — champ de manifeste de jeu pouvant être
// soit une simple chaîne, soit un objet indexé par locale.
//
// Le manifeste d'un jeu Jocly déclare son résumé ainsi :
//     "summary": "an Ultima cousin on a 10x10 board with an edge ring"
// ou, pour un jeu traduit (même forme que le champ "rules", déjà indexé par
// locale) :
//     "summary": { "en": "an Ultima cousin…", "fr": "Un cousin de Ultima…" }
//
// Les deux formes doivent marcher côte à côte : les jeux existants gardent
// leur chaîne, les nouveaux peuvent traduire. L'anglais reste le repli par
// défaut — un jeu qui n'a pas la langue de l'utilisateur s'affiche en
// anglais plutôt que vide.
//
// Module PUR (aucun DOM, aucun import) : testable sous Node,
// tests/test-localized-field.mjs.

/**
 * Renvoie la variante à afficher d'un champ localisable.
 *
 * @param {string|Object|null|undefined} value  chaîne, ou objet {locale: texte}
 * @param {string} locale    locale courante ('fr', 'fr-CA', 'en'…)
 * @param {string} [fallback='en']  langue de repli
 * @returns {string} toujours une chaîne (jamais null/undefined/objet), pour
 *   que les appelants puissent enchaîner .toLowerCase(), textContent, etc.
 */
export function pickLocalized(value, locale, fallback = 'en') {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return value == null ? '' : String(value);

    const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
    const base = (l) => String(l || '').split(/[-_]/)[0].toLowerCase();

    // 1. locale exacte ('fr-CA'), puis 2. langue seule ('fr') — un manifeste
    //    peut indexer par l'une ou l'autre.
    const candidates = [locale, base(locale), fallback, base(fallback)];
    for (const key of candidates) {
        if (!key) continue;
        const hit = str(value[key]);
        if (hit) return hit;
    }
    // 3. Dernier recours : n'importe quelle traduction présente, plutôt que
    //    de n'afficher RIEN (un manifeste qui n'aurait ni la locale ni 'en').
    for (const v of Object.values(value)) {
        const hit = str(v);
        if (hit) return hit;
    }
    return '';
}
