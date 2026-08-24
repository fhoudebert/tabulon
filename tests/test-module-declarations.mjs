// tests/test-module-declarations.mjs — pas deux fois le même nom.
//
// Régression : `play.js` a fini avec DEUX `function BoardLetters` au niveau
// module, ajoutées par deux lots de travail successifs. Dans un module ES,
// redéclarer un nom est une erreur dure — et son symptôme, lui, ne ressemble
// pas du tout à sa cause : le fichier se charge, l'application fonctionne, et
// une fonction déclarée PLUS LOIN dans le fichier est introuvable à l'appel
// (« Can't find variable: WesternGame »). On cherche donc le bug là où il ne
// se trouve pas.
//
// Node ne l'a pas signalé sur ce fichier — son analyseur y est plus tolérant
// que celui d'une WebView — donc `node --check`, `npm test` et les suites
// jsdom passaient toutes. Ce test comble précisément cet angle mort.
//
// Usage : npm test  (ou node tests/test-module-declarations.mjs)
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const content = path.join(root, 'app', 'content');

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };

// Deux contrôles, et ils ne mesurent pas la même chose.
//
// 1. LES DOUBLONS, repérés en colonne 0. Redéclarer un nom au niveau module
//    est une erreur dure ; le symptôme est trompeur (le fichier se charge, une
//    fonction déclarée plus loin devient introuvable).
//
// 2. LA PORTÉE RÉELLE de quelques fonctions nommées, par comptage d'accolades.
//    L'indentation ne dit rien : cinq fonctions d'export vivaient en colonne 0
//    À L'INTÉRIEUR du callback DOMContentLoaded, donc invisibles depuis les
//    écouteurs installés par une autre fonction. « Can't find variable:
//    WesternGame », alors que la déclaration était bien là, sans un espace
//    devant.
const DECL = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
const LET  = /^(?:export\s+)?(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

// Profondeur d'accolades à un index donné, chaînes, gabarits et commentaires
// sautés. `0` est la seule définition fiable de « niveau module ».
function DepthAt(src, target) {
    let depth = 0, i = 0, quote = null;
    while (i < target && i < src.length) {
        const c = src[i], n = src[i + 1];
        if (quote) {
            if (c === '\\') { i += 2; continue; }
            if (c === quote) quote = null;
            i++; continue;
        }
        if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (c === '/' && n === '*') {
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
            i += 2; continue;
        }
        if (c === '\'' || c === '"' || c === '`') { quote = c; i++; continue; }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
    }
    return depth;
}

const files = readdirSync(content).filter(f => f.endsWith('.js')).sort();
ok(files.length > 0, `${files.length} modules inspectés`);

let total = 0;
for (const file of files) {
    const src = readFileSync(path.join(content, file), 'utf-8');
    const seen = new Map();
    for (const re of [DECL, LET]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(src)) !== null) {
            const line = src.slice(0, m.index).split('\n').length;
            seen.set(m[1], [...(seen.get(m[1]) || []), line]);
        }
    }
    const dupes = [...seen.entries()].filter(([, lines]) => lines.length > 1);
    total += seen.size;
    ok(dupes.length === 0,
       `${file} : ${seen.size} déclarations, aucune en double`
       + (dupes.length ? ' — ' + dupes.map(([n, l]) => `${n} (lignes ${l.join(', ')})`).join(' ; ') : ''));
}
ok(total > 100, `${total} déclarations de premier niveau au total — l'inspection porte bien`);

console.log('Les fonctions appelées entre écouteurs sont bien au niveau module');
{
    // Le cas concret : `WesternGame` est appelée par un écouteur installé
    // dans initSatelliteListeners(), et déclarée ailleurs dans play.js. Si
    // elle glisse à nouveau dans le callback DOMContentLoaded, elle redevient
    // invisible — sans que rien ne le signale avant l'appel.
    const play = readFileSync(path.join(content, 'play.js'), 'utf-8');
    for (const name of ['WesternGame', 'BoardLetters', 'UsiToJocly', 'MoveFromUSI', 'MoveFromWestern']) {
        const at = play.search(new RegExp('^(?:async )?function ' + name + '\\b', 'm'));
        ok(at >= 0 && DepthAt(play, at) === 0,
           `play.js : ${name} est au niveau module`
           + (at < 0 ? ' — introuvable' : ` (profondeur ${DepthAt(play, at)})`));
    }
}

console.log('');
console.log(`RESULTAT module-declarations: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
