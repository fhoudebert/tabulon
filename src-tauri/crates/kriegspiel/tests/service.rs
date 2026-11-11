//! Le service appele par Tabulon : texte en entree, texte en sortie.

use std::sync::atomic::{AtomicBool, Ordering};

use kriegspiel::proto::{parse_move, parse_position};
use kriegspiel::rules::{play_turn, Ctx};
use kriegspiel::service::{search_text, Request};

fn opening() -> String {
    include_str!("fixtures/openings.txt").lines().next().unwrap().to_string()
}

#[test]
fn returns_a_legal_move_in_the_wire_format() {
    let request = Request { position: opening(), move_time_ms: Some(150), ..Request::default() };
    let reply = search_text(&request, None).unwrap();
    let text = reply.best_move.expect("a move");
    let (st, who) = parse_position(&request.position).unwrap();
    play_turn(&Ctx::default(), &st, who, &parse_move(&text).unwrap()).expect("legal");
    assert!(reply.depth >= 1 && reply.nodes > 0);
    assert!(reply.notation.is_some());
}

#[test]
fn respects_the_time_budget() {
    let request = Request { position: opening(), move_time_ms: Some(200), ..Request::default() };
    let reply = search_text(&request, None).unwrap();
    // la profondeur 1 va toujours au bout ; au-dela, le budget coupe
    assert!(reply.time_ms < 1500, "took {} ms for a 200 ms budget", reply.time_ms);
}

#[test]
fn a_raised_stop_flag_cuts_the_search_short() {
    let stop = AtomicBool::new(true);
    let request = Request { position: opening(), move_time_ms: Some(30_000), ..Request::default() };
    let reply = search_text(&request, Some(&stop)).unwrap();
    assert!(reply.best_move.is_some(), "a move is still returned");
    assert_eq!(reply.depth, 1, "nothing beyond the first iteration");
    assert!(reply.time_ms < 5_000);
    stop.store(false, Ordering::Relaxed);
}

#[test]
fn refuses_what_it_cannot_play() {
    let bad = Request { position: "garbage".into(), ..Request::default() };
    assert!(search_text(&bad, None).is_err());
    // phase de placement : c'est jocly2 qui deploie
    let placing = Request { position: "N 0 0 1111 - 500".into(), ..Request::default() };
    assert!(search_text(&placing, None).unwrap_err().contains("placement"));
}

#[test]
fn a_finished_game_yields_no_move_and_no_error() {
    // le Sud n'a plus d'arsenal : rien a jouer
    let mut fields: Vec<String> = opening().split(' ').map(String::from).collect();
    fields[3] = "1100".into();
    let request = Request { position: fields.join(" "), ..Request::default() };
    let reply = search_text(&request, None).unwrap();
    assert_eq!(reply.best_move, None);
}

#[test]
fn game_options_reach_the_rules() {
    // nulle a maxTurns : au coup 400 la partie est finie, sauf si l'hote leve la limite
    let mut fields: Vec<String> = opening().split(' ').map(String::from).collect();
    fields[2] = "400".into();
    let position = fields.join(" ");
    let limited = Request { position: position.clone(), move_time_ms: Some(50), ..Request::default() };
    assert_eq!(search_text(&limited, None).unwrap().best_move, None);
    let unlimited = Request { position, move_time_ms: Some(50), max_turns: Some(0), ..Request::default() };
    assert!(search_text(&unlimited, None).unwrap().best_move.is_some());
}

/// Un reseau illisible est refuse et laisse l'evaluation ponderee en service.
#[test]
fn an_unreadable_network_is_refused() {
    let path = std::env::temp_dir().join("kriegspiel-bad.ksnn");
    std::fs::write(&path, b"KSNN pas un reseau").unwrap();
    assert!(kriegspiel::service::set_net(Some(path.to_str().unwrap())).is_err());
    assert_eq!(kriegspiel::service::net_in_use(), None);
}
