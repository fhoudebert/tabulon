// src-tauri/src/window_manager.rs
//
// Ouverture/focus des fenêtres secondaires Tauri + persistance de leur
// géométrie dans le store, et vérification de mise à jour au démarrage.
//
// Toutes les fenêtres de Tabulon sont des WebviewWindow pointant vers une
// page de app/content/*.html (servie depuis frontendDist). Le SharedWorker
// (app/worker/match-worker.js) ne peut pas créer de fenêtre lui-même : il
// demande à Rust de le faire via les commandes de match_cmds.rs/window_cmds.rs,
// qui appellent open_window() ci-dessous.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const STORE_FILE: &str = "tabulon.json";

/// Paramètres d'ouverture d'une fenêtre. `persist_key` désigne la clé sous
/// laquelle la géométrie (position + taille) est sauvegardée/restaurée dans
/// le store ; `None` signifie "ne pas persister" (fenêtres ponctuelles comme
/// les dialogues players/view-options).
pub struct WindowOptions<'a> {
    pub label: &'a str,
    pub url: &'a str,
    pub title: &'a str,
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub min_height: f64,
    pub persist_key: Option<String>,
}

/// Géométrie persistée d'une fenêtre (position + taille).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct Geometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Ouvre une fenêtre, ou la focus si elle existe déjà sous ce label.
/// Restaure sa géométrie persistée si `persist_key` est fourni et qu'une
/// entrée existe dans le store ; sinon utilise width/height par défaut.
pub fn open_window(app: &AppHandle, opts: WindowOptions) -> tauri::Result<WebviewWindow> {
    if let Some(existing) = app.get_webview_window(opts.label) {
        existing.set_focus()?;
        return Ok(existing);
    }

    let mut geometry: Option<Geometry> = None;
    if let Some(ref key) = opts.persist_key {
        geometry = read_geometry(app, key);
    }

    let (width, height) = geometry
        .map(|g| (g.width, g.height))
        .unwrap_or((opts.width, opts.height));

    let mut builder = WebviewWindowBuilder::new(app, opts.label, WebviewUrl::App(opts.url.into()))
        .title(opts.title)
        .inner_size(width, height)
        .min_inner_size(opts.min_width, opts.min_height);

    if let Some(g) = geometry {
        builder = builder.position(g.x, g.y);
    }

    let win = builder.build()?;

    // Persister la géométrie à la fermeture, si demandé.
    // On capture le label de la fenêtre elle-même (String, par valeur) pour
    // pouvoir la retrouver via l'AppHandle au moment de la fermeture, sans
    // avoir à capturer `win` dans son propre callback.
    if let Some(key) = opts.persist_key {
        let app_handle = app.clone();
        let label = win.label().to_string();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(w) = app_handle.get_webview_window(&label) {
                    let _ = save_geometry(&app_handle, &key, &w);
                }
            }
        });
    }

    Ok(win)
}

fn read_geometry(app: &AppHandle, key: &str) -> Option<Geometry> {
    use tauri_plugin_store::StoreExt;
    let store = app.store(STORE_FILE).ok()?;
    let value = store.get(key)?;
    serde_json::from_value(value).ok()
}

fn save_geometry(app: &AppHandle, key: &str, win: &WebviewWindow) -> tauri::Result<()> {
    use tauri_plugin_store::StoreExt;
    let size = win.inner_size()?;
    let pos = win.outer_position()?;
    let scale = win.scale_factor().unwrap_or(1.0);
    let geometry = Geometry {
        x: pos.x as f64,
        y: pos.y as f64,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
    };
    if let Ok(store) = app.store(STORE_FILE) {
        let _ = store.set(key.to_string(), serde_json::to_value(geometry).unwrap_or_default());
        let _ = store.save();
    }
    Ok(())
}

/// Vérifie s'il existe une mise à jour disponible et l'installe si oui.
/// Appelé une seule fois au démarrage (release uniquement, voir lib.rs).
///
/// Actuellement non appelée : le plugin updater est désactivé dans lib.rs
/// tant que sa config (pubkey + endpoints) n'est pas définie — l'enregistrer
/// sans elle fait paniquer l'app au démarrage. Cette fonction sera de nouveau
/// utile une fois le plugin reconfiguré (voir ARCHITECTURE.md → Travaux restants).
#[allow(dead_code)]
pub async fn check_update(app: AppHandle) -> anyhow::Result<()> {
    use tauri_plugin_updater::UpdaterExt;

    let Some(update) = app.updater()?.check().await? else {
        return Ok(());
    };

    log::info!("Update available: {} → {}", update.current_version, update.version);

    let mut downloaded = 0u64;
    update
        .download_and_install(
            |chunk_len, total| {
                downloaded += chunk_len as u64;
                if let Some(total) = total {
                    log::info!("Update download: {downloaded}/{total} bytes");
                }
            },
            || log::info!("Update downloaded, installing…"),
        )
        .await?;

    Ok(())
}
