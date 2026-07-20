// test-fix-appimage.mjs — logique pure de scripts/fix-appimage.mjs :
// périmètre exact de la purge (uniquement libwayland-*, validé sur machine
// Arch touchée) et purge d'un AppDir factice.
//
// Usage : node tests/test-fix-appimage.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { shouldStrip, stripAppDir } from '../scripts/fix-appimage.mjs';

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

// ── 3. AppDir sans usr/lib : ne pas exploser ─────────────────────────────────
{
    const dir = mkdtempSync(join(os.tmpdir(), 'fix-appimage-empty-'));
    assert(JSON.stringify(stripAppDir(dir)) === JSON.stringify([]),
        'AppDir sans usr/lib toléré (liste vide)');
    rmSync(dir, { recursive: true, force: true });
}

console.log(`\ntest-fix-appimage: ${passed} assertions OK`);
