// src-tauri/src/state.rs

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

/// Une partie en cours, du point de vue de Rust.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Match {
    pub id: u32,
    pub game_name: String,
    pub game_data: Value,
    pub window_label: String,
    pub satellite_labels: Vec<String>,
}

/// État partagé de l'application.
pub struct AppState {
    pub matches: Mutex<HashMap<u32, Match>>,
    pub next_match_id: std::sync::atomic::AtomicU32,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            matches: Mutex::new(HashMap::new()),
            next_match_id: std::sync::atomic::AtomicU32::new(1),
        }
    }
}
