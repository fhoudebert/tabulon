// src-tauri/src/dist_override.rs
//
// Charge un dossier `dist/` EXTERNE placé à côté de l'exécutable, en priorité
// sur le `dist/` embarqué dans le binaire au build.
//
// Pourquoi un protocole custom et pas juste frontendDist ?
//   Les pages (app/content/*.html) chargent le moteur et les jeux par des URL
//   RELATIVES : `<script src="../browser/jocly.js">`, `<img src=".../games/…">`,
//   `fetch('…/games/…')`. Ces URL sont résolues par le protocole d'app de la
//   webview, sur les assets EMBARQUÉS — un dossier posé sur le disque à côté
//   de l'exe n'est jamais consulté. On intercepte donc la résolution.
//
// Stratégie : on enregistre un protocole `tabulon-dist://` et on RÉÉCRIT, à la
// construction de chaque fenêtre, les `../browser/…` et `../games/…` des pages
// pour qu'ils passent par ce protocole (voir asset_rewrite.js, injecté). Le
// protocole tente d'abord le dist externe, puis retombe sur l'asset embarqué.
//
// Emplacement du dist externe (premier trouvé) :
//   1. variable d'env TABULON_DIST (chemin absolu) — échappatoire/tests
//   2. <dossier de l'exécutable>/dist
//   3. <dossier de l'exécutable>/../dist  (utile sous macos .app/AppImage)
// Si aucun n'existe, tout retombe sur l'embarqué : comportement inchangé.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Runtime};
use tauri::http::{Request, Response};

static EXTERNAL_DIST: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Résout (une seule fois) le dossier dist externe, s'il existe.
pub fn external_dist() -> Option<&'static Path> {
    EXTERNAL_DIST
        .get_or_init(|| {
            if let Ok(p) = std::env::var("TABULON_DIST") {
                let p = PathBuf::from(p);
                if p.join("browser").is_dir() {
                    log::info!("dist externe (TABULON_DIST) : {}", p.display());
                    return Some(p);
                }
            }
            if let Ok(exe) = std::env::current_exe() {
                if let Some(dir) = exe.parent() {
                    for cand in [dir.join("dist"), dir.join("..").join("dist")] {
                        if cand.join("browser").is_dir() {
                            log::info!("dist externe : {}", cand.display());
                            return Some(cand);
                        }
                    }
                }
            }
            log::info!("aucun dist externe — utilisation des assets embarqués");
            None
        })
        .as_deref()
}

/// true si un dist externe est utilisable (exposé à l'UI via une commande).
pub fn has_external_dist() -> bool {
    external_dist().is_some()
}

/// Devine le Content-Type d'après l'extension (suffisant pour les assets Jocly).
fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

/// Empêche la traversée de répertoire (`..`, chemins absolus, backslash).
fn safe_rel(path: &str) -> Option<String> {
    let path = path.trim_start_matches('/');
    if path.is_empty() { return None; }
    let mut clean = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => continue,
            ".." => return None,                 // pas de remontée
            s if s.contains('\\') => return None,
            s => clean.push(s),
        }
    }
    if clean.is_empty() { None } else { Some(clean.join("/")) }
}

/// Handler du protocole `tabulon-dist://localhost/<rel>`.
/// Sert d'abord le dist externe, puis retombe sur l'asset embarqué.
pub fn handle_request<R: Runtime>(app: &AppHandle<R>, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    // URL de la forme tabulon-dist://localhost/browser/jocly.js
    let uri = req.uri().to_string();
    let rel = uri
        .split("://")
        .nth(1)
        .and_then(|rest| rest.splitn(2, '/').nth(1))   // retire l'hôte
        .map(|s| s.split(['?', '#']).next().unwrap_or("").to_string())
        .unwrap_or_default();

    let not_found = || Response::builder().status(404).body(Vec::new()).unwrap();

    let Some(rel) = safe_rel(&rel) else { return not_found(); };

    // 1. dist externe
    if let Some(dir) = external_dist() {
        let full = dir.join(&rel);
        if full.is_file() {
            match std::fs::read(&full) {
                Ok(bytes) => return Response::builder()
                    .status(200)
                    .header("Content-Type", mime_for(&rel))
                    .header("Access-Control-Allow-Origin", "*")
                    .body(bytes)
                    .unwrap(),
                Err(e) => { log::warn!("dist externe illisible {}: {e}", full.display()); }
            }
        }
    }

    // 2. repli : asset embarqué (même arbre virtuel que frontendDist)
    if let Some(asset) = app.asset_resolver().get(rel.clone()) {
        return Response::builder()
            .status(200)
            .header("Content-Type", mime_for(&rel))
            .header("Access-Control-Allow-Origin", "*")
            .body(asset.bytes)
            .unwrap();
    }

    not_found()
}
