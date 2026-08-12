#!/usr/bin/env node
// scripts/set-version.mjs — un seul numéro de version pour tout le dépôt.
//
// SOURCE UNIQUE : le champ `version` de package.json (racine). Tout le reste
// en découle. C'est package.json qui est choisi et non Cargo.toml parce que
// npm sait déjà le faire évoluer (`npm version`), avec le tag git et le
// commit qui vont avec ; il n'existe pas d'équivalent aussi direct côté cargo.
//
// Ce qui est écrit :
//   package-lock.json     deux emplacements (racine + packages[""])
//   app/package.json      version du paquet frontend
//   src-tauri/Cargo.toml  version du crate
//
// Ce qui n'est PAS écrit, et pourquoi : src-tauri/tauri.conf.json porte
// désormais `"version": "../package.json"`. Ce n'est pas une astuce, c'est le
// format documenté du champ (schéma officiel : « a semver version number OR a
// path to a package.json file containing the version field »). Tauri lit donc
// la source directement, et le numéro affiché dans « À propos », le nom des
// binaires produits et les métadonnées de bundle en découlent sans copie.
//
// Usage :
//   npm version <x.y.z>            → npm bump la racine, le hook `version`
//                                  appelle ce script, puis git tag
//   npm run set-version <x.y.z>    → même propagation, sans commit ni tag
//   node scripts/set-version.mjs → propage la version actuelle (mode hook)
//
// Sans argument, le script ne DÉCIDE de rien : il recopie ce que porte déjà
// package.json. C'est ce que fait le hook npm, appelé après le bump.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const at = (...p) => path.join(root, ...p);

// semver strict, avec pré-version et métadonnées facultatives. Cargo et npm
// acceptent tous deux ce format ; un numéro fantaisiste ferait échouer le
// build bien plus loin, avec un message beaucoup moins clair.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const readJson  = (f) => JSON.parse(readFileSync(f, 'utf-8'));
// Écriture seulement si le contenu change : garder l'horodatage des fichiers
// intacts évite de déclencher un rebuild cargo pour rien quand la version est
// déjà à jour (cas du hook npm relancé, ou de `npm test`).
function write(file, text) {
    if (existsSync(file) && readFileSync(file, 'utf-8') === text) return false;
    writeFileSync(file, text);
    return true;
}
// Les package.json sont normalisés par npm à deux espaces, saut de ligne final.
const writeJson = (file, data) => write(file, JSON.stringify(data, null, 2) + '\n');

function setVersion(version) {
    if (!SEMVER.test(version))
        throw new Error(`version invalide : "${version}" — attendu MAJEUR.MINEUR.CORRECTIF (ex. 1.4.0)`);
    const touched = [];

    // 1. package.json (racine) — la source.
    const pkgFile = at('package.json');
    const pkg = readJson(pkgFile);
    const previous = pkg.version;
    pkg.version = version;
    if (writeJson(pkgFile, pkg)) touched.push('package.json');

    // 2. package-lock.json — deux emplacements, npm les tient tous deux à jour.
    const lockFile = at('package-lock.json');
    if (existsSync(lockFile)) {
        const lock = readJson(lockFile);
        lock.version = version;
        if (lock.packages?.['']) lock.packages[''].version = version;
        if (writeJson(lockFile, lock)) touched.push('package-lock.json');
    }

    // 3. app/package.json — paquet frontend.
    for (const rel of ['app/package.json', 'app/package-lock.json']) {
        const file = at(rel);
        if (!existsSync(file)) continue;
        const data = readJson(file);
        data.version = version;
        if (data.packages?.['']) data.packages[''].version = version;
        if (writeJson(file, data)) touched.push(rel);
    }

    // 4. Cargo.toml — UNIQUEMENT la clé `version` de la section [package].
    //    Une substitution globale toucherait les versions des dépendances
    //    (`tauri = { version = "2" }`), d'où le découpage sur la première
    //    section et l'ancrage en début de ligne.
    const cargoFile = at('src-tauri', 'Cargo.toml');
    const cargo = readFileSync(cargoFile, 'utf-8');
    const end = cargo.indexOf('\n[', cargo.indexOf('[package]') + 1);
    const head = end === -1 ? cargo : cargo.slice(0, end);
    const rest = end === -1 ? '' : cargo.slice(end);
    const line = /^(\s*version\s*=\s*)"[^"]*"/m;
    if (!line.test(head))
        throw new Error('src-tauri/Cargo.toml : aucune clé `version` dans [package]');
    if (write(cargoFile, head.replace(line, `$1"${version}"`) + rest)) touched.push('src-tauri/Cargo.toml');

    return { version, previous, touched };
}

const arg = process.argv[2];
try {
    // Sans argument : mode hook — on propage ce que porte déjà package.json.
    const target = arg || readJson(at('package.json')).version;
    const { version, previous, touched } = setVersion(target);
    if (!touched.length) console.log(`version ${version} — déjà à jour partout`);
    else {
        console.log(`version ${version}${previous !== version ? ` (était ${previous})` : ''}`);
        for (const f of touched) console.log('  ' + f);
        console.log('  src-tauri/tauri.conf.json → lit ../package.json, rien à écrire');
    }
} catch (e) {
    console.error('✗ ' + (e.message || e));
    process.exit(1);
}
