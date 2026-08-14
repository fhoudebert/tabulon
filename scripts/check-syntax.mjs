#!/usr/bin/env node
// scripts/check-syntax.mjs — contrôle de syntaxe du frontend, sans dépendance.
//
// Remplace `jshint`, retiré parce qu'il était à la fois vulnérable et inutile :
//
//  - il apportait à lui seul les quatre alertes de sécurité du dépôt (lodash,
//    minimatch, brace-expansion) et les deux avertissements d'obsolescence
//    (inflight, glob@7), par sa dépendance `cli@1.0.1` qui n'est plus
//    maintenue. Sa propre dernière version (2.13.6, 2023) fige ces
//    dépendances : aucune mise à jour ne pouvait corriger cela ;
//
//  - faute de `.jshintrc`, il analysait en ES5 du code ES2020 et sortait
//    2169 « erreurs » — arrow functions, chaînage optionnel — toutes fausses.
//    Le script `npm run lint` finissait par `|| true`, donc ce bruit était
//    ignoré et rien n'était réellement vérifié.
//
// Ce que fait ce script à la place : `node --check` sur chaque fichier, qui
// détecte les vraies erreurs de syntaxe. Node ≥ 20 reconnaît seul la syntaxe
// de module, il n'y a donc rien à déclarer pour les fichiers `import`/`export`
// d'app/content/. Et contrairement à l'ancien script, celui-ci ÉCHOUE quand
// il trouve quelque chose : une erreur de syntaxe dans une WebView est
// silencieuse à l'exécution (la page se charge, le module ne s'exécute pas),
// c'est précisément le genre de faute qu'on veut voir avant.
//
// Ce n'est pas un linter : ni style, ni variables inutilisées, ni règles de
// projet. Si le besoin s'en fait sentir un jour, ESLint est le candidat
// naturel — mais il n'y avait pas de configuration jshint, donc pas de règles
// à préserver, et poser un vrai linter est un choix à faire pour de bon,
// pas un effet de bord d'une mise à jour de dépendances.
//
// Usage : npm run lint   (ou node scripts/check-syntax.mjs [dossier…])

import { readdirSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const targets = process.argv.slice(2).length
    ? process.argv.slice(2)
    : ['app/content', 'scripts', 'tests'];

function collect(dir) {
    const out = [];
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return out; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        // node_modules et dist sont du code tiers : ce n'est pas à nous de le
        // valider, et le volume rendrait le contrôle inutilisable.
        if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            out.push(...collect(full));
        } else if (/\.(js|mjs)$/.test(e.name)) out.push(full);
    }
    return out;
}

const files = [];
for (const t of targets) {
    const full = path.isAbsolute(t) ? t : path.join(root, t);
    try { files.push(...(statSync(full).isDirectory() ? collect(full) : [full])); }
    catch { console.error(`✗ introuvable : ${t}`); process.exit(1); }
}

let bad = 0;
for (const file of files) {
    try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (e) {
        bad++;
        const msg = String(e.stderr || e.message).trim().split('\n')
            .filter(l => l && !/^\s*at /.test(l) && !/^Node\.js v/.test(l))
            .slice(0, 4).join('\n');
        console.error(`✗ ${path.relative(root, file)}\n${msg}\n`);
    }
}

console.log(`${files.length} fichier(s) contrôlé(s), ${bad} en erreur`);
process.exit(bad ? 1 : 0);
