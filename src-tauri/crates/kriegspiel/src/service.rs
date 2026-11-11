//! Le service rendu a un hote (Tabulon) : une position en texte, un budget,
//! un coup en texte. Tout ce qui peut se tester sans Tauri est ici ; la
//! commande Tauri n'est qu'un appel a [`search_text`].

use std::sync::atomic::AtomicBool;

use crate::proto::{format_move, move_notation, parse_position};
use crate::rules::{outcome, Ctx};
use crate::search::{best_move, Limits};

/// Ce que l'hote demande pour un coup.
#[derive(Clone, Debug, Default)]
pub struct Request {
    /// la position, au format de proto.rs
    pub position: String,
    /// temps de reflexion ; 3 s par defaut, 60 s au plus
    pub move_time_ms: Option<u64>,
    /// profondeur maximale, en tours
    pub depth: Option<u32>,
    /// options du jeu (gameOptions de jocly2) ; None : les valeurs par defaut
    pub max_turns: Option<u32>,
    pub isolation_victory: Option<bool>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Reply {
    /// le coup, au format de proto.rs ; None si la partie est finie
    pub best_move: Option<String>,
    /// le meme en notation lisible, pour les journaux
    pub notation: Option<String>,
    pub depth: u32,
    pub score: i32,
    pub nodes: u64,
    pub time_ms: u64,
}

pub const DEFAULT_MOVE_TIME_MS: u64 = 3000;
pub const MAX_MOVE_TIME_MS: u64 = 60_000;

/// Cherche un coup. Une erreur (position illisible, phase de placement) est
/// un message a montrer tel quel : l'hote se rabat alors sur l'IA de jocly2.
pub fn search_text(request: &Request, stop: Option<&AtomicBool>) -> Result<Reply, String> {
    let (st, who) = parse_position(&request.position)?;
    let mut ctx = Ctx::default();
    if let Some(n) = request.max_turns {
        ctx.max_turns = n;
    }
    if let Some(b) = request.isolation_victory {
        ctx.isolation_victory = b;
    }
    if st.phase >= 2 && outcome(&ctx, &st, -who).0 != 0 {
        return Ok(Reply { best_move: None, notation: None, depth: 0, score: 0, nodes: 0, time_ms: 0 });
    }
    let mut limits = Limits::default();
    limits.movetime_ms = request.move_time_ms.filter(|&ms| ms > 0).unwrap_or(DEFAULT_MOVE_TIME_MS).min(MAX_MOVE_TIME_MS);
    if let Some(depth) = request.depth.filter(|&d| d > 0) {
        limits.max_depth = depth;
    }
    let result = best_move(&ctx, &st, who, &limits, stop)?;
    Ok(Reply {
        best_move: Some(format_move(&result.best)),
        notation: Some(move_notation(&result.best)),
        depth: result.depth,
        score: result.score,
        nodes: result.nodes,
        time_ms: result.time_ms,
    })
}
