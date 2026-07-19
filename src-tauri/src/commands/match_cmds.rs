// src-tauri/src/commands/match_cmds.rs
//
// Architecture simplifiée (voir DEVELOPMENT.md § Internal architecture) :
// plus de SharedWorker. Jocly tourne directement dans chaque fenêtre
// play.html (window.Jocly via <script src="../browser/jocly.js">), chaque
// fenêtre gère sa propre boucle de jeu de façon autonome.
//
// Ce fichier ne contient que ce que Rust doit vraiment gérer :
//   - Ouvrir la fenêtre play.html (new_match) et show-position
//   - Favoris (is_favorite / set_favorite) via le store Tauri
//   - notify_user (bannière du hub)

use crate::state::AppState;
use crate::window_manager::{open_window, WindowOptions};
use serde_json::Value;
use tauri::{AppHandle, State, Emitter};
use tauri_plugin_store::StoreExt;

// ── Cycle de vie d'une partie ──────────────────────────────────────────────────

/// Ouvre une fenêtre play.html pour un nouveau match.
/// L'ID est généré ici (compteur atomique dans AppState) et passé en query
/// string à play.html, qui l'utilise pour s'identifier dans les appels
/// aux fenêtres satellites (open_history, open_clock, etc.).
// `async` requis : cree une fenetre webview -- deadlock documente sous
// Windows dans une commande synchrone (voir la note de window_cmds.rs).
#[tauri::command]
pub async fn new_match(
    app: AppHandle,
    state: State<'_, AppState>,
    game_name: String,
    clock: Option<Value>,
    // String et non u32 : les ids de fork viennent de trois sources JS —
    // le bouton Fork (id numérique du match parent), book.js ('book-…') et
    // open-position.js ('pos-…'). Un Option<u32> faisait échouer la
    // désérialisation pour les deux derniers : l'invoke rejetait en silence
    // et cliquer une partie du livre / le bouton Open restait sans effet.
    fork_id: Option<String>,
    // Idem fork_id, pour une partie rejointe via un lien d'invitation
    // (voir invitation.js) : play.html lit le store "invite:{invite_id}"
    // pour configurer le joueur distant avant de démarrer.
    invite_id: Option<String>,
) -> Result<u32, String> {
    let id = state.next_match_id
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    let clock_param = clock
        .map(|c| format!("&clock={}", urlencoding::encode(&c.to_string())))
        .unwrap_or_default();

    // Si fork_id est fourni, le nouveau play.html chargera la position
    // sauvegardee dans le store sous la cle "fork:{fork_id}".
    let fork_param = fork_id
        .map(|fid| format!("&fork={fid}"))
        .unwrap_or_default();

    let invite_param = invite_id
        .map(|iid| format!("&invite={iid}"))
        .unwrap_or_default();

    open_window(&app, WindowOptions {
        label:     &format!("play-{id}"),
        url:       &format!("content/play.html?game={game_name}&id={id}{clock_param}{fork_param}{invite_param}"),
        title:     &game_name,
        width:     700.0, height: 630.0,
        min_width: 400.0, min_height: 400.0,
        persist_key: Some(format!("window:play-{game_name}")),
    }).map_err(|e| e.to_string())?;

    Ok(id)
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
    store.set("favoriteGames", Value::Object(favs.clone()));
    store.save().map_err(|e| e.to_string())?;
    let _ = app.emit("updateFavorites", Value::Object(favs));
    Ok(())
}

// ── Fenêtres satellites ────────────────────────────────────────────────────────

/// Ouvre une fenêtre play.html existante (appelée par window_cmds si besoin),
/// ou les fenêtres utilitaires associées à un match.



// `async` requis : cree une fenetre webview (voir la note de window_cmds.rs).
#[tauri::command]
pub async fn open_show_position(app: AppHandle, game_name: String, match_id: u32) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("board-state-{game_name}-{match_id}"),
        url: &format!("content/show-position.html?game={game_name}&id={match_id}"),
        title: &format!("{game_name} board state"),
        width: 400.0, height: 180.0, min_width: 280.0, min_height: 120.0,
        persist_key: None,
    }).map(|_| ()).map_err(|e| e.to_string())
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
