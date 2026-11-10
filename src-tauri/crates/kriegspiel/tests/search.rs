//! La recherche : ce qu'elle doit trouver a coup sur, et la legalite de tout
//! ce qu'elle rend.

use kriegspiel::eval::WIN;
use kriegspiel::proto::{format_move, parse_position};
use kriegspiel::rules::*;
use kriegspiel::search::{best_move, Limits, Searcher};

fn place(units: &[(&str, i8)]) -> State {
    let mut st = State::new();
    st.phase = 2;
    st.turn = 2;
    for (name, v) in units {
        st.grid[pos_of(name).unwrap()] = *v;
    }
    st
}

fn quick() -> Limits {
    Limits { movetime_ms: 400, max_depth: 3, ..Limits::default() }
}

#[test]
fn refuses_the_placement_phase() {
    let ctx = Ctx::default();
    assert!(best_move(&ctx, &State::new(), NORTH, &quick(), None).is_err());
}

#[test]
fn takes_the_last_arsenal() {
    let ctx = Ctx::default();
    // le Nord : une transmission en S8 met le cavalier S4 en communication
    let mut st = place(&[("S8", SIGNAL), ("S4", CAVALRY), ("D9", INFANTRY), ("K20", -INFANTRY), ("T22", -SIGNAL)]);
    st.ars = [true, true, true, false];
    let result = best_move(&ctx, &st, NORTH, &quick(), None).unwrap();
    assert_eq!(result.best.d, Some(pos_of("T3").unwrap() as u16), "move: {}", format_move(&result.best));
    assert!(result.score >= WIN - 10, "a win is scored as a win: {}", result.score);
}

#[test]
fn destroys_the_last_combat_unit() {
    let ctx = Ctx::default();
    let st = place(&[("H4", INFANTRY), ("H5", INFANTRY), ("H3", -INFANTRY), ("T5", -SIGNAL)]);
    let result = best_move(&ctx, &st, NORTH, &quick(), None).unwrap();
    assert_eq!(result.best.a, Some(pos_of("H3").unwrap() as u16));
    assert!(result.score >= WIN - 10);
}

#[test]
fn brings_a_second_unit_to_destroy() {
    let ctx = Ctx::default();
    // un fantassin seul n'entame pas l'infanterie adverse (4 contre 6) : il
    // faut amener le second (8 contre 6) avant d'attaquer
    let st = place(&[("H4", INFANTRY), ("G5", INFANTRY), ("D9", INFANTRY), ("H3", -INFANTRY), ("S3", -INFANTRY), ("T5", -SIGNAL)]);
    let result = best_move(&ctx, &st, NORTH, &quick(), None).unwrap();
    assert_eq!(result.best.a, Some(pos_of("H3").unwrap() as u16), "move: {}", format_move(&result.best));
    assert!(!result.best.m.is_empty());
}

#[test]
fn does_not_leave_the_last_arsenal_to_a_raider() {
    let ctx = Ctx::default();
    // un cavalier du Sud, en communication par son estafette, est a un tour
    // de D8, dernier arsenal du Nord ; le Nord doit l'occuper ou l'en empecher
    let mut st = place(&[
        ("C7", INFANTRY), ("C9", INFANTRY), ("A1", SIGNAL),
        ("F8", -CAVALRY), ("F3", -COURIER), ("S3", -INFANTRY),
    ]);
    st.ars = [true, false, true, true];
    assert!(communications(&ctx, &st, SOUTH).on[pos_of("F8").unwrap()], "the raider is in communication");
    let result = best_move(&ctx, &st, NORTH, &quick(), None).unwrap();
    let (after, _) = play_turn(&ctx, &st, NORTH, &result.best).expect("legal move");
    // apres le coup du Nord, aucun tour du Sud ne doit detruire D8
    let mut searcher = Searcher::new(&ctx);
    let replies = searcher.generate(&after, SOUTH, 16, 16);
    assert!(
        replies.iter().all(|c| c.st.ars[0]),
        "North played {} and loses its last arsenal",
        format_move(&result.best)
    );
}

#[test]
fn every_move_it_returns_is_legal() {
    // sur les positions du test differentiel : le coup rendu, et tous les
    // tours candidats, passent le validateur des regles
    let ctx = Ctx::default();
    let text = include_str!("fixtures/differential.txt");
    let limits = Limits { movetime_ms: 30, max_depth: 2, ..Limits::default() };
    let (mut searched, mut candidates) = (0, 0);
    for (index, line) in text.lines().enumerate().filter(|(_, l)| l.starts_with("P ")) {
        let (st, who) = parse_position(&line[2..]).unwrap();
        if st.phase < 2 || outcome(&ctx, &st, -who).0 != 0 {
            continue;
        }
        let mut searcher = Searcher::new(&ctx);
        for cand in searcher.generate(&st, who, 6, 12) {
            let (after, _) = play_turn(&ctx, &st, who, &cand.mv)
                .unwrap_or_else(|e| panic!("line {}: candidate {} refused: {e}", index + 1, format_move(&cand.mv)));
            assert_eq!(after, cand.st, "line {}: candidate position", index + 1);
            candidates += 1;
        }
        if index % 7 == 0 {
            let result = best_move(&ctx, &st, who, &limits, None).unwrap();
            play_turn(&ctx, &st, who, &result.best)
                .unwrap_or_else(|e| panic!("line {}: best move {} refused: {e}", index + 1, format_move(&result.best)));
            searched += 1;
        }
    }
    assert!(searched > 20 && candidates > 2000, "{searched} searches, {candidates} candidates");
}
