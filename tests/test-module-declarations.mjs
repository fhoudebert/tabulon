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

// Déclarations de PREMIER NIVEAU : en début de ligne, sans indentation. Une
// fonction imbriquée est indentée, et deux fonctions homonymes dans des portées
// différentes sont parfaitement légales — ce n'est pas ce qu'on traque.
const DECL = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
const LET  = /^(?:export\s+)?(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

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

console.log('');
console.log(`RESULTAT module-declarations: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
