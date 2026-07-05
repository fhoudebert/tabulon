// src-tauri/src/commands/match_cmds.rs
//
// Architecture simplifiée (voir ARCHITECTURE.md) : plus de SharedWorker.
// Jocly tourne directement dans chaque fenêtre play.html (window.Jocly via
// <script src="../browser/jocly.js">), chaque fenêtre gère sa propre boucle
// de jeu de façon autonome.
//
// Ce fichier ne contient que ce que Rust doit vraiment gérer :
//   - Ouvrir la fenêtre play.html (new_match)
//   - Favoris (is_favorite / set_favorite) via le store Tauri
//   - Gestion des fenêtres satellites (open_window_for_match, close_window, etc.)
//   - Vidéo (record_frame, stop_recording, start_recording) — inchangé

use crate::state::{AppState, Match};
use crate::window_manager::{open_window, WindowOptions};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_store::StoreExt;

// ── Cycle de vie d'une partie ──────────────────────────────────────────────────

/// Ouvre une fenêtre play.html pour un nouveau match.
/// L'ID est généré ici (compteur atomique dans AppState) et passé en query
/// string à play.html, qui l'utilise pour s'identifier dans les appels
/// aux fenêtres satellites (open_history, open_clock, etc.).
#[tauri::command]
pub fn new_match(
    app: AppHandle,
    state: State<AppState>,
    game_name: String,
    clock: Option<Value>,
    // String et non u32 : les ids de fork viennent de trois sources JS —
    // le bouton Fork (id numérique du match parent), book.js ('book-…') et
    // open-position.js ('pos-…'). Un Option<u32> faisait échouer la
    // désérialisation pour les deux derniers : l'invoke rejetait en silence
    // et cliquer une partie du livre / le bouton Open restait sans effet.
    fork_id: Option<String>,
) -> Result<u32, String> {
    let id = state.next_match_id
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    {
        let mut matches = state.matches.lock().unwrap();
        matches.insert(id, Match {
            id,
            game_name: game_name.clone(),
            game_data: Value::Null,
            window_label: format!("play-{id}"),
            satellite_labels: vec![],
        });
    }

    let clock_param = clock
        .map(|c| format!("&clock={}", urlencoding::encode(&c.to_string())))
        .unwrap_or_default();

    // Si fork_id est fourni, le nouveau play.html chargera la position
    // sauvegardee dans le store sous la cle "fork:{fork_id}".
    let fork_param = fork_id
        .map(|fid| format!("&fork={fid}"))
        .unwrap_or_default();

    open_window(&app, WindowOptions {
        label:     &format!("play-{id}"),
        url:       &format!("content/play.html?game={game_name}&id={id}{clock_param}{fork_param}"),
        title:     &game_name,
        width:     700.0, height: 630.0,
        min_width: 400.0, min_height: 400.0,
        persist_key: Some(format!("window:play-{game_name}")),
    }).map_err(|e| e.to_string())?;

    Ok(id)
}

#[tauri::command]
pub fn match_ended(state: State<AppState>, match_id: u32) -> Result<(), String> {
    state.matches.lock().unwrap().remove(&match_id);
    Ok(())
}

// ── Favoris (store Rust direct, plus de délégation au worker) ────────────────

#[tauri::command]
pub fn is_favorite(app: AppHandle, game_name: String) -> Result<bool, String> {
    let store = app.store("tabulon.json").map_err(|e| e.to_string())?;
    let favs: Value = store.get("favoriteGames").unwrap_or(Value::Object(Default::default()));
    Ok(favs.get(&game_name).is_some())
}

#[tauri::command]
pub fn set_favorite(
    app: AppHandle,
    game_name: String,
    value: bool,
) -> Result<(), String> {
    let store = app.store("tabulon.json").map_err(|e| e.to_string())?;
    let mut favs = store.get("favoriteGames")
        .and_then(|v| if let Value::Object(m) = v { Some(m) } else { None })
        .unwrap_or_default();
    if value {
        favs.insert(game_name, Value::Number(
            serde_json::Number::from(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
            )
        ));
    } else {
        favs.remove(&game_name);
    }
    store.set("favoriteGames", Value::Object(favs));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

// ── Fenêtres satellites ────────────────────────────────────────────────────────

/// Ouvre une fenêtre play.html existante (appelée par window_cmds si besoin),
/// ou les fenêtres utilitaires associées à un match.
#[tauri::command]
pub fn open_window_for_match(
    app: AppHandle,
    state: State<AppState>,
    r#type: String,
    game_name: Option<String>,
    match_id: Option<u32>,
    view_options: Option<Value>,
) -> Result<(), String> {
    let id = match_id.unwrap_or(0);
    let gn = game_name.as_deref().unwrap_or("");
    match r#type.as_str() {
        "play" => {
            {
                let mut matches = state.matches.lock().unwrap();
                matches.insert(id, Match {
                    id, game_name: gn.to_string(),
                    game_data: Value::Null,
                    window_label: format!("play-{id}"),
                    satellite_labels: vec![],
                });
            }
            let opts_str = view_options
                .map(|o| serde_json::to_string(&o).unwrap_or_default())
                .unwrap_or_default();
            let url = if opts_str.is_empty() {
                format!("content/play.html?game={gn}&id={id}")
            } else {
                format!("content/play.html?game={gn}&id={id}&options={}", urlencoding::encode(&opts_str))
            };
            open_window(&app, WindowOptions {
                label: &format!("play-{id}"), url: &url,
                title: gn,
                width: 700.0, height: 630.0,
                min_width: 400.0, min_height: 400.0,
                persist_key: Some(format!("window:play-{gn}")),
            }).map(|_| ()).map_err(|e| e.to_string())
        }
        "clock-setup" => open_window(&app, WindowOptions {
            label: &format!("clock-setup-{gn}"),
            url: &format!("content/clock-setup.html?game={gn}"),
            title: &format!("{gn} clock setup"),
            width: 360.0, height: 480.0,
            min_width: 280.0, min_height: 300.0,
            persist_key: None,
        }).map(|_| ()).map_err(|e| e.to_string()),
        _ => Err(format!("Unknown window type: {}", r#type)),
    }
}

#[tauri::command]
pub fn close_window(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_book_window(app: AppHandle, game_name: String, file_name: String) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("book-{game_name}"),
        url: &format!("content/book.html?game={game_name}&file={}", urlencoding::encode(&file_name)),
        title: &format!("{game_name} Book"),
        width: 300.0, height: 450.0, min_width: 200.0, min_height: 250.0,
        persist_key: Some(format!("window:book-{game_name}")),
    }).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_show_position(app: AppHandle, game_name: String, match_id: u32) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("board-state-{game_name}-{match_id}"),
        url: &format!("content/show-position.html?game={game_name}&id={match_id}"),
        title: &format!("{game_name} board state"),
        width: 400.0, height: 180.0, min_width: 280.0, min_height: 120.0,
        persist_key: None,
    }).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn show_error_dialog(app: AppHandle, title: String, message: String) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;
    log::error!("[Dialog] {title}: {message}");
    app.dialog().message(message).title(title).blocking_show();
    Ok(())
}

#[tauri::command]
pub async fn notify_user(
    app: AppHandle,
    channels: State<'_, crate::commands::hub_cmds::NotifyChannels>,
    request: crate::commands::hub_cmds::NotifyRequest,
) -> Result<bool, String> {
    let ok = crate::commands::hub_cmds::push_notify_user(
        &app, &channels,
        &request.text,
        request.ok_text.as_deref().unwrap_or("OK"),
        request.ko_text.as_deref().unwrap_or("Cancel"),
    ).await;
    Ok(ok)
}
