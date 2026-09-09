// test-localized-field.mjs — champ de manifeste localisable (résumé de jeu) :
// chaîne simple conservée, objet {locale: texte} réduit à la bonne langue,
// anglais en repli.
//
// Usage : node tests/test-localized-field.mjs

import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { pickLocalized, gameTitle } from '../app/content/localized-field.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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

/* ─── Le titre d'un jeu : deux orthographes, un seul repli ─────────────── */
//
// Le manifeste declare son titre sous la forme historique « title-en », ou
// sous la forme localisee « title: {en, fr} » -- celle de `summary` et de
// `rules`. Les deux doivent cohabiter : trois cents jeux portent la premiere,
// et un titre ne vaut pas une migration generale.
{
    const legacy = { 'title-en': '10x8 Chess variants' };
    const both   = { title: { en: '10x8 Chess variants', fr: 'Échecs en 10x8' } };

    assert(gameTitle(legacy, 'fr') === '10x8 Chess variants',
        'title-en s’affiche tel quel, quelle que soit la langue');
    assert(gameTitle(both, 'fr') === 'Échecs en 10x8', 'un titre traduit suit la langue');
    assert(gameTitle(both, 'en') === '10x8 Chess variants', 'et l’anglais reste l’anglais');
    // Repli : une langue absente ne doit pas laisser un titre vide, sans quoi
    // la fenetre s'ouvre sans nom et la liste affiche une ligne blanche.
    assert(gameTitle(both, 'de') === '10x8 Chess variants', 'une langue absente retombe sur l’anglais');

    // « title » l'emporte quand les deux sont ecrits : c'est la forme la plus
    // riche, et un manifeste qui migre garde souvent l'ancienne un temps.
    const mixed = { 'title-en': 'Old', title: { en: 'New', fr: 'Neuf' } };
    assert(gameTitle(mixed, 'en') === 'New', 'title l’emporte sur title-en');

    // Toujours une chaine : les appelants enchainent .localeCompare() et
    // textContent, qu'un objet ou un undefined casserait en silence.
    for (const v of [undefined, null, {}, 'pas un modele', legacy, both])
        assert(typeof gameTitle(v, 'fr') === 'string',
            `résultat toujours de type string (${JSON.stringify(v)?.slice(0, 22)})`);
}

/* ─── Plus personne ne lit « title-en » directement ────────────────────── */
//
// Le titre est affiche a sept endroits : barres de titre des fenetres, panneau
// de detail, listes. Chacun devait connaitre les DEUX orthographes, et un seul
// oubli laissait une fenetre en anglais SANS que rien ne le signale -- pas
// d'erreur, pas de console, juste un titre qui n'a pas suivi la langue.
// D'ou ce controle : le nom du champ n'apparait plus que dans le helper.
{
    const dir = path.join(root, 'app', 'content');
    const guilty = readdirSync(dir)
        .filter(f => f.endsWith('.js') && f !== 'localized-field.js')
        .filter(f => /\btitle-en\b/.test(readFileSync(path.join(dir, f), 'utf-8')));
    assert(guilty.length === 0,
        'aucun module ne lit title-en en direct' + (guilty.length ? ' — ' + guilty.join(', ') : ''));
}

console.log(`\ntest-localized-field: ${passed} assertions OK`);
