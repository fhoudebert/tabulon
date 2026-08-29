// src-tauri/src/commands/install_cmds.rs — que manque-t-il a cette installation ?
//
// Tabulon se telecharge comme un binaire seul. Tout le reste -- la ludotheque
// (`dist/`), le moteur natif, son reseau NNUE, les visuels, les problemes --
// s'ajoute a cote de l'executable, et rien ne le disait a l'utilisateur : il
// decouvrait une ludotheque reduite sans savoir pourquoi ni quoi faire.
//
// Ce module ne telecharge RIEN et n'ecrit RIEN. Il regarde, et il rend un etat
// que l'interface affiche. La distinction est deliberee : un `dist` contient du
// code execute par l'application, et l'installer automatiquement depuis une
// source distante demanderait un niveau de confiance que la simple validation
// d'une archive ne donne pas. On decrit, l'utilisateur decide.
//
// Les CHEMINS rendus sont ceux ou Tabulon cherche vraiment, calcules par les
// memes fonctions que la recherche elle-meme -- pas une explication generique
// qui se desynchroniserait au premier changement.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::commands::engine_cmds;
use crate::dist_override;

/// Un element d'installation : present ou non, et ou le poser.
#[derive(Serialize)]
pub struct InstallItem {
    /// Identifiant stable, pour l'i18n et les tests.
    pub id: &'static str,
    /// L'element est-il en place ?
    pub present: bool,
    /// Ou il a ete trouve, quand il l'a ete.
    pub path: Option<String>,
    /// Ou le poser quand il manque -- le premier emplacement fouille.
    pub expected: Option<String>,
    /// Detail libre : nombre de jeux, nom du moteur... Rempli par l'appelant
    /// quand il en sait plus.
    pub detail: Option<String>,
}

/// L'etat complet de l'installation.
#[derive(Serialize)]
pub struct InstallStatus {
    /// La ludotheque vient-elle d'un `dist/` externe, ou de l'embarque minimal ?
    pub external_dist: bool,
    /// Le systeme, pour nommer le bon fichier (`.exe` ou non) et la bonne
    /// archive de release.
    pub platform: &'static str,
    /// Le nom exact du binaire de moteur cherche sur CE systeme.
    pub engine_file: String,
    pub items: Vec<InstallItem>,
}

/// Le premier emplacement fouille par `binary_path` : `engine/` a cote de
/// l'executable. C'est celui qu'on montre a l'utilisateur, parce que c'est
/// celui qui marche partout de la meme facon.
fn engine_dir() -> Option<PathBuf> {
    if let Ok(appimage) = std::env::var("APPIMAGE") {
        if let Some(dir) = Path::new(&appimage).parent() {
            return Some(dir.join("engine"));
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join("engine")))
}

/// Le repertoire ou poser un `dist/`, meme logique.
fn dist_dir() -> Option<PathBuf> {
    if let Ok(appimage) = std::env::var("APPIMAGE") {
        if let Some(dir) = Path::new(&appimage).parent() {
            return Some(dir.join("dist"));
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join("dist")))
}

fn show(p: Option<PathBuf>) -> Option<String> {
    p.map(|p| p.display().to_string())
}

/// Un fichier NNUE, quel que soit son nom : Fairy-Stockfish exige que le nom
/// commence par celui de la variante, donc on ne peut pas en chercher un en
/// particulier -- on regarde s'il y en a.
fn any_nnue(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("nnue") {
            return Some(path);
        }
    }
    None
}

#[tauri::command]
pub fn install_status() -> InstallStatus {
    let platform = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    let engine_file = if cfg!(target_os = "windows") {
        "fairy-stockfish.exe".to_string()
    } else {
        "fairy-stockfish".to_string()
    };

    let dist = dist_override::external_dist().map(|p| p.to_path_buf());
    let engine = engine_cmds::engine_path();
    let scan = engine_cmds::binary_path("scan", "TABULON_SCAN");
    // Le NNUE se cherche a cote du moteur : c'est la que le moteur le lira.
    let nnue = engine
        .as_ref()
        .and_then(|e| e.parent().map(Path::to_path_buf))
        .and_then(|dir| any_nnue(&dir));

    let items = vec![
        InstallItem {
            id: "dist",
            present: dist.is_some(),
            path: show(dist.clone()),
            expected: show(dist_dir()),
            detail: None,
        },
        InstallItem {
            id: "engine",
            present: engine.is_some(),
            path: show(engine.clone()),
            expected: show(engine_dir().map(|d| d.join(&engine_file))),
            detail: None,
        },
        InstallItem {
            id: "scan",
            present: scan.is_some(),
            path: show(scan),
            expected: show(engine_dir().map(|d| d.join(if cfg!(target_os = "windows") {
                "scan.exe"
            } else {
                "scan"
            }))),
            detail: None,
        },
        InstallItem {
            id: "nnue",
            present: nnue.is_some(),
            path: show(nnue),
            expected: show(engine_dir()),
            detail: None,
        },
    ];

    InstallStatus {
        external_dist: dist.is_some(),
        platform,
        engine_file,
        items,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nnue_is_found_by_extension_not_by_name() {
        // Fairy-Stockfish exige que le nom du reseau commence par celui de la
        // variante : on ne peut donc pas chercher un nom precis, seulement
        // constater qu'un reseau est present.
        let dir = std::env::temp_dir().join("tabulon-install-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(any_nnue(&dir).is_none(), "repertoire vide : aucun reseau");

        std::fs::write(dir.join("shako.nnue"), b"x").unwrap();
        let found = any_nnue(&dir).expect("le reseau doit etre vu");
        assert_eq!(found.extension().and_then(|e| e.to_str()), Some("nnue"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_plain_file_is_not_a_network() {
        let dir = std::env::temp_dir().join("tabulon-install-test-2");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("README.txt"), b"x").unwrap();
        assert!(any_nnue(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_names_the_binary_for_this_platform() {
        let status = install_status();
        if cfg!(target_os = "windows") {
            assert!(status.engine_file.ends_with(".exe"));
        } else {
            assert!(!status.engine_file.ends_with(".exe"));
        }
        // Quatre elements decrits, chacun avec un identifiant stable.
        let ids: Vec<&str> = status.items.iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["dist", "engine", "scan", "nnue"]);
        // Un element absent doit dire OU le poser, sinon le panneau ne sert a
        // rien : c'est tout l'objet de cette commande.
        for item in &status.items {
            if !item.present {
                assert!(item.expected.is_some(), "{} sans emplacement", item.id);
            }
        }
    }
}
