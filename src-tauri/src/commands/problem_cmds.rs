// src-tauri/src/commands/problem_cmds.rs
//
// Répertoire `problems/` EXTERNE : des parties d'exemple posées à côté de
// l'exécutable, hors du binaire, que l'écran « Charger une partie » présente
// en onglets.
//
// Pourquoi dehors ? Les exemples étaient écrits en dur dans un module JS
// (sample-books.js) : en ajouter un demandait de recompiler, et ils ne
// pouvaient pas suivre les jeux. Un dossier posé sur le disque se distribue
// séparément — comme le `dist/` externe dont il dépend, puisqu'un sous-dossier
// ne vaut que si le jeu du même nom est installé.
//
// Convention :
//   problems/<nom-de-jeu-jocly>/<partie>.pjn|.pgn|.json
//   problems/<nom-de-jeu-jocly>/<partie>-thumb.jpg|.png   (vignette, facultatif)
//
// Un sous-dossier = un onglet, nommé d'après le jeu Jocly qu'il vise
// (`classic-chess`, `chu-shogi`, `ultima`…). C'est ce nom qui permet à l'UI de
// savoir si le jeu est présent dans le dist et de proposer, ou non, le
// lancement.
//
// Pourquoi `problems/` et non `games/` : `games/` est DÉJÀ le dossier des
// modules de jeu Jocly à l'intérieur du dist. Un second `games/` à côté de
// l'exécutable prêterait à confusion et se retrouverait tôt ou tard confondu
// avec lui dans un script de packaging.
//
// Emplacements testés, dans l'ordre (premier trouvé) :
//   1. $TABULON_PROBLEMS (chemin absolu ; vide ou "none" désactive)
//   2. <dossier de l'exécutable>/problems, puis ../problems, puis ../../../problems
//      (mêmes bases que dist_override : AppImage, .app macOS, exe imbriqué)
//   3. <dist externe>/../problems et <dist externe>/problems — pour livrer
//      les exemples DANS le paquet du dist plutôt qu'à côté de l'exe.

use base64::Engine;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static PROBLEMS_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

const GAME_EXT:  [&str; 4] = ["pjn", "pgn", "pdn", "json"];
const THUMB_EXT: [&str; 4] = ["png", "jpg", "jpeg", "webp"];

/// Résout (une seule fois) le dossier `problems/`, s'il existe.
pub fn problems_dir() -> Option<&'static Path> {
    PROBLEMS_DIR
        .get_or_init(|| {
            if let Ok(p) = std::env::var("TABULON_PROBLEMS") {
                if p.is_empty() || p == "none" {
                    log::info!("répertoire problems désactivé (TABULON_PROBLEMS={p:?})");
                    return None;
                }
                let p = PathBuf::from(p);
                if p.is_dir() {
                    log::info!("problems (TABULON_PROBLEMS) : {}", p.display());
                    return Some(p);
                }
                log::warn!("TABULON_PROBLEMS={p:?} : ce dossier n'existe pas");
            }

            let mut bases: Vec<PathBuf> = Vec::new();
            // AppImage : current_exe() pointe dans le montage temporaire, pas
            // là où l'utilisateur a posé le fichier. Même raison que dans
            // dist_override.
            if let Ok(appimage) = std::env::var("APPIMAGE") {
                if let Some(dir) = Path::new(&appimage).parent() {
                    bases.push(dir.to_path_buf());
                }
            }
            if let Ok(exe) = std::env::current_exe() {
                if let Some(dir) = exe.parent() {
                    bases.push(dir.to_path_buf());
                    bases.push(dir.join(".."));
                    bases.push(dir.join("..").join("..").join(".."));
                }
            }
            // Livré avec le dist externe plutôt qu'avec l'exécutable.
            if let Some(dist) = crate::dist_override::external_dist() {
                if let Some(parent) = dist.parent() { bases.push(parent.to_path_buf()); }
                bases.push(dist.to_path_buf());
            }

            for base in bases {
                let cand = base.join("problems");
                if cand.is_dir() {
                    let shown = std::fs::canonicalize(&cand).unwrap_or(cand.clone());
                    log::info!("problems : {}", shown.display());
                    return Some(cand);
                }
            }
            log::info!("aucun répertoire problems — l'écran de chargement n'affichera pas d'exemples");
            None
        })
        .as_deref()
}

/// Refuse tout nom de sous-dossier qui n'est pas un simple segment : le nom
/// vient de l'UI, donc potentiellement d'un renderer compromis.
fn safe_group(group: &str) -> Result<&str, String> {
    if group.is_empty()
        || group.contains('/') || group.contains('\\')
        || group.contains("..") || group.starts_with('.')
    {
        return Err(format!("problems : nom de groupe refusé ('{group}')"));
    }
    Ok(group)
}

fn ext_of(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}
fn stem_of(p: &Path) -> String {
    p.file_stem().and_then(|e| e.to_str()).unwrap_or("").to_string()
}

/// rpc.call("listProblemGroups")
///
/// Liste les onglets : un par sous-dossier contenant au moins une partie.
/// Renvoie aussi le chemin résolu, que l'UI affiche pour que l'utilisateur
/// sache OÙ déposer ses fichiers (la question qui se pose immédiatement quand
/// l'écran est vide).
#[tauri::command]
pub fn list_problem_groups() -> Result<serde_json::Value, String> {
    let Some(dir) = problems_dir() else {
        return Ok(serde_json::json!({ "dir": null, "groups": [] }));
    };
    let mut groups = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| format!("problems : lecture de '{}' impossible : {e}", dir.display()))?
        .filter_map(Result::ok)
        .collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let path = entry.path();
        if !path.is_dir() { continue; }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') { continue; }
        let count = std::fs::read_dir(&path)
            .map(|rd| rd.filter_map(Result::ok)
                .filter(|f| GAME_EXT.contains(&ext_of(&f.path()).as_str()))
                .count())
            .unwrap_or(0);
        if count > 0 {
            groups.push(serde_json::json!({ "name": name, "count": count }));
        }
    }
    Ok(serde_json::json!({ "dir": dir.to_string_lossy(), "groups": groups }))
}

/// rpc.call("readProblemGroup", group)
///
/// Contenu d'un onglet : le TEXTE de chaque partie (l'UI le passe au même
/// circuit qu'un fichier choisi à la main) et sa vignette en data: URL.
///
/// Les vignettes sont renvoyées en base64 plutôt que par une URL de fichier :
/// la webview ne peut pas lire file:// et le protocole `tabulon-dist://` est
/// enraciné dans le dist, pas ici. Elles ne sont lues que pour le groupe
/// demandé — un dossier de 200 problèmes ne doit pas transiter d'un bloc.
///
/// Association fichier → vignette, du plus strict au plus lâche :
///   1. `<nom>-thumb.<img>`   (convention recommandée)
///   2. `<nom>.<img>`         (l'image porte le nom de la partie)
///   3. une image dont le nom, débarrassé de `-thumb`, est un suffixe du nom
///      de la partie (ou l'inverse) — rattrape `p1-thumb.jpg` en face de
///      `ultima-solutionP1.json`. En cas d'égalité, la correspondance la plus
///      longue gagne, pour que le résultat ne dépende pas de l'ordre du
///      système de fichiers.
/// Sans image, `thumbnail` est null et l'UI retombe sur la miniature du jeu.
#[tauri::command]
pub fn read_problem_group(group: String) -> Result<Vec<serde_json::Value>, String> {
    let group = safe_group(&group)?;
    let Some(dir) = problems_dir() else {
        return Err("problems : aucun répertoire d'exemples".into());
    };
    let path = dir.join(group);
    if !path.is_dir() {
        return Err(format!("problems : '{group}' n'est pas un dossier d'exemples"));
    }

    let mut files: Vec<PathBuf> = std::fs::read_dir(&path)
        .map_err(|e| format!("problems : lecture de '{}' impossible : {e}", path.display()))?
        .filter_map(Result::ok).map(|e| e.path()).collect();
    files.sort();

    let games:  Vec<&PathBuf> = files.iter().filter(|p| GAME_EXT.contains(&ext_of(p).as_str())).collect();
    let images: Vec<&PathBuf> = files.iter().filter(|p| THUMB_EXT.contains(&ext_of(p).as_str())).collect();

    let mut out = Vec::new();
    for game in games {
        let stem = stem_of(game);
        let low  = stem.to_ascii_lowercase();
        let mut best: Option<(usize, &PathBuf)> = None;
        for img in &images {
            let istem = stem_of(img);
            let ilow  = istem.to_ascii_lowercase();
            let bare  = ilow.strip_suffix("-thumb").unwrap_or(&ilow).to_string();
            let score = if ilow == format!("{low}-thumb") { 1000 }
                        else if ilow == low               { 900 }
                        else if bare == low               { 800 }
                        else if !bare.is_empty() && (low.ends_with(&bare) || bare.ends_with(&low)) { bare.len() }
                        else { 0 };
            if score > 0 && best.map_or(true, |(b, _)| score > b) { best = Some((score, img)); }
        }
        let thumbnail = best.and_then(|(_, img)| std::fs::read(img).ok().map(|bytes| {
            let mime = match ext_of(img).as_str() {
                "png" => "image/png", "webp" => "image/webp", _ => "image/jpeg",
            };
            format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
        }));

        // Un fichier illisible (droits, binaire mal nommé) ne doit pas faire
        // échouer tout l'onglet : on le saute en le signalant.
        let text = match std::fs::read_to_string(game) {
            Ok(t) => t,
            Err(e) => { log::warn!("problems : '{}' ignoré : {e}", game.display()); continue; }
        };
        out.push(serde_json::json!({
            "group": group,
            "file":  game.file_name().and_then(|n| n.to_str()).unwrap_or(""),
            "stem":  stem,
            "ext":   ext_of(game),
            "text":  text,
            "thumbnail": thumbnail,
        }));
    }
    Ok(out)
}
