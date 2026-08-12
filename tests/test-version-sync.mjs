// tests/test-version-sync.mjs — un seul numéro de version pour tout le dépôt.
//
// Le numéro était écrit à quatre endroits (package.json, app/package.json,
// src-tauri/Cargo.toml, src-tauri/tauri.conf.json) plus les deux emplacements
// de package-lock.json. En oublier un ne casse rien de visible : le build
// passe, l'application démarre, et c'est la version affichée dans « À propos »
// ou le nom du binaire livré qui se retrouve faux. Cette suite fait échouer
// `npm test` dans ce cas.
//
// Elle vérifie aussi que le montage tient : que tauri.conf.json pointe bien
// vers package.json au lieu de porter une copie, et que le hook npm `version`
// est branché — sans lui, `npm version 0.5.0` bumperait la racine seule et
// rétablirait silencieusement la divergence.
//
// Usage : npm test  (ou node tests/test-version-sync.mjs)
import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const at = (...p) => path.join(root, ...p);
const json = (...p) => JSON.parse(readFileSync(at(...p), 'utf-8'));

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };

const pkg = json('package.json');
const version = pkg.version;

console.log('Source unique');
{
    ok(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version),
       `package.json porte un semver valide (${version})`);

    // tauri.conf.json ne doit PAS porter de copie : le champ accepte un chemin
    // vers un package.json (schéma officiel du champ `version`), c'est ce qui
    // supprime la copie la plus coûteuse à oublier — celle qui décide du nom
    // des binaires et du numéro affiché dans l'application.
    const conf = json('src-tauri', 'tauri.conf.json');
    ok(conf.version === '../package.json',
       `tauri.conf.json délègue à package.json (trouvé : ${JSON.stringify(conf.version)})`);
}

console.log('Fichiers dérivés');
{
    ok(json('app', 'package.json').version === version, 'app/package.json');

    const lock = json('package-lock.json');
    ok(lock.version === version, 'package-lock.json (racine)');
    ok(lock.packages?.['']?.version === version, 'package-lock.json (packages[""])');

    // Cargo.toml : la clé de [package], pas celle d'une dépendance.
    const cargo = readFileSync(at('src-tauri', 'Cargo.toml'), 'utf-8');
    const head = cargo.slice(0, cargo.indexOf('\n[', cargo.indexOf('[package]') + 1));
    const found = /^\s*version\s*=\s*"([^"]*)"/m.exec(head);
    ok(found && found[1] === version, `src-tauri/Cargo.toml (trouvé : ${found?.[1]})`);
}

console.log('Outillage');
{
    ok(existsSync(at('scripts', 'set-version.mjs')), 'scripts/set-version.mjs présent');
    ok(pkg.scripts?.['set-version'], 'raccourci npm run set-version');
    // Hook npm : appelé automatiquement par `npm version <x>` APRÈS le bump de
    // la racine. C'est lui qui évite d'avoir à se souvenir du script.
    ok((pkg.scripts?.version || '').includes('set-version.mjs'),
       'hook npm `version` branché sur le script');

    // Le script doit être idempotent : relancé sur un dépôt à jour, il ne doit
    // rien réécrire. Sinon `npm test` salirait l'arbre de travail, et un
    // horodatage modifié sur Cargo.toml relancerait une compilation complète.
    const out = execFileSync(process.execPath, [at('scripts', 'set-version.mjs')], { encoding: 'utf-8' });
    ok(/déjà à jour/.test(out), 'relancé sur un dépôt à jour, il n\'écrit rien');

    // Et il refuse un numéro qui ne passerait ni chez npm ni chez cargo.
    let refused = false;
    try { execFileSync(process.execPath, [at('scripts', 'set-version.mjs'), 'v0.5'], { stdio: 'pipe' }); }
    catch { refused = true; }
    ok(refused, 'un numéro invalide est refusé avant toute écriture');
    ok(json('package.json').version === version, 'et le dépôt est intact après ce refus');
}

console.log('Aucune copie oubliée ailleurs');
{
    // Un numéro en dur ailleurs (README d'installation, workflow CI, script de
    // packaging) échapperait au script. On ne peut pas l'interdire, mais on
    // peut le signaler pendant qu'il n'y en a pas.
    let files = [];
    try {
        files = execFileSync('git', ['-C', root, 'grep', '-l', '-F', version, '--',
            ':!package.json', ':!package-lock.json', ':!app/package.json',
            ':!src-tauri/Cargo.toml', ':!tests/test-version-sync.mjs'],
            { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
    } catch { /* git grep sort en 1 quand il ne trouve rien : c'est le cas nominal */ }
    ok(files.length === 0,
       'le numéro n\'apparaît nulle part ailleurs' + (files.length ? ' — ' + files.join(', ') : ''));
}

console.log('');
console.log(`RESULTAT version-sync: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
