//! `kriegspiel-engine` : le moteur en ligne de commande, pour les tests, les
//! matchs de mesure et un eventuel hote sans Tauri. Protocole texte, une
//! commande par ligne sur l'entree standard :
//!
//!   kriegspiel                       -> id name ... / ok
//!   setoption maxturns <n>           nulle apres n coups (0 : sans limite)
//!   setoption isolation <0|1>        victoire par isolement (RSG)
//!   position <position>              voir proto.rs
//!   go [movetime <ms>] [depth <n>] [beam <n>] [keep <n>]
//!                                    -> info ... / bestmove <coup>
//!   moves [beam <n>] [keep <n>]      -> les tours candidats de la position
//!   eval                             -> evaluation statique
//!   play <coup>                      joue un coup (valide) sur la position
//!   d                                affiche la position
//!   quit

use std::io::{self, BufRead, Write};

use kriegspiel::eval::evaluate;
use kriegspiel::proto::{format_move, format_position, move_notation, parse_move, parse_position};
use kriegspiel::rules::{outcome, play_turn, Ctx, State};
use kriegspiel::search::{best_move, Limits, Searcher};

fn option(words: &[&str], name: &str) -> Option<u64> {
    words.iter().position(|w| *w == name).and_then(|i| words.get(i + 1)).and_then(|v| v.parse().ok())
}

fn main() {
    let mut ctx = Ctx::default();
    let mut st = State::new();
    let mut who: i8 = 1;
    let stdin = io::stdin();
    let mut out = io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let words: Vec<&str> = line.split_whitespace().collect();
        let Some(&command) = words.first() else { continue };
        match command {
            "kriegspiel" => {
                println!("id name Kriegspiel {}", env!("CARGO_PKG_VERSION"));
                println!("ok");
            }
            "setoption" => {
                match (words.get(1).copied(), words.get(2).and_then(|v| v.parse::<u32>().ok())) {
                    (Some("maxturns"), Some(n)) => ctx = Ctx::new(n, ctx.isolation_victory),
                    (Some("isolation"), Some(n)) => ctx = Ctx::new(ctx.max_turns, n != 0),
                    _ => println!("error option inconnue"),
                }
            }
            "position" => match parse_position(line[command.len()..].trim()) {
                Ok((state, side)) => {
                    st = state;
                    who = side;
                }
                Err(e) => println!("error {e}"),
            },
            "d" => println!("{}", format_position(&st, who)),
            "eval" => {
                let e = evaluate(&ctx, &st, who);
                println!("eval {} winner {}", e.score, e.winner);
            }
            "play" => match parse_move(line[command.len()..].trim()).and_then(|mv| {
                play_turn(&ctx, &st, who, &mv).map_err(|e| e.to_string())
            }) {
                Ok((state, _)) => {
                    st = state;
                    let (winner, reason) = outcome(&ctx, &st, who);
                    who = -who;
                    println!("ok winner {} {}", winner, reason.unwrap_or("-"));
                }
                Err(e) => println!("error {e}"),
            },
            "moves" => {
                let mut searcher = Searcher::new(&ctx);
                let beam = option(&words, "beam").unwrap_or(16) as usize;
                let keep = option(&words, "keep").unwrap_or(16) as usize;
                if st.phase < 2 {
                    println!("error phase de placement");
                } else {
                    for cand in searcher.generate(&st, who, beam, keep) {
                        println!("move {} score {} | {}", format_move(&cand.mv), cand.score, move_notation(&cand.mv));
                    }
                    println!("ok nodes {}", searcher.nodes);
                }
            }
            "go" => {
                let mut limits = Limits::default();
                if let Some(v) = option(&words, "movetime") {
                    limits.movetime_ms = v;
                }
                if let Some(v) = option(&words, "depth") {
                    limits.max_depth = v as u32;
                }
                if let Some(v) = option(&words, "beam") {
                    limits.root_beam = v as usize;
                }
                if let Some(v) = option(&words, "keep") {
                    limits.root_keep = v as usize;
                }
                if let Some(v) = option(&words, "ibeam") {
                    limits.inner_beam = v as usize;
                }
                if let Some(v) = option(&words, "ikeep") {
                    limits.inner_keep = v as usize;
                }
                if let Some(v) = option(&words, "lbeam") {
                    limits.leaf_beam = v as usize;
                }
                if let Some(v) = option(&words, "lmoves") {
                    limits.leaf_moves = v as u8;
                }
                match best_move(&ctx, &st, who, &limits, None) {
                    Ok(result) => {
                        println!(
                            "info depth {} score {} nodes {} time {} pv {}",
                            result.depth, result.score, result.nodes, result.time_ms, move_notation(&result.best)
                        );
                        println!("bestmove {}", format_move(&result.best));
                    }
                    Err(e) => println!("error {e}"),
                }
            }
            "quit" => break,
            _ => println!("error commande inconnue : {command}"),
        }
        let _ = out.flush();
    }
}
