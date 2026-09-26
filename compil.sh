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
# Usage :   ./compil.sh              (arguments supplementaires passes a
#           ./compil.sh --verbose     `tauri build`, ex. --verbose pour voir
#                                     la sortie de linuxdeploy)
# Sortie :  l'AppImage purgée et vérifiée, dans
#           src-tauri/target/release/bundle/appimage/
#           (l'originale non purgée est conservée en .AppImage.orig —
#           NE PAS distribuer le .orig)

set -euo pipefail
cd "$(dirname "$0")"

# ── Construire l'AppImage sur n'importe quelle distribution ─────────────────
#
# `tauri build` fabrique l'AppImage avec linuxdeploy, qui est LUI-MEME une
# AppImage et qui passe `strip` sur toutes les bibliotheques embarquees. Deux
# pannes connues hors Debian/Ubuntu, avec le meme message final
# « failed to run linuxdeploy » :
#
#  1. FUSE. Lancer une AppImage demande libfuse2 ; Arch/Manjaro n'installent
#     que fuse3 par defaut. APPIMAGE_EXTRACT_AND_RUN=1 fait extraire puis
#     lancer linuxdeploy sans FUSE : sans effet la ou FUSE marche, donc pose
#     partout.
#  2. strip. Le strip embarque dans linuxdeploy est ancien : il ne sait pas
#     traiter les bibliotheques des distributions recentes a mise a jour
#     continue (sections .relr.dyn, « unknown type [0x13] section »). On le
#     neutralise par NO_STRIP=true -- SEULEMENT sur ces distributions : ailleurs
#     il marche et reduit la taille de l'AppImage.
#
# Une valeur deja posee dans l'environnement l'emporte toujours.
export APPIMAGE_EXTRACT_AND_RUN="${APPIMAGE_EXTRACT_AND_RUN:-1}"
if [ -z "${NO_STRIP+x}" ] && [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    os_ids="$(. /etc/os-release; echo " ${ID:-} ${ID_LIKE:-} ")"
    case "$os_ids" in
        *" arch "*|*" manjaro "*|*" endeavouros "*|*" opensuse-tumbleweed "*|*" gentoo "*)
            export NO_STRIP=true
            echo "compil.sh : distribution à mise à jour continue ($os_ids) → NO_STRIP=true" ;;
    esac
fi

echo "== [1/3] Build (npm run build : check-dist + frontend + tauri build) =="
if ! npm run build -- "$@"; then
    cat >&2 <<'MSG'

compil.sh : le build a échoué.
Si le message final est « failed to run linuxdeploy », relancer avec
    ./compil.sh --verbose
pour voir la vraie erreur de linuxdeploy, puis selon ce qu'elle dit :
  - « fuse » / « libfuse.so.2 »            → APPIMAGE_EXTRACT_AND_RUN=1 (posé par défaut)
  - « strip » / « unknown type » / « .relr.dyn » → NO_STRIP=true ./compil.sh
  - un fichier ou une bibliothèque introuvable → installer le paquet de
    développement correspondant (webkit2gtk-4.1, gtk3, librsvg...).
MSG
    exit 1
fi

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
