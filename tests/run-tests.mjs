// tests/run-tests.mjs — lance toutes les suites d'intégration et résume.
// Usage : npm test   (ou : node tests/run-tests.mjs)
//
// Prérequis : dist/ de jocly2 copié à la racine (voir README) et jsdom
// installé dans app/ (npm --prefix app install).
import { spawnSync } from 'child_process';
import { readdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root     = path.dirname(testsDir);

for (const [p, msg] of [
    [path.join(root, 'dist/node/jocly.core.js'), 'dist/ manquant — copier le build de jocly2 (voir README, section "Building Jocly")'],
    [path.join(root, 'app/node_modules/jsdom'),  'jsdom manquant — lancer : npm --prefix app install'],
]) if (!existsSync(p)) { console.error('✗ ' + msg); process.exit(1); }

const suites = readdirSync(testsDir).filter(f => /^test-.*\.mjs$/.test(f)).sort();
let failed = 0;
console.log(`Lancement de ${suites.length} suites…\n`);
for (const suite of suites) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(testsDir, suite)], { encoding: 'utf-8' });
    const ok = r.status === 0;
    const last = (r.stdout || '').trim().split('\n').pop() || '';
    console.log(`${ok ? '✓' : '✗'} ${suite}  (${Date.now() - t0} ms)  ${last}`);
    if (!ok) {
        failed++;
        console.log((r.stdout || '').split('\n').filter(l => l.includes('✗')).join('\n'));
        console.log((r.stderr || '').split('\n').slice(-8).join('\n'));
    }
}
console.log(failed ? `\n${failed}/${suites.length} suite(s) en échec` : '\nToutes les suites passent.');
process.exit(failed ? 1 : 0);
