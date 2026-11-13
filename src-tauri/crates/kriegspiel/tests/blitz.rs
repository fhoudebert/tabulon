//! La charge eclair (blitz.rs) : colonnes formables en un tour, dans les huit
//! directions, a partir d'une cavalerie pre-positionnee ; et la recherche qui
//! la joue.

use kriegspiel::blitz::{charge_length, columns, play_column, readiness, strength_after};
use kriegspiel::proto::format_move;
use kriegspiel::rules::*;
use kriegspiel::search::{best_move, Limits};

fn place(units: &[(&str, i8)]) -> State {
    let mut st = State::new();
    st.phase = 2;
    st.turn = 2;
    for (name, v) in units {
        st.grid[pos_of(name).unwrap()] = *v;
    }
    st
}

fn columns_of(st: &State, side: i8) -> Vec<kriegspiel::blitz::Column> {
    let ctx = Ctx::default();
    let units = Units::scan(st);
    let comm = communications_of(&ctx, st, side, &units);
    columns(&ctx, st, side, &comm, &units, &[0; 8], 6)
}

/// La cible : une infanterie du Sud en K12, flanquee de K11 et K13 (6 + 6 + 6
/// = 18 en defense), en communication par une estafette en T12. Le Nord :
/// quatre cavaliers en deux colonnes de deux (G11-H11 et G13-H13), la
/// colonne 12 vide entre elles. G11 est sur la diagonale de l'arsenal D8 ;
/// la transmission en D13 (diagonale de B15) eclaire la colonne 13.
fn two_by_two() -> State {
    place(&[
        ("G11", CAVALRY), ("H11", CAVALRY), ("G13", CAVALRY), ("H13", CAVALRY),
        ("D13", SIGNAL), ("D9", INFANTRY),
        ("K12", -INFANTRY), ("K11", -INFANTRY), ("K13", -INFANTRY), ("T12", -COURIER), ("S3", -INFANTRY),
    ])
}

#[test]
fn the_setting_is_what_the_tests_assume() {
    let ctx = Ctx::default();
    let st = two_by_two();
    let north = communications(&ctx, &st, NORTH);
    for name in ["G11", "H11", "G13", "H13"] {
        assert!(north.on[pos_of(name).unwrap()], "{name} in communication");
    }
    let south = communications(&ctx, &st, SOUTH);
    assert!(south.on[pos_of("K12").unwrap()], "the target is in communication");
    let (_, def) = strength(&ctx, &st, pos_of("K12").unwrap(), NORTH, &north, &south, -1);
    assert_eq!(def, 18);
}

#[test]
fn two_columns_of_two_deploy_into_one_column_of_four() {
    let st = two_by_two();
    let cols = columns_of(&st, NORTH);
    let best = cols.iter().find(|c| c.target as usize == pos_of("K12").unwrap()).expect("a column against K12");
    assert_eq!(best.n, 4, "four cavalry in line: {best:?}");
    assert!(best.moves.len() <= 4);
    let ctx = Ctx::default();
    let (_, after) = play_column(&ctx, &st, NORTH, best).expect("a legal order exists");
    assert_eq!(charge_length(&ctx, &after, pos_of("K12").unwrap(), NORTH), 4);
    let (att, def) = strength_after(&ctx, &st, NORTH, best).unwrap();
    assert_eq!(att, 28, "4 x 7");
    assert!(att - def >= 2, "the charge destroys: {att} against {def}");
}

#[test]
fn a_diagonal_column_counts() {
    let ctx = Ctx::default();
    // cible en K12 ; la colonne diagonale nord-est : J13, I14, H15. Deux
    // cavaliers y sont deja (J13, I14), le troisieme vient de J15 (deux pas).
    // La transmission en J8, sur la colonne de D8, eclaire la ligne J.
    let st = place(&[
        ("J8", SIGNAL), ("J13", CAVALRY), ("I14", CAVALRY), ("J15", CAVALRY),
        ("K12", -INFANTRY), ("T12", -COURIER), ("S3", -INFANTRY),
    ]);
    let north = communications(&ctx, &st, NORTH);
    for name in ["J13", "I14", "J15"] {
        assert!(north.on[pos_of(name).unwrap()], "{name} in communication");
    }
    let cols = columns_of(&st, NORTH);
    let best = cols.iter().find(|c| c.target as usize == pos_of("K12").unwrap()).expect("a column");
    assert_eq!(best.n, 3, "{best:?}");
    assert_eq!(best.moves, vec![(pos_of("J15").unwrap() as u16, pos_of("H15").unwrap() as u16)], "one move: J15 to H15");
    let (_, after) = play_column(&ctx, &st, NORTH, best).unwrap();
    assert_eq!(charge_length(&ctx, &after, pos_of("K12").unwrap(), NORTH), 3);
}

#[test]
fn no_charge_against_a_fort_or_a_pass() {
    // M3 est une forteresse
    let st = place(&[
        ("D3", SIGNAL), ("K3", CAVALRY), ("J3", CAVALRY),
        ("M3", -INFANTRY), ("T12", -COURIER), ("S8", -INFANTRY),
    ]);
    assert!(columns_of(&st, NORTH).iter().all(|c| c.target as usize != pos_of("M3").unwrap()));
}

#[test]
fn a_lone_rider_is_not_a_blitz() {
    let st = place(&[
        ("D9", SIGNAL), ("F12", CAVALRY),
        ("K12", -INFANTRY), ("T12", -COURIER), ("S3", -INFANTRY),
    ]);
    assert!(columns_of(&st, NORTH).is_empty());
}

#[test]
fn the_search_plays_the_blitz_and_keeps_moves_for_support() {
    let ctx = Ctx::default();
    // le cas de deux colonnes de deux : la ligne K tient a 18 contre toute
    // charge de moins de trois cavaliers
    let st = two_by_two();
    let limits = Limits { movetime_ms: 2000, max_depth: 2, ..Limits::default() };
    let result = best_move(&ctx, &st, NORTH, &limits, None).unwrap();
    let mv = &result.best;
    let target = mv.a.expect(&format!("an attack: {}", format_move(mv))) as usize;
    let mut turn = Turn::new(&ctx, &st, NORTH);
    for &(a, b) in &mv.m {
        turn.apply_move(a as usize, b as usize);
    }
    // au moins trois cavaliers en charge, en une colonne ou en plusieurs
    // (chaque direction charge pour son compte : 2 + 1 vaut 3 x 7 aussi)
    let units = Units::scan(&turn.st);
    let (att, _) = strength(&ctx, &turn.st, target, NORTH,
        &communications_of(&ctx, &turn.st, NORTH, &units), &communications_of(&ctx, &turn.st, SOUTH, &units), -1);
    assert!(att >= 21, "charges with three cavalry or more: {} ({att})", format_move(mv));
    assert!(charge_length(&ctx, &turn.st, target, NORTH) >= 2, "a column: {}", format_move(mv));
    let (after, result) = play_turn(&ctx, &st, NORTH, mv).expect("legal");
    assert_eq!(result.unwrap().outcome, Outcome::Destroy);
    assert_eq!(after.grid[target], 0);
}

#[test]
fn the_fast_readiness_agrees_with_columns() {
    // l'evaluation utilise `readiness`, la recherche `columns` : meme note
    let ctx = Ctx::default();
    let mut positions = vec![two_by_two()];
    positions.push(place(&[
        ("J8", SIGNAL), ("J13", CAVALRY), ("I14", CAVALRY), ("J15", CAVALRY),
        ("K12", -INFANTRY), ("T12", -COURIER), ("S3", -INFANTRY),
    ]));
    positions.push(place(&[
        ("D9", SIGNAL), ("F12", CAVALRY),
        ("K12", -INFANTRY), ("T12", -COURIER), ("S3", -INFANTRY),
    ]));
    for line in include_str!("fixtures/differential.txt").lines().filter(|l| l.starts_with("P ")).take(300) {
        let (st, _) = kriegspiel::proto::parse_position(&line[2..]).unwrap();
        if st.phase >= 2 {
            positions.push(st);
        }
    }
    let mut nonzero = 0;
    for st in &positions {
        for side in [NORTH, SOUTH] {
            let units = Units::scan(st);
            let comm = communications_of(&ctx, st, side, &units);
            let slow = columns(&ctx, st, side, &comm, &units, &[0; 8], 6).first().map_or(0, |c| c.readiness());
            let fast = readiness(&ctx, st, side, &comm, &units, 6);
            assert_eq!(fast, slow, "{}", kriegspiel::proto::format_position(st, side));
            if fast > 0 {
                nonzero += 1;
            }
        }
    }
    assert!(nonzero >= 3, "some positions have a column: {nonzero}");
}
