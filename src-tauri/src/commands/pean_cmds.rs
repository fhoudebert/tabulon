//! Moteur de Péan (wargame à hexagones de jocly) — niveau « Maréchal ».
//!
//! Comme le moteur du Jeu de la guerre, c'est une bibliothèque Rust du dépôt
//! (`crates/pean`), liée à Tabulon : pas de binaire à installer, la sonde
//! répond toujours, une recherche est un appel de fonction dans un fil de
//! calcul.
//!
//! Le contrat avec jocly (voir `app/content/engine-native.js` et
//! `jocly.pean.js`) :
//!
//!   pean_probe   -> le nom et la version du moteur
//!   pean_search  -> { bestMove, depth, score, nodes, timeMs } ; une erreur
//!                   fait retomber jocly sur son IA interne
//!   pean_stop    -> interrompt la recherche en cours (le meilleur tour trouvé
//!                   jusque-là est rendu)
//!
//! La requête est le texte JSON qu'écrit jocly (`{ context, state,
//! moveTimeMs }`, voir `pean::service`) : elle passe telle quelle. Le tour
//! rendu est du JSON, que jocly relit et valide lui-même (IsValidMove).

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Drapeau d'arrêt, partagé par toutes les recherches (une partie contre le
/// moteur à la fois dans la pratique).
static STOP: AtomicBool = AtomicBool::new(false);

/// Le message {type:"Search"} de jocly.pean.js, repris tel quel.
#[derive(Debug, Clone, Deserialize)]
pub struct PeanSearchRequest {
    pub request: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeanSearchResult {
    pub best_move: Value,
    pub depth: u64,
    pub score: f64,
    pub nodes: u64,
    pub time_ms: u64,
}

pub(crate) fn run_search(request: &PeanSearchRequest, stop: &AtomicBool) -> Result<PeanSearchResult, String> {
    let req: Value = serde_json::from_str(&request.request).map_err(|e| format!("requête illisible : {e}"))?;
    let reply = pean::service::handle(&req, Some(stop));
    if let Some(e) = reply.get("error").and_then(|e| e.as_str()) {
        return Err(e.to_string());
    }
    Ok(PeanSearchResult {
        best_move: reply["move"].clone(),
        depth: reply["depth"].as_u64().unwrap_or(0),
        score: reply["score"].as_f64().unwrap_or(0.0),
        nodes: reply["nodes"].as_u64().unwrap_or(0),
        time_ms: reply["ms"].as_u64().unwrap_or(0),
    })
}

#[tauri::command]
pub async fn pean_probe() -> Result<String, String> {
    Ok(format!("Péan {}", pean::VERSION))
}

#[tauri::command]
pub async fn pean_search(request: PeanSearchRequest) -> Result<PeanSearchResult, String> {
    STOP.store(false, Ordering::Relaxed);
    // la recherche occupe un cœur pendant quelques secondes : hors du
    // réacteur asynchrone, qui sert aussi l'interface
    tauri::async_runtime::spawn_blocking(move || run_search(&request, &STOP))
        .await
        .map_err(|e| format!("recherche interrompue : {e}"))?
}

#[tauri::command]
pub async fn pean_stop() -> Result<(), String> {
    STOP.store(true, Ordering::Relaxed);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// une position réelle (Leuctres, début de partie), tirée des fixtures de la crate
    fn request(ms: u64) -> PeanSearchRequest {
        let fixture: Value = serde_json::from_str(include_str!("../../crates/pean/tests/fixtures/search.json")).unwrap();
        let req = serde_json::json!({ "context": fixture["context"], "state": fixture["state"], "moveTimeMs": ms });
        PeanSearchRequest { request: req.to_string() }
    }

    #[test]
    fn a_search_returns_a_move() {
        let result = run_search(&request(200), &AtomicBool::new(false)).unwrap();
        assert!(result.best_move.get("o").is_some() || result.best_move.get("k").is_some());
        assert!(result.depth >= 1);
    }

    #[test]
    fn an_unreadable_request_is_an_error() {
        let bad = PeanSearchRequest { request: "nonsense".into() };
        assert!(run_search(&bad, &AtomicBool::new(false)).is_err());
    }

    #[test]
    fn a_stopped_search_still_answers() {
        let result = run_search(&request(5000), &AtomicBool::new(true)).unwrap();
        assert!(result.best_move.is_object());
    }

    #[test]
    fn the_result_is_written_in_camel_case() {
        let result = run_search(&request(100), &AtomicBool::new(false)).unwrap();
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"bestMove\""), "{json}");
        assert!(json.contains("\"timeMs\""), "{json}");
    }
}
