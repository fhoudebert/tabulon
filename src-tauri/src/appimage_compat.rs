// src-tauri/src/appimage_compat.rs -- Garde-fou de demarrage pour les
// AppImages Linux.
//
// Contexte (constate sur Manjaro, AppImage construite sur base Debian) :
//   Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
// C'est une classe de panne connue des applications Tauri distribuees en
// AppImage (tauri-apps/tauri#11988/#11994, clos "Not Planned" en amont) :
// l'AppImage embarque des bibliotheques construites sur une distribution
// donnee, et sur un hote plus recent (Arch/Manjaro, Fedora...) le rendu
// DMA-BUF de WebKitGTK -- voire la creation meme du display EGL -- echoue
// au melange des pilotes/libs de l'hote avec celles de l'image.
//
// Ce module n'agit QUE lorsque le processus tourne depuis une AppImage
// (variable APPIMAGE posee par le runtime AppImage) : les installations
// natives (paquet Debian, cargo run...) ne sont jamais affectees. Et il
// respecte l'utilisateur : une variable deja posee (meme a "0" pour forcer
// le comportement d'origine) n'est jamais ecrasee.
//
// Ce qui est applique automatiquement :
//   WEBKIT_DISABLE_DMABUF_RENDERER=1  -- desactive le chemin DMA-BUF de
//     WebKitGTK, le correctif documente pour la majorite des cas (NVIDIA
//     proprietaire, melanges de pilotes). Cout : un chemin de rendu moins
//     direct ; la 3D/WebGL reste fonctionnelle.
//
// Ce qui n'est PAS applique automatiquement (documente dans DEVELOPMENT.md,
// a escalader manuellement si le cas Manjaro persiste -- il existe des
// hotes Arch ou la variable ne suffit pas car l'echec EGL precede WebKit) :
//   WEBKIT_DISABLE_COMPOSITING_MODE=1   (degrade davantage le rendu)
//   GDK_BACKEND=x11                     (force XWayland)
//   LD_PRELOAD=<libwayland-client.so.0 du systeme>  (conflit d'ordre de
//     bibliotheques AppImage/hote sous Wayland ; demanderait un re-exec
//     pour etre automatise -- volontairement pas fait tant que le besoin
//     n'est pas confirme empiriquement sur une machine touchee)

/// Decision pure (testable sans toucher au vrai environnement) : etant
/// donne "sommes-nous dans une AppImage" et un lecteur d'environnement,
/// renvoie les variables a poser.
pub(crate) fn appimage_env_fixes(
    is_appimage: bool,
    env_get: impl Fn(&str) -> Option<String>,
) -> Vec<(&'static str, &'static str)> {
    if !is_appimage {
        return Vec::new();
    }
    let mut fixes = Vec::new();
    if env_get("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        fixes.push(("WEBKIT_DISABLE_DMABUF_RENDERER", "1"));
    }
    fixes
}

/// A appeler tot dans run(), AVANT toute initialisation GTK/WebKit (la
/// creation du premier webview lit ces variables).
pub(crate) fn apply() {
    let is_appimage = std::env::var_os("APPIMAGE").is_some();
    for (name, value) in appimage_env_fixes(is_appimage, |k| std::env::var(k).ok()) {
        // set_var avant tout thread GTK/webview : appele en tete de run().
        std::env::set_var(name, value);
        eprintln!("[tabulon] AppImage : {name}={value} (contournement WebKitGTK/EGL, \
                   posez la variable vous-meme pour un autre reglage)");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> =
            pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k: &str| map.get(k).cloned()
    }

    /// Hors AppImage : ne jamais rien toucher (installations natives).
    #[test]
    fn natif_jamais_modifie() {
        assert!(appimage_env_fixes(false, env(&[])).is_empty());
    }

    /// AppImage, environnement vierge : le contournement DMA-BUF est pose.
    #[test]
    fn appimage_pose_dmabuf() {
        let fixes = appimage_env_fixes(true, env(&[]));
        assert_eq!(fixes, vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]);
    }

    /// Le choix explicite de l'utilisateur n'est JAMAIS ecrase -- y compris
    /// "0" pour reactiver volontairement le rendu DMA-BUF dans l'AppImage.
    #[test]
    fn variable_utilisateur_respectee() {
        let fixes = appimage_env_fixes(true, env(&[("WEBKIT_DISABLE_DMABUF_RENDERER", "0")]));
        assert!(fixes.is_empty());
        let fixes = appimage_env_fixes(true, env(&[("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]));
        assert!(fixes.is_empty());
    }
}
