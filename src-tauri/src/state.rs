// src-tauri/src/state.rs

/// État partagé de l'application.
///
/// Historique : une struct `Match` et une map `matches` (héritées du portage
/// JoclyBoard) vivaient ici — jamais lues par personne, supprimées avec les
/// commandes orphelines qui les alimentaient. Chaque fenêtre play-{id} est
/// son propre cerveau ; Rust n'a besoin que du compteur d'identifiants.
pub struct AppState {
    pub next_match_id: std::sync::atomic::AtomicU32,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            next_match_id: std::sync::atomic::AtomicU32::new(1),
        }
    }
}
