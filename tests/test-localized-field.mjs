// test-localized-field.mjs — champ de manifeste localisable (résumé de jeu) :
// chaîne simple conservée, objet {locale: texte} réduit à la bonne langue,
// anglais en repli.
//
// Usage : node tests/test-localized-field.mjs

import { pickLocalized } from '../app/content/localized-field.js';

let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}

const EN = 'an Ultima cousin on a 10x10 board with an edge ring';
const FR = 'Un cousin de Ultima sur un tablier de 10x10 avec une bordure externe';

// ── 1. Les deux cas de l'énoncé (Rococo) ────────────────────────────────────
{
    // Manifeste ancien style : résumé = simple chaîne anglaise.
    assert(pickLocalized(EN, 'fr') === EN,
        'résumé en chaîne : affiché tel quel même en locale fr');
    // Manifeste traduit : objet indexé par locale.
    assert(pickLocalized({ en: EN, fr: FR }, 'fr') === FR,
        'résumé traduit : la version fr est choisie en locale fr');
    assert(pickLocalized({ en: EN, fr: FR }, 'en') === EN,
        'résumé traduit : la version en est choisie en locale en');
}

// ── 2. Replis ────────────────────────────────────────────────────────────────
{
    assert(pickLocalized({ en: EN }, 'fr') === EN,
        'langue absente → repli anglais (jamais vide)');
    assert(pickLocalized({ en: EN, fr: FR }, 'fr-CA') === FR,
        'locale régionale fr-CA → variante fr');
    assert(pickLocalized({ en: EN, fr: FR }, 'fr_FR') === FR,
        'séparateur underscore toléré');
    assert(pickLocalized({ 'fr-CA': 'québécois', fr: FR }, 'fr-CA') === 'québécois',
        'locale exacte prioritaire sur la langue seule');
    assert(pickLocalized({ de: 'Deutsch' }, 'fr') === 'Deutsch',
        'ni la locale ni en : dernier recours = une traduction existante');
    assert(pickLocalized({ en: EN, fr: FR }, 'de') === EN,
        'locale inconnue → anglais');
}

// ── 3. Toujours une chaîne exploitable (le filtre du hub fait .toLowerCase) ──
{
    assert(pickLocalized(undefined, 'fr') === '', 'undefined → chaîne vide');
    assert(pickLocalized(null, 'fr') === '', 'null → chaîne vide');
    assert(pickLocalized({}, 'fr') === '', 'objet vide → chaîne vide');
    assert(pickLocalized({ fr: '   ' }, 'fr') === '', 'valeur blanche ignorée');
    assert(pickLocalized({ fr: 42, en: EN }, 'fr') === EN, 'valeur non textuelle ignorée');
    for (const v of [undefined, null, {}, { en: EN }, EN]) {
        assert(typeof pickLocalized(v, 'fr') === 'string',
            `résultat toujours de type string (${JSON.stringify(v)?.slice(0, 20)})`);
    }
    assert(pickLocalized({ en: EN, fr: FR }, undefined) === EN,
        'locale absente → anglais');
}

console.log(`\ntest-localized-field: ${passed} assertions OK`);
