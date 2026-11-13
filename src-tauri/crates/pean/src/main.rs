//! `pean-engine` : une requête JSON par ligne sur l'entrée, une réponse par
//! ligne sur la sortie (voir `service`). Pour les tests et les matchs de mesure.

use std::io::{self, BufRead, Write};

fn main() {
    let stdin = io::stdin();
    let mut out = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str(&line) {
            Ok(req) => pean::service::handle(&req, None),
            Err(e) => serde_json::json!({ "error": format!("requête illisible : {e}") }),
        };
        let _ = writeln!(out, "{reply}");
        let _ = out.flush();
    }
}
