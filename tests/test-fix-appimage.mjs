// test-fix-appimage.mjs — logique pure de scripts/fix-appimage.mjs :
// périmètre exact de la purge (uniquement libwayland-*, validé sur machine
// Arch touchée) et purge d'un AppDir factice.
//
// Usage : node tests/test-fix-appimage.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, chmodSync, statSync, symlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { shouldStrip, stripAppDir, appimageArch, restoreModes, releaseName, updateInformation } from '../scripts/fix-appimage.mjs';

let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}

// ── 1. Le périmètre de purge : toute la famille libwayland-*, rien qu'elle ──
for (const f of ['libwayland-client.so.0', 'libwayland-cursor.so.0',
                 'libwayland-egl.so.1', 'libwayland-server.so.0',
                 'libwayland-client.so.0.3.0']) {
    assert(shouldStrip(f) === true, `purgé : ${f}`);
}
for (const f of ['libwebkit2gtk-4.1.so.0',      // retirer WebKit CASSE (test D terrain)
                 'libjavascriptcoregtk-4.1.so.0',
                 'libgtk-3.so.0', 'libglib-2.0.so.0', 'libgdk-3.so.0',
                 'im-wayland.so',               // module IM GTK : pas une libwayland-*
                 'libwayland.so',               // nom hors famille réelle
                 'wayland-scanner']) {
    assert(shouldStrip(f) === false, `conservé : ${f}`);
}

// ── 2. Purge d'un AppDir factice ─────────────────────────────────────────────
{
    const dir = mkdtempSync(join(os.tmpdir(), 'fix-appimage-test-'));
    const lib = join(dir, 'usr', 'lib');
    mkdirSync(lib, { recursive: true });
    for (const f of ['libwayland-client.so.0', 'libwayland-egl.so.1',
                     'libwebkit2gtk-4.1.so.0', 'libgtk-3.so.0', 'im-wayland.so']) {
        writeFileSync(join(lib, f), 'stub');
    }
    const removed = stripAppDir(dir).sort();
    assert(JSON.stringify(removed) === JSON.stringify(['libwayland-client.so.0', 'libwayland-egl.so.1']),
        'stripAppDir retire exactement les libwayland-*');
    const left = readdirSync(lib).sort();
    assert(JSON.stringify(left) === JSON.stringify(['im-wayland.so', 'libgtk-3.so.0', 'libwebkit2gtk-4.1.so.0']),
        'le reste du bundle est intact (WebKit, GTK, module IM)');
    assert(JSON.stringify(stripAppDir(dir)) === JSON.stringify([]),
        'idempotent : une seconde purge ne retire rien');
    rmSync(dir, { recursive: true, force: true });
}

// ── 3. Architecture : nom AppImage (appimagetool téléchargé, ARCH) ───────────
assert(appimageArch('x64') === 'x86_64', 'x64 → x86_64');
assert(appimageArch('arm64') === 'aarch64', 'arm64 → aarch64 (runner ubuntu-22.04-arm)');
for (const a of ['arm', 'ia32', 'riscv64', 'ppc64', undefined]) {
    assert(appimageArch(a) === null, `non pris en charge : ${a}`);
}

// ── 4. Droits rendus après extraction (équivalent chmod -R a+rX) ─────────────
// --appimage-extract recrée les répertoires en 0700 (constaté) ; appimagetool
// récent refuse alors d'empaqueter. Les fichiers non exécutables le restent.
{
    const dir = mkdtempSync(join(os.tmpdir(), 'fix-appimage-modes-'));
    const lib = join(dir, 'usr', 'lib');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(dir, 'AppRun'), '#!/bin/sh\n');
    writeFileSync(join(lib, 'libgtk-3.so.0'), 'stub');
    symlinkSync('usr/lib/libgtk-3.so.0', join(dir, 'lien'));
    chmodSync(join(dir, 'AppRun'), 0o700);
    chmodSync(join(lib, 'libgtk-3.so.0'), 0o600);
    for (const d of [lib, join(dir, 'usr'), dir]) chmodSync(d, 0o700);
    const mode = (p) => (statSync(p).mode & 0o777).toString(8);
    const n = restoreModes(dir);
    assert(mode(dir) === '755' && mode(join(dir, 'usr')) === '755' && mode(lib) === '755',
        'répertoires 0700 → 0755 (racine comprise)');
    assert(mode(join(dir, 'AppRun')) === '755', 'exécutable 0700 → 0755');
    assert(mode(join(lib, 'libgtk-3.so.0')) === '644', 'fichier 0600 → 0644, sans bit x ajouté');
    assert(lstatSync(join(dir, 'lien')).isSymbolicLink(), 'lien symbolique laissé tel quel');
    assert(n === 5 && restoreModes(dir) === 0, 'idempotent : un second passage ne change rien');
    rmSync(dir, { recursive: true, force: true });
}

// ── 5. AppDir sans usr/lib : ne pas exploser ─────────────────────────────────
{
    const dir = mkdtempSync(join(os.tmpdir(), 'fix-appimage-empty-'));
    assert(JSON.stringify(stripAppDir(dir)) === JSON.stringify([]),
        'AppDir sans usr/lib toléré (liste vide)');
    rmSync(dir, { recursive: true, force: true });
}

// ── 6. Publication : nom et information de mise à jour ──────────────────────
{
    const throws = (f) => { try { f(); return false; } catch { return true; } };
    assert(releaseName('minimal', '1.2.0', 'x86_64') === 'Tabulon-minimal-1.2.0-x86_64.AppImage',
        'nom publié : Tabulon-<variante>-<version>-<arch>.AppImage');
    assert(releaseName('selection', '1.2.0-rc1', 'aarch64') === 'Tabulon-selection-1.2.0-rc1-aarch64.AppImage',
        'pré-version et ARM64');
    assert(throws(() => releaseName('all', '1.2.0', 'x86_64')), 'variante inconnue refusée');
    assert(throws(() => releaseName('minimal', 'v1.2', 'x86_64')), 'version invalide refusée');
    const u = updateInformation('fhoudebert/tabulon', 'selection', 'x86_64');
    assert(u === 'gh-releases-zsync|fhoudebert|tabulon|latest|Tabulon-selection-*-x86_64.AppImage.zsync',
        'gh-releases-zsync : dernière release, même variante, même architecture');
    // le motif doit reconnaître le .zsync du nom publié, et lui seul
    const glob = u.split('|')[4];
    const re = new RegExp('^' + glob.replace(/[.]/g, '\\.').replace(/\*/g, '.*') + '$');
    assert(re.test(releaseName('selection', '9.9.9', 'x86_64') + '.zsync'), 'le motif reconnaît le .zsync publié');
    assert(!re.test(releaseName('minimal', '9.9.9', 'x86_64') + '.zsync'), 'pas celui de l\'autre variante');
    assert(!re.test(releaseName('selection', '9.9.9', 'aarch64') + '.zsync'), 'ni celui de l\'autre architecture');
    assert(throws(() => updateInformation('tabulon', 'minimal', 'x86_64')), 'dépôt sans propriétaire refusé');
    assert(throws(() => updateInformation('a/b|c', 'minimal', 'x86_64')), 'séparateur | refusé dans le dépôt');
}

console.log(`\ntest-fix-appimage: ${passed} assertions OK`);
