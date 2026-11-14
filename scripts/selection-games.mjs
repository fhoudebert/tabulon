#!/usr/bin/env node
// scripts/selection-games.mjs — la liste de jeux de Tabulon-selection.
//
// Source : selection.txt (un jeu par ligne, # pour les commentaires).
//
// Usage :
//   node scripts/selection-games.mjs
//       affiche la liste séparée par « : », pour gulp :
//         npx gulp --games "$(node ../tabulon/scripts/selection-games.mjs)" build --prod
//   node scripts/selection-games.mjs --check <dist>
//       vérifie que <dist>/browser contient le moteur et CHACUN des jeux de la
//       liste (index et fichier modèle). gulp --games ignore sans rien dire un
//       nom inconnu : sans ce contrôle, un jeu mal orthographié manquerait
//       simplement à l'application publiée.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Noms de jeux d'un texte au format de selection.txt, sans doublon. Pur (testé). */
export function parseSelection(text) {
    const seen = new Set();
    for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*/, '').trim();
        if (line) seen.add(line);
    }
    return [...seen];
}

/** Index des jeux d'un jocly-allgames.js. */
export function readIndex(file) {
    const m = readFileSync(file, 'utf-8').match(/exports\.games\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (!m) throw new Error(`format inattendu : ${file}`);
    return (0, eval)('(' + m[1] + ')');
}

/** Problèmes d'un dist face à la liste ; [] si tout y est. */
export function checkDist(dist, games) {
    const browser = path.join(dist, 'browser');
    const problems = [];
    for (const f of ['jocly.js', 'jocly.core.js', 'jocly-allgames.js'])
        if (!existsSync(path.join(browser, f))) problems.push(`moteur incomplet : browser/${f} absent`);
    if (problems.length) return problems;
    const index = readIndex(path.join(browser, 'jocly-allgames.js'));
    for (const g of games) {
        if (!index[g]) { problems.push(`jeu absent de l'index : ${g}`); continue; }
        const model = path.join(browser, 'games', index[g].module, g + '-model.js');
        if (!existsSync(model)) problems.push(`fichier absent : ${path.relative(dist, model)}`);
    }
    return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const games = parseSelection(readFileSync(path.join(root, 'selection.txt'), 'utf-8'));
    if (process.argv[2] === '--check') {
        const dist = process.argv[3];
        if (!dist) { console.error('usage : selection-games.mjs --check <dist>'); process.exit(2); }
        const problems = checkDist(path.resolve(dist), games);
        if (problems.length) {
            for (const p of problems) console.error('✗ ' + p);
            console.error('  (nom de jeu = clé de jocly-allgames.js ; ex. morris9, pas 9-men-morris)');
            process.exit(1);
        }
        const n = Object.keys(readIndex(path.join(dist, 'browser', 'jocly-allgames.js'))).length;
        console.log(`✓ ${dist} : les ${games.length} jeux de selection.txt sont présents (${n} dans l'index).`);
    } else {
        console.log(games.join(':'));
    }
}
