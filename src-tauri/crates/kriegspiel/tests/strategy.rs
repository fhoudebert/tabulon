//! Les termes strategiques de l'evaluation (eval.rs, `strategy`) : ce qu'ils
//! mesurent sur des positions construites a la main. Un terme de poids nul
//! n'est pas calcule ; chaque test donne donc un poids aux termes qu'il lit.

use kriegspiel::eval::{features, Weights, FEATURES, NF};
use kriegspiel::rules::*;

fn place(units: &[(&str, i8)]) -> State {
    let mut st = State::new();
    st.phase = 2;
    st.turn = 2;
    for (name, v) in units {
        st.grid[pos_of(name).unwrap()] = *v;
    }
    st
}

/// tous les termes strategiques calcules
fn ctx() -> Ctx {
    let mut ctx = Ctx::default();
    let mut w = Weights::handmade();
    for name in ["race_mover", "race_other", "exposed_mover", "exposed_other", "advance_safe", "column", "fort_behind", "home_behind"] {
        let i = FEATURES.iter().position(|f| *f == name).unwrap();
        w.0[i] = 1.0;
    }
    ctx.weights = w;
    ctx
}

fn feature(ctx: &Ctx, st: &State, who: i8, name: &str) -> i32 {
    let units = Units::scan(st);
    let cn = communications_of(ctx, st, NORTH, &units);
    let cs = communications_of(ctx, st, SOUTH, &units);
    let (f, winner): ([i32; NF], i8) = features(ctx, st, who, &cn, &cs, &units);
    assert_eq!(winner, 0, "the position is not a finished game");
    f[FEATURES.iter().position(|f| *f == name).unwrap()]
}

/// deux unites combattantes et une transmission de chaque cote, loin de tout
const QUIET: [(&str, i8); 6] = [
    ("D9", INFANTRY), ("C9", INFANTRY), ("B1", SIGNAL),
    ("S4", -INFANTRY), ("S5", -INFANTRY), ("T1", -SIGNAL),
];

#[test]
fn zero_weight_terms_are_not_computed() {
    let ctx = Ctx::default(); // poids en service : race_* a zero
    let mut units = QUIET.to_vec();
    units.extend([("S8", CAVALRY), ("S9", SIGNAL)]);
    let st = place(&units);
    assert_eq!(feature(&ctx, &st, NORTH, "race_mover"), 0);
}

#[test]
fn a_lone_unit_within_reach_of_enemy_cavalry_is_exposed() {
    let ctx = ctx();
    // l'infanterie du Nord en H5, seule ; deux cavaliers du Sud a 3 cases,
    // en communication par leur estafette en M3 (charge 7 + 7 contre 6)
    let mut units = QUIET.to_vec();
    units.extend([("H5", INFANTRY), ("K5", -CAVALRY), ("K6", -CAVALRY), ("M3", -COURIER)]);
    let st = place(&units);
    assert!(communications(&ctx, &st, SOUTH).on[pos_of("K5").unwrap()], "the cavalry is in communication");
    assert!(feature(&ctx, &st, NORTH, "exposed_mover") >= 100, "the lone infantry counts as exposed");
    // la meme infanterie, entouree de quatre autres : defense 30, plus exposee
    let mut grouped = units.clone();
    grouped.extend([("G4", INFANTRY), ("G5", INFANTRY), ("G6", INFANTRY), ("H4", INFANTRY)]);
    let st = place(&grouped);
    assert!(
        feature(&ctx, &st, NORTH, "exposed_mover") < 100,
        "grouped, it is covered: {}",
        feature(&ctx, &st, NORTH, "exposed_mover")
    );
}

#[test]
fn exposure_is_counted_for_the_side_to_move_and_for_the_other() {
    let ctx = ctx();
    let mut units = QUIET.to_vec();
    units.extend([("H5", INFANTRY), ("K5", -CAVALRY), ("K6", -CAVALRY), ("M3", -COURIER)]);
    let st = place(&units);
    // vu du Sud, l'infanterie exposee est celle de l'autre camp
    assert_eq!(feature(&ctx, &st, SOUTH, "exposed_other"), feature(&ctx, &st, NORTH, "exposed_mover"));
}

#[test]
fn an_undefended_arsenal_in_reach_is_a_won_race() {
    let ctx = ctx();
    // cavalier du Nord en P4, en communication par sa transmission (P8) ; T3
    // est a deux tours ; le Sud n'a rien pres de ses arsenaux
    let st = place(&[
        ("D9", INFANTRY), ("P4", CAVALRY), ("P8", SIGNAL),
        ("K20", -INFANTRY), ("K21", -INFANTRY), ("K23", -SIGNAL),
    ]);
    assert!(communications(&ctx, &st, NORTH).on[pos_of("P4").unwrap()]);
    assert!(feature(&ctx, &st, NORTH, "race_mover") > 0, "the raid is won");
    // un defenseur du Sud a une case de T3 : il l'occupe a temps
    let defended = place(&[
        ("D9", INFANTRY), ("P4", CAVALRY), ("P8", SIGNAL),
        ("K20", -INFANTRY), ("S2", -INFANTRY), ("K23", -SIGNAL),
    ]);
    assert_eq!(feature(&ctx, &defended, NORTH, "race_mover"), 0, "the defender arrives first");
}

#[test]
fn a_race_needs_a_way_through() {
    let ctx = ctx();
    // le cavalier est isole : il ne peut pas bouger, donc pas de raid
    let st = place(&[
        ("D9", INFANTRY), ("P5", CAVALRY), ("B1", SIGNAL),
        ("K20", -INFANTRY), ("K21", -INFANTRY), ("K23", -SIGNAL),
    ]);
    assert!(!communications(&ctx, &st, NORTH).on[pos_of("P5").unwrap()]);
    assert_eq!(feature(&ctx, &st, NORTH, "race_mover"), 0);
}

#[test]
fn cavalry_side_by_side_near_the_enemy_forms_a_column() {
    let ctx = ctx();
    let mut units = QUIET.to_vec();
    units.extend([("D6", CAVALRY), ("D5", CAVALRY), ("I5", -INFANTRY), ("I3", -COURIER)]);
    let st = place(&units);
    assert_eq!(feature(&ctx, &st, NORTH, "column"), 2, "both cavalry units count");
    // separes, plus de colonne
    let mut apart = QUIET.to_vec();
    apart.extend([("D6", CAVALRY), ("D3", CAVALRY), ("I5", -INFANTRY), ("I3", -COURIER)]);
    assert_eq!(feature(&ctx, &place(&apart), NORTH, "column"), 0);
}

#[test]
fn posture_terms_only_count_for_the_side_behind() {
    let ctx = ctx();
    // le Nord tient la forteresse B8 et n'a perdu personne : pas de posture
    let mut even = QUIET.to_vec();
    even.push(("B8", INFANTRY));
    even.push(("R5", -INFANTRY));
    assert_eq!(feature(&ctx, &place(&even), NORTH, "fort_behind"), 0);
    // le Nord en inferiorite (2 contre 5) : la forteresse compte
    let mut behind = QUIET.to_vec();
    behind.extend([("B8", INFANTRY), ("R5", -INFANTRY), ("R6", -INFANTRY), ("R7", -INFANTRY), ("R8", -INFANTRY)]);
    let st = place(&behind);
    assert_eq!(feature(&ctx, &st, NORTH, "fort_behind"), 1);
    assert!(feature(&ctx, &st, NORTH, "home_behind") >= 1, "units between the enemy and the arsenals");
}
