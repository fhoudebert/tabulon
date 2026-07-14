// src-tauri/src/commands/window_cmds.rs
//
// Remplace les appels rpc.call("openXxx", matchId) depuis les renderers.
// Chaque commande ouvre (ou focus) la fenêtre secondaire correspondante.

/// rpc.call("openClockSetup", gameName) — ouvre la config horloge avant la partie.
/// clock-setup.js appellera ensuite new_match(gameName, clock) pour lancer la partie.
#[tauri::command]
pub fn open_clock_setup(app: AppHandle, game_name: String) -> Result<(), String> {
    use crate::window_manager::WindowOptions;
    open_window(&app, WindowOptions {
        label: &format!("clock-setup-{game_name}"),
        url:   &format!("content/clock-setup.html?game={game_name}"),
        title: &format!("{game_name} Clock Setup"),
        width: 360.0, height: 500.0,
        min_width: 300.0, min_height: 400.0,
        persist_key: None,
    }).map(|_| ()).map_err(|e| e.to_string())
}

use crate::window_manager::{open_window, WindowOptions};
use tauri::{AppHandle, Emitter};
use serde_json::Value;
// urlencoding est déjà une dépendance transitive de Tauri

// ── Commandes d'ouverture ─────────────────────────────────────────────────────

/// rpc.call("openHistory", matchId)
#[tauri::command]
pub fn open_history(app: AppHandle, match_id: u32) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("history-{match_id}"),
        url:   &format!("content/history.html?id={match_id}"),
        title: &format!("History #{match_id}"),
        width: 400.0, height: 500.0,
        min_width: 280.0, min_height: 200.0,
        persist_key: Some(format!("window:history-{match_id}")),
    }).map(|_| ()).map_err(|e| e.to_string())
}

/// rpc.call("openClock", matchId)
#[tauri::command]
pub fn open_clock(app: AppHandle, match_id: u32) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("clock-{match_id}"),
        url:   &format!("content/clock.html?id={match_id}"),
        title: &format!("Clock #{match_id}"),
        width: 400.0, height: 220.0,
        min_width: 200.0, min_height: 100.0,
        persist_key: Some(format!("window:clock-{match_id}")),
    }).map(|_| ()).map_err(|e| e.to_string())
}

/// rpc.call("openPlayers", matchId)
#[tauri::command]
pub fn open_players(app: AppHandle, match_id: u32) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("players-{match_id}"),
        url:   &format!("content/players.html?id={match_id}"),
        title: &format!("Players #{match_id}"),
        width: 460.0, height: 300.0,
        min_width: 300.0, min_height: 200.0,
        persist_key: None,
    }).map(|_| ()).map_err(|e| e.to_string())
}

/// rpc.call("openViewOptions", matchId)
#[tauri::command]
pub fn open_view_options(app: AppHandle, match_id: u32) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("view-options-{match_id}"),
        url:   &format!("content/view-options.html?id={match_id}"),
        title: &format!("View Options #{match_id}"),
        width: 360.0, height: 400.0,
        min_width: 260.0, min_height: 200.0,
        persist_key: None,
    }).map(|_| ()).map_err(|e| e.to_string())
}

/// rpc.call("openCameraView", matchId)
#[tauri::command]
pub fn open_camera_view(app: AppHandle, match_id: u32, game_name: String) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("camera-{match_id}"),
        url:   &format!("content/camera-view.html?id={match_id}&game={game_name}"),
        title: &format!("Camera View #{match_id}"),
        width: 340.0, height: 500.0,
        min_width: 260.0, min_height: 300.0,
        persist_key: Some(format!("window:camera-{match_id}")),
    }).map(|_| ()).map_err(|e| e.to_string())
}

/// rpc.call("openSaveTemplate", matchId)
#[tauri::command]
pub fn open_save_template(app: AppHandle, match_id: u32) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("save-template-{match_id}"),
        url:   &format!("content/save-template.html?id={match_id}"),
        title: &format!("Save template #{match_id}"),
        width: 360.0, height: 240.0,
        min_width: 260.0, min_height: 180.0,
        persist_key: None,
    }).map(|_| ()).map_err(|e| e.to_string())
}

/// rpc.call("openInfo", gameName)
#[tauri::command]
pub fn open_info(app: AppHandle, game_name: String) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("info-{game_name}"),
        url:   &format!("content/info.html?game={game_name}"),
        title: &format!("About {game_name}"),
        width: 600.0, height: 500.0,
        min_width: 400.0, min_height: 300.0,
        persist_key: Some(format!("window:info-{game_name}")),
    }).map(|_| ()).map_err(|e| e.to_string())
}

/// rpc.call("openInvitation", gameName) — coller un lien d'invitation
/// jocly-simple-match (index.php?game=...&mid=...&player=...) pour rejoindre
/// une partie a distance. Lance new_match(gameName, ..., inviteId) une fois
/// le lien valide (voir invitation.js).
#[tauri::command]
pub fn open_invitation(app: AppHandle, game_name: String) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("invitation-{game_name}"),
        url:   &format!("content/invitation.html?game={game_name}"),
        title: &format!("Invitation — {game_name}"),
        width: 460.0, height: 260.0,
        min_width: 340.0, min_height: 220.0,
        persist_key: None,
    }).map(|_| ()).map_err(|e| e.to_string())
}

/// rpc.call("open_extensions") — écran de gestion des extensions (dist externe)
#[tauri::command]
pub fn open_extensions(app: AppHandle) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: "extensions",
        url:   "content/extensions.html",
        title: "Extensions",
        width: 720.0, height: 560.0,
        min_width: 480.0, min_height: 360.0,
        persist_key: Some("window:extensions".into()),
    }).map(|_| ()).map_err(|e| e.to_string())
}

/// rpc.call("openBoardState", gameName, matchId?)
#[tauri::command]
pub fn open_board_state(app: AppHandle, game_name: String, match_id: Option<u32>) -> Result<(), String> {
    let id_str = match_id.map(|i| i.to_string()).unwrap_or_default();
    // JoclyBoard : "Board state" ouvre la fenêtre de SAISIE d'un état
    // (open-position) pour démarrer/recharger une partie — pas la fenêtre
    // d'affichage (show-position), réservée à "Display board state".
    let label = format!("board-state-{game_name}-{id_str}");
    open_window(&app, WindowOptions {
        label: &label,
        url:   &format!("content/open-position.html?game={game_name}&id={id_str}"),
        title: &format!("{game_name} board state"),
        width: 400.0, height: 300.0,
        min_width: 280.0, min_height: 180.0,
        persist_key: None,
    }).map(|_| ()).map_err(|e| e.to_string())
}

/// rpc.call("openBook", gameName, fileName, data)
/// Le parsing PJN/PGN/PDN était assuré par le worker (supprimé).
/// Pour l'instant : ouvre book.html directement sans données parsées.
/// TODO : implémenter le parsing côté Rust ou côté JS dans book.html.
#[tauri::command]
pub fn open_book(app: AppHandle, game_name: String, file_name: String, _data: String) -> Result<(), String> {
    use crate::window_manager::WindowOptions;
    open_window(&app, WindowOptions {
        label: &format!("book-{game_name}"),
        url:   &format!("content/book.html?game={game_name}&file={}", urlencoding::encode(&file_name)),
        title: &format!("{game_name} Book"),
        width: 300.0, height: 450.0, min_width: 200.0, min_height: 250.0,
        persist_key: Some(format!("window:book-{game_name}")),
    }).map(|_| ()).map_err(|e| e.to_string())
}

/// rpc.call("openMoves", matchId)
#[tauri::command]
pub fn open_moves(app: AppHandle, match_id: u32) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("moves-{match_id}"),
        url:   &format!("content/moves.html?id={match_id}"),
        title: &format!("Possible moves #{match_id}"),
        width: 240.0, height: 400.0,
        min_width: 180.0, min_height: 200.0,
        persist_key: Some(format!("window:moves-{match_id}")),
    }).map(|_| ()).map_err(|e| e.to_string())
}



/// rpc.call("openBoardState", gameName, matchId)  →  open-position.html (saisie FEN)
#[tauri::command]
pub fn open_position(app: AppHandle, game_name: String, match_id: Option<u32>) -> Result<(), String> {
    let id_str = match_id.map(|i| i.to_string()).unwrap_or_default();
    open_window(&app, WindowOptions {
        label: &format!("open-position-{game_name}"),
        url:   &format!("content/open-position.html?game={game_name}&id={id_str}"),
        title: &format!("{game_name} board state"),
        width: 400.0, height: 240.0,
        min_width: 280.0, min_height: 180.0,
        persist_key: None,
    }).map(|_| ()).map_err(|e| e.to_string())
}

// ── Relay RPC (push Rust → renderer cible) ───────────────────────────────────
//
// Remplace rpc.call(window, "method", ...args) du main Electron.
// Appelé par le main Rust quand il veut pousser un événement vers
// un renderer spécifique (ex: humanTurn → fenêtre play-<id>).

/// relay_to_window("play-1", "humanTurn", payload)
#[tauri::command]
pub fn relay_to_window(
    app: AppHandle,
    target: String,   // label de la fenêtre cible
    event: String,    // nom de l'événement Tauri
    payload: Value,   // données à transmettre
) -> Result<(), String> {
    // emit_to (et non emit, qui diffuserait à TOUTES les fenêtres de l'app)
    // pour garantir que seule la fenêtre `target` reçoit l'event — important
    // dès que plusieurs parties (donc plusieurs fenêtres play-N) sont ouvertes
    // en même temps.
    app.emit_to(&target, &event, payload).map_err(|e| e.to_string())
}
