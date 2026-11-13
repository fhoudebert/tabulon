//! Une requête JSON, une réponse JSON : ce que reçoit le moteur, de Tabulon
//! (commande Tauri) ou de `pean-engine` (une ligne par requête).
//!
//! Requête : `{ "context": PeanRules.exportContext(ctx), "state": { phase,
//! turn, played, u, ctrl, hold, hs }, "moveTimeMs": 2500 }` ; `position` (la
//! chaîne `ExportBoardState` de jocly2, `{scenario, state}`) peut remplacer
//! `state`. Réponse : `{ "move": {o, k}, "score", "depth", "nodes", "ms" }`
//! ou `{ "error": "..." }` (déploiement libre : jocly2 joue lui-même).

use std::sync::atomic::AtomicBool;
use std::time::Duration;

use serde_json::{json, Value};

use crate::ctx::Ctx;
use crate::rules::State;
use crate::search::{search, Limits};

pub fn handle(req: &Value, stop: Option<&AtomicBool>) -> Value {
    match run(req, stop) {
        Ok(v) => v,
        Err(e) => json!({ "error": e }),
    }
}

fn run(req: &Value, stop: Option<&AtomicBool>) -> Result<Value, String> {
    if req.get("probe").is_some() {
        return Ok(json!({ "engine": "pean", "version": crate::VERSION }));
    }
    let ctx = Ctx::from_value(req.get("context").ok_or("contexte manquant")?)?;
    let state = match (req.get("state"), req.get("position")) {
        (Some(s), _) => s.clone(),
        (None, Some(Value::String(text))) => {
            let v: Value = serde_json::from_str(text).map_err(|e| format!("position illisible : {e}"))?;
            v.get("state").cloned().ok_or("position sans état")?
        }
        (None, Some(v)) => v.get("state").cloned().unwrap_or_else(|| v.clone()),
        _ => return Err("position manquante".into()),
    };
    let st = State::parse(&ctx, &state)?;
    if st.phase < 2 {
        return Err("placement".into());
    }
    let mut limits = Limits::default();
    if let Some(ms) = req.get("moveTimeMs").and_then(|v| v.as_u64()) {
        limits.time = Duration::from_millis(ms.clamp(50, 60_000));
    }
    if let Some(w) = req.get("widths").and_then(|v| v.as_array()) {
        let w: Vec<usize> = w.iter().filter_map(|x| x.as_u64()).map(|x| x.max(1) as usize).collect();
        if !w.is_empty() {
            limits.widths = w;
        }
    }
    if let Some(d) = req.get("maxDepth").and_then(|v| v.as_u64()) {
        limits.max_depth = (d as usize).clamp(1, 12);
    }
    let r = search(&ctx, &st, limits, stop).ok_or("aucun tour")?;
    Ok(json!({
        "move": r.best,
        "score": r.score,
        "depth": r.depth,
        "nodes": r.nodes,
        "rootMoves": r.root_moves,
        "ms": r.elapsed.as_millis() as u64
    }))
}
