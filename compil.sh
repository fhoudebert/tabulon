#!/usr/bin/env bash
# compil.sh — Construit Tabulon PUIS applique le post-traitement AppImage,
# avec auto-vérification. À utiliser à la place de `npm run build` seul.
#
# Pourquoi ce script existe : le correctif AppImage pour Arch/Manjaro
# (purge des libwayland-* embarquées, voir DEVELOPMENT.md § Troubleshooting
# AppImage) est un POST-TRAITEMENT — `tauri build` reproduit à chaque fois
# une AppImage non purgée. Un build lancé sans la purge redonne exactement
# le même échec `EGL_BAD_PARAMETER`, ce qui s'est produit en test réel.
# Ce script enchaîne build → purge → PREUVE (ré-extraction et vérification
# qu'aucune libwayland-* ne subsiste), et échoue bruyamment sinon.
#
# Usage :   ./compil.sh
# Sortie :  l'AppImage purgée et vérifiée, dans
#           src-tauri/target/release/bundle/appimage/
#           (l'originale non purgée est conservée en .AppImage.orig —
#           NE PAS distribuer le .orig)

set -euo pipefail
cd "$(dirname "$0")"

echo "== [1/3] Build (npm run build : check-dist + frontend + tauri build) =="
npm run build

APPIMAGE_DIR="src-tauri/target/release/bundle/appimage"
shopt -s nullglob
apps=("$APPIMAGE_DIR"/*.AppImage)
shopt -u nullglob
if [ ${#apps[@]} -eq 0 ]; then
    echo "compil.sh : aucune AppImage produite dans $APPIMAGE_DIR — rien à purger" >&2
    echo "(build non-Linux ou bundle AppImage désactivé : c'est peut-être normal)" >&2
    exit 0
fi

echo "== [2/3] Purge des libwayland-* embarquées (scripts/fix-appimage.mjs) =="
for app in "${apps[@]}"; do
    case "$app" in *.orig) continue;; esac
    node scripts/fix-appimage.mjs "$app"
done

echo "== [3/3] Preuve : ré-extraction et vérification de chaque AppImage =="
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
for app in "${apps[@]}"; do
    case "$app" in *.orig) continue;; esac
    rm -rf "$workdir/squashfs-root"
    ( cd "$workdir" && "$OLDPWD/$app" --appimage-extract >/dev/null )
    leftovers="$(ls "$workdir/squashfs-root/usr/lib" | grep -E '^libwayland-' || true)"
    if [ -n "$leftovers" ]; then
        echo "compil.sh : ÉCHEC — $app contient encore : $leftovers" >&2
        exit 1
    fi
    echo "OK : $(basename "$app") — aucune libwayland-* embarquée (vérifié par extraction)"
done

echo
echo "Build terminé et vérifié. AppImage à distribuer/tester :"
for app in "${apps[@]}"; do
    case "$app" in *.orig) continue;; esac
    echo "  $app"
done
echo "(le .AppImage.orig est l'originale NON corrigée — ne pas la distribuer)"
