// test-i18n-completeness.mjs — deux vérifications complémentaires à
// test-i18n.mjs (qui nécessite jsdom + dist/, non disponibles ici) :
//   1. translateLevelLabel() : traduction des libellés de niveau IA venus du
//      moteur Jocly (ex. "Easy", "Fast [1sec]"), qui ne passent pas par
//      data-i18n puisqu'ils ne sont pas dans le HTML de Tabulon.
//   2. Parité des clés en:/fr: sur tout le dictionnaire (pas seulement
//      celles ajoutées ici) -- une clé oubliée dans une des deux langues
//      retombe silencieusement sur l'anglais, ce test l'attrape.
// Usage : node tests/test-i18n-completeness.mjs

let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}

// ── Locale 'en' (langue d'origine des libellés Jocly) : passthrough ─────────
{
    const { translateLevelLabel } = await import('../app/content/tabulon-i18n.js');
    // Pas d'appel à initI18n() -> locale reste 'en' (valeur par défaut du module)
    assert(translateLevelLabel('Easy') === 'Easy', 'locale en (par défaut) : "Easy" inchangé');
    assert(translateLevelLabel('Fast [1sec]') === 'Fast [1sec]', 'locale en : suffixe inchangé aussi');
    assert(translateLevelLabel('') === '', 'chaîne vide -> inchangée');
    assert(translateLevelLabel(null) === null, 'null -> inchangé (pas d’exception)');
    assert(translateLevelLabel(undefined) === undefined, 'undefined -> inchangé (pas d’exception)');
}

// ── Locale 'fr' : forcée via window.__TAURI__.os.locale() avant initI18n() ──
globalThis.window = { __TAURI__: { os: { locale: async () => 'fr-FR' } } };
{
    // Nouvelle instance de module (le cache ESM garderait sinon la locale
    // déjà résolue par le bloc précédent) : on force un import distinct via
    // un cache-buster de query string.
    const mod = await import('../app/content/tabulon-i18n.js?locale=fr');
    await mod.initI18n();
    assert(mod.getLocale() === 'fr', 'initI18n() détecte bien fr via window.__TAURI__.os.locale()');

    assert(mod.translateLevelLabel('Easy') === 'Facile', 'libellé simple traduit : Easy -> Facile');
    assert(mod.translateLevelLabel('easy') === 'Facile', 'insensible à la casse : easy -> Facile');
    assert(mod.translateLevelLabel('Medium') === 'Moyen', 'Medium -> Moyen');
    assert(mod.translateLevelLabel('Strong') === 'Fort', 'Strong -> Fort');

    assert(mod.translateLevelLabel('Fast [1sec]') === 'Rapide [1sec]',
        `suffixe "[Nsec]" traduit sur le mot, préservé tel quel (obtenu: "${mod.translateLevelLabel('Fast [1sec]')}")`);
    assert(mod.translateLevelLabel('Fast (1sec)') === 'Rapide (1sec)', 'suffixe entre parenthèses aussi préservé');
    assert(mod.translateLevelLabel('Slow (10sec)') === 'Lent (10sec)', 'Slow (10sec) -> Lent (10sec)');

    assert(mod.translateLevelLabel('Papa') === 'Papa', 'Papa -> Papa (déjà identique en français)');
    assert(mod.translateLevelLabel('Sailor') === 'Marin', 'Sailor -> Marin');
    assert(mod.translateLevelLabel('Cabin boy') === 'Mousse', 'Cabin boy -> Mousse');

    // Libellé non couvert par la table (jeu futur, thème non répertorié) :
    // jamais de trou d'affichage, on retombe sur le texte d'origine.
    assert(mod.translateLevelLabel('Grandmaster') === 'Grandmaster',
        'libellé inconnu -> renvoyé inchangé (pas de trou d’affichage)');
    assert(mod.translateLevelLabel('Ronin') === 'Ronin', 'libellé non mappé (terme japonais) -> inchangé');
}

// ── Parité des clés EN/FR sur tout le dictionnaire ───────────────────────────
// Vérification légère (regex sur le fichier source, sans exporter DICT) :
// toute clé présente dans le bloc en: doit l'être aussi dans le bloc fr:, et
// vice-versa -- sinon t() retombe silencieusement sur l'anglais (comportement
// voulu au cas par cas, mais une clé manquante par erreur passerait inaperçue
// sans ce test).
{
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../app/content/tabulon-i18n.js', import.meta.url), 'utf8');
    const dictStart = src.indexOf('const DICT = {');
    const dictEnd = src.indexOf('\n};', dictStart);
    const dictSrc = src.slice(dictStart, dictEnd);
    const enStart = dictSrc.indexOf('en: {');
    const frStart = dictSrc.indexOf('fr: {');
    const enBlock = dictSrc.slice(enStart, frStart);
    const frBlock = dictSrc.slice(frStart);
    const extractKeys = (block) => new Set([...block.matchAll(/'([a-zA-Z]+\.[a-zA-Z]+)':/g)].map(m => m[1]));
    const enKeys = extractKeys(enBlock);
    const frKeys = extractKeys(frBlock);
    const missingInFr = [...enKeys].filter(k => !frKeys.has(k));
    const missingInEn = [...frKeys].filter(k => !enKeys.has(k));
    assert(missingInFr.length === 0, `toutes les clés en: ont un équivalent fr: (manquantes: ${missingInFr.join(', ') || 'aucune'})`);
    assert(missingInEn.length === 0, `toutes les clés fr: ont un équivalent en: (manquantes: ${missingInEn.join(', ') || 'aucune'})`);
    assert(enKeys.size > 100, `sondage de taille -- le dictionnaire n'est pas anormalement vide (${enKeys.size} clés en:)`);
}

/* ─── Aucune infobulle ne reste en anglais ─────────────────────────────── */
//
// Les boutons des barres d'outils n'ont pas de libellé : ce sont des icônes,
// et leur infobulle est tout ce que le joueur peut lire. Elle s'écrit dans un
// ATTRIBUT `title`, que le passage de traduction ne voit que si l'élément
// porte aussi `data-i18n-title` — sinon la chaîne anglaise du HTML reste, sans
// erreur ni trace en console.
//
// C'est ce qui s'était produit dans la fenêtre Historique : les dix clés
// existaient dans les deux langues depuis le début, et pas un bouton ne les
// demandait. Le contrôle porte donc sur le CÂBLAGE, que la parité du
// dictionnaire vérifiée plus haut ne dit pas.
{
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = new URL('../app/content/', import.meta.url);
    const pages = readdirSync(dir).filter(f => f.endsWith('.html'));
    const untranslated = [];
    for (const page of pages) {
        const html = readFileSync(new URL(page, dir), 'utf8');
        for (const tag of html.match(/<[^>]*\stitle="[^"]+"[^>]*>/g) || [])
            if (!/data-i18n-title=/.test(tag))
                untranslated.push(page + ' : ' + (/title="([^"]+)"/.exec(tag) || [])[1]);
    }
    assert(untranslated.length === 0,
        'chaque infobulle passe par le dictionnaire' +
        (untranslated.length ? ' — ' + untranslated.join(' | ') : ''));

    // Et la clé demandée doit exister : un data-i18n-title qui pointe dans le
    // vide affiche la clé elle-même, « tip.stepBack », ce qui est pire que
    // l'anglais.
    const src = readFileSync(new URL('../app/content/tabulon-i18n.js', import.meta.url), 'utf8');
    const orphans = [];
    for (const page of pages) {
        const html = readFileSync(new URL(page, dir), 'utf8');
        for (const m of html.matchAll(/data-i18n(?:-title|-placeholder)?="([^"]+)"/g))
            if (!src.includes("'" + m[1] + "'")) orphans.push(page + ' : ' + m[1]);
    }
    assert(orphans.length === 0,
        'et chaque clé demandée par une page existe' +
        (orphans.length ? ' — ' + orphans.join(' | ') : ''));
}

console.log(`\n${passed} assertions passées.`);
