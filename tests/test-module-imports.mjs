// tests/test-module-imports.mjs — chaque nom importé est-il bien exporté ?
//
// Une erreur « Importing binding name 'X' is not found » ne se voit qu'au
// lancement, dans la webview, et elle emporte toute la fenêtre : le module
// importateur ne s'exécute pas du tout. Elle survient dès que les deux
// fichiers se désynchronisent — un correctif appliqué à moitié, une fonction
// renommée d'un côté, une copie plus ancienne déployée.
//
// Node ne l'attrape pas au chargement d'un seul module : il faut confronter
// les listes. C'est ce que fait cette suite, pour tous les modules de
// app/content/ d'un coup.
//
// Usage : npm test  (ou node tests/test-module-imports.mjs)
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(repo, 'app/content');
let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };

// Les noms qu'un module met à disposition : « export function », « export
// const », « export class », et les ré-exports nommés.
function exportsOf(source) {
    const names = new Set();
    for (const m of source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) names.add(m[1]);
    for (const m of source.matchAll(/^export\s+(?:const|let|var|class)\s+(\w+)/gm)) names.add(m[1]);
    for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm))
        for (const part of m[1].split(','))
            names.add(part.trim().split(/\s+as\s+/).pop().trim());
    if (/^export\s+default/m.test(source)) names.add('default');
    return names;
}

// Les imports NOMMÉS d'un module, groupés par fichier source. On laisse de
// côté les imports par défaut et les espaces de noms : eux ne peuvent pas
// manquer d'un nom précis.
function namedImports(source) {
    const found = [];
    for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
        const names = m[1].split(',')
            .map(s => s.trim().split(/\s+as\s+/)[0].trim())
            .filter(Boolean);
        found.push({ from: m[2], names });
    }
    return found;
}

const files = readdirSync(dir).filter(f => f.endsWith('.js'));
const sources = {};
for (const f of files) sources[f] = readFileSync(path.join(dir, f), 'utf-8');

console.log('Cohérence des imports nommés (app/content)');
let checked = 0, missing = [];
for (const f of files) {
    for (const imp of namedImports(sources[f])) {
        // Seuls les modules locaux nous concernent : le reste vient de
        // node_modules ou de Tauri, hors de notre contrôle.
        if (!imp.from.startsWith('./')) continue;
        const target = imp.from.replace(/^\.\//, '');
        if (!sources[target]) continue;          // fichier non JS, ou absent
        const available = exportsOf(sources[target]);
        for (const name of imp.names) {
            checked++;
            if (!available.has(name)) missing.push(`${f} importe « ${name} » que ${target} n'exporte pas`);
        }
    }
}
ok(checked > 50, `${checked} imports nommés confrontés à leur source`);
ok(missing.length === 0, missing.length ? missing.join(' | ') : 'tous les noms importés existent');

// Le cas qui a mordu : play.js et book-format.js, les deux fichiers les plus
// souvent modifiés ensemble.
console.log('');
console.log('Le couple play.js / book-format.js');
{
    const available = exportsOf(sources['book-format.js']);
    const wanted = namedImports(sources['play.js'])
        .filter(i => i.from === './book-format.js')
        .flatMap(i => i.names);
    ok(wanted.length > 10, `play.js importe ${wanted.length} noms de book-format.js`);
    const absent = wanted.filter(n => !available.has(n));
    ok(absent.length === 0, absent.length ? 'manquants : ' + absent.join(', ') : 'tous exportés');
}

console.log('');
console.log(`RESULTAT module-imports: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
