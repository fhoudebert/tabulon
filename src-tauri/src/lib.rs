// src-tauri/src/lib.rs
mod commands;
mod state;
mod window_manager;

use commands::{fs_cmds, hub_cmds, match_cmds, template_cmds, video_cmds, window_cmds};
use video_cmds::VideoState;
use hub_cmds::NotifyChannels;
use state::AppState;
use tauri_plugin_cli::CliExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // ── Plugins ──────────────────────────────────────────────────────────
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_cli::init())
        // ── États partagés ───────────────────────────────────────────────────
        .manage(AppState::default())
        .manage(NotifyChannels::default())
        .manage(VideoState::default())
        // ── Setup ─────────────────────────────────────────────────────────────
        .setup(|app| {
            let cli_matches = app.cli().matches()?;
            if !cli_matches.args.contains_key("no-autoupdate") {
                #[cfg(not(debug_assertions))]
                {
                    // Désactivé : updater non encore configuré (pubkey/endpoints).
                    // let handle = app.handle().clone();
                    // tauri::async_runtime::spawn(async move {
                    //     if let Err(e) = window_manager::check_update(handle).await {
                    //         log::warn!("Update check failed: {e}");
                    //     }
                    // });
                }
            }
            Ok(())
        })
        // ── Commandes ─────────────────────────────────────────────────────────
        .invoke_handler(tauri::generate_handler![
            // ── Matchs / cycle de vie ────────────────────────────────────────
            match_cmds::new_match,
            match_cmds::match_ended,
            match_cmds::is_favorite,
            match_cmds::set_favorite,
            match_cmds::notify_user,
            // ── Utilitaires fenêtres ──────────────────────────────────────────
            match_cmds::open_window_for_match,
            match_cmds::close_window,
            match_cmds::open_book_window,
            match_cmds::open_show_position,
            match_cmds::show_error_dialog,
            // ── Fenêtres secondaires ──────────────────────────────────────────
            window_cmds::open_history,
            window_cmds::open_clock,
            window_cmds::open_clock_setup,
            window_cmds::open_players,
            window_cmds::open_view_options,
            window_cmds::open_camera_view,
            window_cmds::open_save_template,
            window_cmds::open_info,
            window_cmds::open_board_state,
            window_cmds::open_book,
            window_cmds::open_moves,
            window_cmds::relay_to_window,
            window_cmds::open_position,
            // ── Hub ───────────────────────────────────────────────────────────
            hub_cmds::get_app_info,
            hub_cmds::notify_user_response,
            // ── Templates ────────────────────────────────────────────────────
            template_cmds::play_template,
            template_cmds::save_template,
            template_cmds::remove_template,
            template_cmds::is_template_name_valid,
            // ── Vidéo ────────────────────────────────────────────────────────
            video_cmds::start_recording,
            video_cmds::stop_recording,
            video_cmds::record_frame,
            // ── Fichiers ─────────────────────────────────────────────────────
            fs_cmds::read_text_file,
            fs_cmds::save_text_file,
            fs_cmds::save_data_uri_file,
            fs_cmds::parse_pjn,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tabulon");
}
