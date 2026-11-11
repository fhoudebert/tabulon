//! Moteur du Jeu de la guerre (Guy Debord) — niveau fort du jeu
//! `jeu-de-la-guerre` de jocly.
//!
//! A la difference de Fairy-Stockfish, Scan et KataGo, ce moteur n'est pas un
//! binaire a installer a cote de l'application : c'est une bibliotheque Rust
//! du depot (`crates/kriegspiel`), liee a Tabulon. Il n'y a donc ni chemin a
//! resoudre, ni processus a lancer, ni protocole a parler : la sonde repond
//! toujours, et une recherche est un appel de fonction dans un fil de calcul.
//!
//! Le contrat avec jocly est celui des autres moteurs (voir
//! `app/content/engine-native.js` et `jocly.kriegspiel.js`) :
//!
//!   kriegspiel_probe   -> le nom du moteur et l'evaluation en service
//!   kriegspiel_search  -> { bestMove, ... } ; `bestMove` absent si la partie
//!                         est finie ; une erreur fait retomber jocly sur son
//!                         IA interne (phase de placement comprise)
//!   kriegspiel_stop    -> interrompt la recherche en cours
//!
//! La position et le coup sont du texte, au format de `kriegspiel::proto` :
//! jocly les ecrit et les relit lui-meme, il n'y a aucune conversion ici.
//!
//! Le reseau de valeur (voir `crates/kriegspiel/src/nn.rs`) est un fichier a
//! part, comme le reseau de KataGo : `kriegspiel-value.ksnn`, cherche aux
//! emplacements des moteurs (`engine/` a cote de l'executable d'abord), ou
//! designe par la variable TABULON_KRIEGSPIEL_NET. Il est charge une fois, a
//! la premiere sonde ou recherche. Absent ou illisible, le moteur garde son
//! evaluation ponderee, et la sonde le dit.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use kriegspiel::service::{search_text, set_net, Request};

use crate::commands::engine_cmds::{binary_candidates, searched_paths};

/// nom du fichier du reseau de valeur, cherche comme un binaire de moteur
const NET_FILE: &str = "kriegspiel-value.ksnn";
/// variable d'environnement qui designe un autre fichier
const NET_ENV: &str = "TABULON_KRIEGSPIEL_NET";

/// ce que la sonde annonce de l'evaluation en service
static NET_STATUS: OnceLock<String> = OnceLock::new();

/// Charge le reseau de valeur la premiere fois ; rend l'etat a annoncer.
fn ensure_net() -> &'static str {
    NET_STATUS.get_or_init(|| {
        let path = match std::env::var(NET_ENV) {
            Ok(p) if !p.is_empty() => Some(std::path::PathBuf::from(p)),
            _ => binary_candidates(NET_FILE).into_iter().find(|p| p.is_file()),
        };
        let Some(path) = path else {
            log::info!("Jeu de la guerre : aucun reseau {NET_FILE}, evaluation ponderee. Cherche : {}", searched_paths(NET_FILE));
            return "evaluation ponderee (aucun reseau)".to_string();
        };
        let shown = path.display().to_string();
        match set_net(Some(&shown)) {
            Ok(()) => {
                log::info!("Jeu de la guerre : reseau de valeur {shown}");
                format!("reseau {shown}")
            }
            Err(e) => {
                log::warn!("Jeu de la guerre : reseau illisible, evaluation ponderee : {e}");
                format!("evaluation ponderee (reseau illisible : {e})")
            }
        }
    })
}

/// Drapeau d'arret, partage par toutes les recherches : une seule partie
/// contre le moteur a la fois dans la pratique, et un arret de trop ne coute
/// qu'un coup cherche moins longtemps.
static STOP: AtomicBool = AtomicBool::new(false);

/// Champs envoyes par jocly.kriegspiel.js a son worker (message
/// {type:"Search"}), repris tels quels.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KriegspielSearchRequest {
    pub position: String,
    #[serde(default)]
    pub move_time_ms: Option<u64>,
    #[serde(default)]
    pub depth: Option<u32>,
    /// gameOptions du jeu : nulle apres ce nombre de coups (0 : sans limite)
    #[serde(default)]
    pub max_turns: Option<u32>,
    /// gameOptions du jeu : victoire par isolement
    #[serde(default)]
    pub isolation_victory: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KriegspielSearchResult {
    pub best_move: Option<String>,
    pub notation: Option<String>,
    pub depth: u32,
    pub score: i32,
    pub nodes: u64,
    pub time_ms: u64,
}

pub(crate) fn run_search(request: &KriegspielSearchRequest, stop: &AtomicBool) -> Result<KriegspielSearchResult, String> {
    ensure_net();
    let reply = search_text(
        &Request {
            position: request.position.clone(),
            move_time_ms: request.move_time_ms,
            depth: request.depth,
            max_turns: request.max_turns,
            isolation_victory: request.isolation_victory,
        },
        Some(stop),
    )?;
    Ok(KriegspielSearchResult {
        best_move: reply.best_move,
        notation: reply.notation,
        depth: reply.depth,
        score: reply.score,
        nodes: reply.nodes,
        time_ms: reply.time_ms,
    })
}

/// Le moteur est lie a l'application : la sonde ne peut pas echouer. Elle
/// annonce aussi l'evaluation en service (reseau de valeur ou ponderee).
#[tauri::command]
pub async fn kriegspiel_probe() -> Result<String, String> {
    let status = tauri::async_runtime::spawn_blocking(ensure_net)
        .await
        .map_err(|e| format!("sonde interrompue : {e}"))?;
    Ok(format!("Kriegspiel {} — {}", kriegspiel::VERSION, status))
}

#[tauri::command]
pub async fn kriegspiel_search(request: KriegspielSearchRequest) -> Result<KriegspielSearchResult, String> {
    STOP.store(false, Ordering::Relaxed);
    // la recherche occupe un coeur pendant plusieurs secondes : hors du
    // reacteur asynchrone, qui sert aussi l'interface
    tauri::async_runtime::spawn_blocking(move || run_search(&request, &STOP))
        .await
        .map_err(|e| format!("recherche interrompue : {e}"))?
}

#[tauri::command]
pub async fn kriegspiel_stop() -> Result<(), String> {
    STOP.store(true, Ordering::Relaxed);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// un debut de partie reel, tire des fixtures de la crate
    fn opening() -> &'static str {
        include_str!("../../crates/kriegspiel/tests/fixtures/openings.txt").lines().next().unwrap()
    }

    fn request(position: &str) -> KriegspielSearchRequest {
        KriegspielSearchRequest {
            position: position.into(),
            move_time_ms: Some(100),
            depth: None,
            max_turns: None,
            isolation_victory: None,
        }
    }

    #[test]
    fn a_search_returns_a_move() {
        let result = run_search(&request(opening()), &AtomicBool::new(false)).unwrap();
        assert!(result.best_move.is_some());
        assert!(result.depth >= 1);
    }

    #[test]
    fn an_unreadable_position_is_an_error() {
        assert!(run_search(&request("nonsense"), &AtomicBool::new(false)).is_err());
    }

    #[test]
    fn the_request_reads_what_jocly_sends() {
        let json = r#"{"position":"N 2 2 1111 - 500","moveTimeMs":3000,"maxTurns":400,"isolationVictory":true}"#;
        let parsed: KriegspielSearchRequest = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.move_time_ms, Some(3000));
        assert_eq!(parsed.max_turns, Some(400));
        assert_eq!(parsed.isolation_victory, Some(true));
        assert_eq!(parsed.depth, None);
    }

    #[test]
    fn the_result_is_written_in_camel_case() {
        let result = run_search(&request(opening()), &AtomicBool::new(false)).unwrap();
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"bestMove\""), "{json}");
        assert!(json.contains("\"timeMs\""), "{json}");
    }
}
