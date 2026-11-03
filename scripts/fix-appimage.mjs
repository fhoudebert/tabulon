#!/usr/bin/env node
// scripts/fix-appimage.mjs — Purge les bibliothèques `libwayland-*` d'une
// AppImage Tabulon déjà construite, puis la réempaquette.
//
// POURQUOI (constat empirique, Manjaro/Arch, session X11, 2026-07) :
// l'AppImage produite par `cargo tauri build` embarque la famille
// libwayland-* (client, cursor, egl, server). Sur les hôtes Arch, ces
// bibliothèques construites côté Debian empoisonnent l'initialisation EGL
// du WebKitGTK embarqué face au Mesa de l'hôte — même en session X11 :
//   Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
// Le diagnostic a été fait par élimination sur machine touchée : binaire
// natif OK, variables WebKit (DMABUF/COMPOSITING) sans effet, et le retrait
// des seules libwayland-* de l'AppDir extrait répare (le retrait du WebKit
// embarqué, lui, CASSE : le GTK/GLib du bundle est incompatible avec le
// WebKit de l'hôte — ne pas essayer). La liste d'exclusion officielle de
// l'écosystème AppImage (AppImageCommunity/pkg2appimage/excludelist)
// proscrit d'ailleurs libwayland-client.so.0 des bundles ; Tauri l'embarque
// quand même. Voir DEVELOPMENT.md § Troubleshooting AppImage.
//
// USAGE :
//   node scripts/fix-appimage.mjs [chemin/vers/Tabulon.AppImage]
// Sans argument : cherche l'AppImage dans
//   src-tauri/target/release/bundle/appimage/
// L'original est conservé en <nom>.AppImage.orig. À lancer après chaque
// `cargo tauri build` produisant une AppImage.
//
// PRÉREQUIS : `appimagetool` pour réempaqueter — pris dans $APPIMAGETOOL,
// sinon dans le PATH, sinon téléchargé (version figée, voir plus bas) dans
// ~/.cache/tabulon/. Il est lancé avec --appimage-extract-and-run pour ne
// pas dépendre de FUSE. x86_64 et aarch64 : l'AppImage se construit sur la
// machine qui la fait tourner (Tauri ne croise pas), donc l'architecture de
// la machine est aussi celle de l'AppImage.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, chmodSync, rmSync, readdirSync, renameSync, copyFileSync, openSync, readSync, closeSync, writeFileSync, lstatSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Version FIGEE, pas « continuous » : continuous change sous nos pieds. Le
// 29/10/2026 (appimagetool #135/#139) il s'est mis a refuser un AppDir dont
// la racine n'est pas lisible par tous -- ce qui cassait ce script, la CI
// telechargeant l'outil a chaque passage. Changer de version = la tester.
const APPIMAGETOOL_VERSION = '1.9.1';
const APPIMAGETOOL_BASE =
    `https://github.com/AppImage/appimagetool/releases/download/${APPIMAGETOOL_VERSION}/`;

/**
 * Nom AppImage de l'architecture Node (os.arch()), ou null si appimagetool
 * n'en publie pas. Pur (testé) : il choisit l'appimagetool téléchargé ET la
 * variable ARCH, qu'appimagetool exige et qui finit dans le nom du fichier.
 */
export function appimageArch(nodeArch) {
    return { x64: 'x86_64', arm64: 'aarch64' }[nodeArch] || null;
}

/**
 * Le fichier doit-il être purgé du bundle ? Prédicat PUR (testé par
 * tests/test-fix-appimage.mjs). Uniquement la famille libwayland-* — le
 * périmètre exact validé sur machine touchée ; ne pas l'élargir sans
 * nouveau constat (retirer WebKit, par exemple, casse — voir en-tête).
 */
export function shouldStrip(fileName) {
    return /^libwayland-[a-z]+\.so(\.\d+)*$/.test(fileName);
}

/**
 * Purge un AppDir extrait ; renvoie la liste des fichiers retirés.
 * Séparé de main() pour être testable sans appimagetool.
 */
export function stripAppDir(appDir) {
    const libDir = join(appDir, 'usr', 'lib');
    if (!existsSync(libDir)) return [];
    const removed = [];
    for (const name of readdirSync(libDir)) {
        if (shouldStrip(name)) {
            rmSync(join(libDir, name), { force: true });
            removed.push(name);
        }
    }
    return removed;
}

/**
 * Rend a l'AppDir extrait les droits de l'AppImage d'origine, l'equivalent de
 * `chmod -R a+rX` : --appimage-extract recree les REPERTOIRES en 0700 alors
 * qu'ils sont en 0755 dans le squashfs. Sans cela l'AppImage refaite les
 * garde en 0700 (illisible pour un autre utilisateur), et appimagetool
 * recent refuse carrement de l'empaqueter. Liens symboliques non suivis.
 * Renvoie le nombre d'entrees modifiees (testable).
 */
export function restoreModes(dir) {
    let changed = 0;
    const visit = (p) => {
        const st = lstatSync(p);
        if (st.isSymbolicLink()) return;
        const mode = st.mode & 0o7777;
        let want = mode | 0o444;
        if (st.isDirectory() || (mode & 0o111)) want |= 0o111;
        if (want !== mode) { chmodSync(p, want); changed++; }
        if (st.isDirectory()) for (const name of readdirSync(p)) visit(join(p, name));
    };
    visit(dir);
    return changed;
}

function findDefaultAppImage() {
    const dir = join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'appimage');
    if (!existsSync(dir)) return null;
    const candidates = readdirSync(dir).filter(f => f.endsWith('.AppImage'));
    return candidates.length === 1 ? join(dir, candidates[0]) : null;
}

function findAppimagetool(arch) {
    if (process.env.APPIMAGETOOL && existsSync(process.env.APPIMAGETOOL)) {
        return process.env.APPIMAGETOOL;
    }
    const inPath = spawnSync('which', ['appimagetool'], { encoding: 'utf8' });
    if (inPath.status === 0 && inPath.stdout.trim()) return inPath.stdout.trim();
    const file = `appimagetool-${arch}.AppImage`;
    const cached = join(os.homedir(), '.cache', 'tabulon', `appimagetool-${APPIMAGETOOL_VERSION}-${arch}.AppImage`);
    if (!existsSync(cached)) {
        console.log(`[fix-appimage] téléchargement d'appimagetool → ${cached}`);
        mkdirSync(dirname(cached), { recursive: true });
        execFileSync('curl', ['-fsSL', '-o', cached, APPIMAGETOOL_BASE + file], { stdio: 'inherit' });
        chmodSync(cached, 0o755);
    }
    return cached;
}

function main() {
    const arg = process.argv[2];
    const appImage = arg ? resolve(arg) : findDefaultAppImage();
    if (!appImage || !existsSync(appImage)) {
        console.error('[fix-appimage] AppImage introuvable. Usage : node scripts/fix-appimage.mjs <chemin.AppImage>');
        process.exit(1);
    }
    const arch = appimageArch(os.arch());
    if (!arch) {
        console.error(`[fix-appimage] architecture non prise en charge : ${os.arch()} (x64 ou arm64 seulement).`);
        process.exit(1);
    }
    console.log(`[fix-appimage] cible : ${appImage} (${arch})`);

    // 1. Extraire (l'AppImage sait s'auto-extraire, aucune dépendance FUSE).
    const workDir = join(os.tmpdir(), `tabulon-fix-appimage-${process.pid}`);
    mkdirSync(workDir, { recursive: true });
    chmodSync(appImage, 0o755);
    execFileSync(appImage, ['--appimage-extract'], { cwd: workDir, stdio: ['ignore', 'ignore', 'inherit'] });
    const appDir = join(workDir, 'squashfs-root');

    // 2. Purger.
    const removed = stripAppDir(appDir);
    if (removed.length === 0) {
        console.log('[fix-appimage] aucune libwayland-* dans le bundle — rien à faire (déjà purgée ?).');
        rmSync(workDir, { recursive: true, force: true });
        return;
    }
    console.log(`[fix-appimage] retirées : ${removed.join(', ')}`);
    restoreModes(appDir);

    // 3. Réempaqueter puis remplacer (original conservé en .orig). Le runtime
    // (préfixe ELF avant le squashfs) est REPRIS DE L'ORIGINALE : fidélité
    // exacte et aucun téléchargement — sans lui, appimagetool irait chercher
    // le runtime sur GitHub à chaque réempaquetage.
    const tool = findAppimagetool(arch);
    const rebuilt = join(workDir, basename(appImage));
    const runtimeArgs = [];
    const off = spawnSync(appImage, ['--appimage-offset'], { encoding: 'utf8' });
    const offset = parseInt((off.stdout || '').trim(), 10);
    if (off.status === 0 && Number.isInteger(offset) && offset > 0) {
        const buf = Buffer.alloc(offset);
        const fd = openSync(appImage, 'r');
        readSync(fd, buf, 0, offset, 0);
        closeSync(fd);
        const runtimePath = join(workDir, 'runtime');
        writeFileSync(runtimePath, buf);
        runtimeArgs.push('--runtime-file', runtimePath);
    } else {
        console.warn('[fix-appimage] offset du runtime illisible — appimagetool téléchargera le runtime officiel.');
    }
    const res = spawnSync(tool, ['--appimage-extract-and-run', ...runtimeArgs, appDir, rebuilt], {
        stdio: 'inherit',
        env: { ...process.env, ARCH: arch },
    });
    if (res.status !== 0 || !existsSync(rebuilt)) {
        console.error('[fix-appimage] échec du réempaquetage (appimagetool) — AppImage originale laissée intacte.');
        rmSync(workDir, { recursive: true, force: true });
        process.exit(1);
    }
    copyFileSync(appImage, appImage + '.orig');
    // Remplacement en deux temps : renameSync directement depuis workDir
    // echoue en EXDEV des que le repertoire temporaire est sur un autre
    // systeme de fichiers que la cible (/tmp en tmpfs sur Manjaro --
    // constate en reel, reproduit sur tmpfs). On copie donc d'abord dans le
    // REPERTOIRE CIBLE, puis rename local : meme peripherique, atomique.
    const staged = appImage + '.new';
    copyFileSync(rebuilt, staged);
    chmodSync(staged, 0o755);
    renameSync(staged, appImage);
    rmSync(workDir, { recursive: true, force: true });
    console.log(`[fix-appimage] OK : ${appImage} réempaquetée sans libwayland (original : ${basename(appImage)}.orig)`);
}

// Exécution directe seulement (import sans effet de bord pour les tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
