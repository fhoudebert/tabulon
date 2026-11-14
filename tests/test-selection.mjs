// test-selection.mjs — la liste de jeux de Tabulon-selection (selection.txt)
// et le contrôle du dist construit avec `gulp --games` (selection-games.mjs).
//
// gulp --games ignore sans rien dire un nom inconnu : la liste d'origine
// demandait « 9-men-morris » (le jeu s'appelle morris9) et « metamachy »
// (metamachy-chess), qui auraient simplement manqué à l'AppImage publiée.
//
// Usage : node tests/test-selection.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { parseSelection, checkDist } from '../scripts/selection-games.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}

console.log('Lecture de la liste');
{
    const g = parseSelection('# titre\nclassic-chess\n\n  shogi  # commentaire\nclassic-chess\n');
    assert(JSON.stringify(g) === '["classic-chess","shogi"]', 'commentaires, blancs et doublons ignorés');
    const sel = parseSelection(readFileSync(path.join(root, 'selection.txt'), 'utf-8'));
    assert(sel.length >= 30, `selection.txt : ${sel.length} jeux`);
    assert(sel.every(n => /^[A-Za-z0-9-]+$/.test(n)), 'des noms de jeux seulement (pas de « : » ni d\'espace)');
    assert(sel.includes('jeu-de-la-guerre'), 'le Jeu de la guerre, dont Tabulon embarque le moteur natif');
    assert(!sel.includes('9-men-morris') && !sel.includes('metamachy'), 'pas les noms inexistants de la liste d\'origine');
}

console.log('Contrôle d\'un dist');
{
    const dist = mkdtempSync(path.join(os.tmpdir(), 'tabulon-sel-'));
    const b = path.join(dist, 'browser');
    mkdirSync(path.join(b, 'games', 'chessbase'), { recursive: true });
    assert(checkDist(dist, ['classic-chess']).some(p => /moteur/.test(p)), 'moteur absent signalé');
    for (const f of ['jocly.js', 'jocly.core.js']) writeFileSync(path.join(b, f), '');
    writeFileSync(path.join(b, 'jocly-allgames.js'),
        '"use strict";exports.games=' + JSON.stringify({ 'classic-chess': { module: 'chessbase' }, shogi: { module: 'chessbase' } }) + ';\n');
    writeFileSync(path.join(b, 'games', 'chessbase', 'classic-chess-model.js'), '');
    assert(checkDist(dist, ['classic-chess']).length === 0, 'jeu présent : aucun problème');
    assert(checkDist(dist, ['9-men-morris']).some(p => /index : 9-men-morris/.test(p)), 'nom inconnu signalé');
    assert(checkDist(dist, ['shogi']).some(p => /shogi-model\.js/.test(p)), 'fichier modèle manquant signalé');
    rmSync(dist, { recursive: true, force: true });
}

console.log(`\ntest-selection: ${passed} assertions OK`);
