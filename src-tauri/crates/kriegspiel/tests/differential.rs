//! Test differentiel : le moteur Rust contre la reference des regles,
//! `kriegspiel-rules.js` de jocly2.
//!
//! `tests/fixtures/differential.txt` est produit par `tests/make-fixture.cjs`
//! a partir de parties jouees avec la reference. Pour chaque position :
//!
//!   P  la position                       C  les unites en communication
//!   D  les destinations d'une unite      A  une attaque possible, son issue
//!   X  un coup au hasard et le verdict de la reference (ok, ou code du refus)
//!   M  le coup joue    R  la position qui en resulte    O  l'issue
//!
//! Tout doit coincider, codes d'erreur compris.

use kriegspiel::proto::{format_position, parse_move, parse_position};
use kriegspiel::rules::*;

struct Case {
    line: usize,
    st: State,
    who: i8,
}

#[test]
fn rust_matches_the_javascript_reference() {
    let text = include_str!("fixtures/differential.txt");
    let ctx = Ctx::default();
    let mut case: Option<Case> = None;
    let mut dests_seen: Vec<usize> = Vec::new();
    let mut attacks_seen: Vec<u16> = Vec::new();
    let (mut positions, mut checks) = (0, 0);

    // en fin de position : aucune unite ne doit avoir de destination, ni
    // aucune attaque exister, que la reference n'ait pas listee
    fn close(ctx: &Ctx, case: &Case, dests_seen: &[usize], attacks_seen: &[u16]) {
        if case.st.phase < 2 {
            return;
        }
        let turn = Turn::new(ctx, &case.st, case.who);
        let comm = turn.comm(case.who);
        let mut dests = Vec::new();
        for pos in 0..N {
            if side_of(case.st.grid[pos]) != case.who {
                continue;
            }
            turn.dests(pos, &comm, &mut dests);
            assert_eq!(
                !dests.is_empty(),
                dests_seen.contains(&pos),
                "line {}: unit on {} movable or not",
                case.line,
                pos_name(pos)
            );
        }
        let mut attacks = Vec::new();
        turn.attacks(&mut attacks);
        let mut mine: Vec<u16> = attacks.iter().map(|a| a.target).collect();
        let mut theirs = attacks_seen.to_vec();
        mine.sort();
        theirs.sort();
        assert_eq!(mine, theirs, "line {}: set of attacks", case.line);
    }

    for (index, line) in text.lines().enumerate() {
        let number = index + 1;
        let (tag, rest) = line.split_at(1);
        let rest = rest.trim();
        if tag == "P" {
            if let Some(previous) = &case {
                close(&ctx, previous, &dests_seen, &attacks_seen);
            }
            let (st, who) = parse_position(rest).unwrap_or_else(|e| panic!("line {number}: {e}"));
            assert_eq!(format_position(&st, who), rest, "line {number}: position round trip");
            case = Some(Case { line: number, st, who });
            dests_seen.clear();
            attacks_seen.clear();
            positions += 1;
            continue;
        }
        let current = case.as_ref().expect("a P line first");
        let (st, who) = (&current.st, current.who);
        match tag {
            "C" => {
                let mut words = rest.split_whitespace();
                let side = if words.next() == Some("N") { NORTH } else { SOUTH };
                let want: Vec<usize> = words.map(|w| w.parse().unwrap()).collect();
                let comm = communications(&ctx, st, side);
                let got: Vec<usize> = (0..N).filter(|&p| comm.on[p]).collect();
                assert_eq!(got, want, "line {number}: units in communication");
                assert_eq!(comm.count as usize, want.len(), "line {number}: communication count");
            }
            "D" => {
                let mut words = rest.split_whitespace().map(|w| w.parse::<usize>().unwrap());
                let from = words.next().unwrap();
                let want: Vec<u16> = words.map(|p| p as u16).collect();
                let turn = Turn::new(&ctx, st, who);
                let comm = turn.comm(who);
                let mut got = Vec::new();
                turn.dests(from, &comm, &mut got);
                got.sort();
                assert_eq!(got, want, "line {number}: destinations of {}", pos_name(from));
                dests_seen.push(from);
            }
            "A" => {
                let words: Vec<&str> = rest.split_whitespace().collect();
                let target: usize = words[0].parse().unwrap();
                let (att, def): (i32, i32) = (words[1].parse().unwrap(), words[2].parse().unwrap());
                let (ca, cd) = (communications(&ctx, st, who), communications(&ctx, st, -who));
                let excluded = -1; // debut de tour : aucune unite n'a encore fait retraite
                assert_eq!(strength(&ctx, st, target, who, &ca, &cd, excluded), (att, def), "line {number}: strength on {}", pos_name(target));
                let outcome = outcome_of(&ctx, st, target, att - def, &cd);
                assert_eq!(outcome == Outcome::Destroy, words[3] == "D", "line {number}: outcome");
                attacks_seen.push(target as u16);
            }
            "X" => {
                let (verdict, text) = rest.split_once(' ').unwrap();
                let mv = parse_move(text).unwrap_or_else(|e| panic!("line {number}: {e}"));
                let got = match play_turn(&ctx, st, who, &mv) {
                    Ok(_) => "ok",
                    Err(code) => code,
                };
                assert_eq!(got, verdict, "line {number}: verdict on `{text}`");
            }
            "M" => {
                let mv = parse_move(rest).unwrap_or_else(|e| panic!("line {number}: {e}"));
                let (next, _) = play_turn(&ctx, st, who, &mv).unwrap_or_else(|e| panic!("line {number}: reference move refused: {e}"));
                // la position jouee remplace la position de depart : R et O la lisent
                let line = current.line;
                close(&ctx, current, &dests_seen, &attacks_seen);
                case = Some(Case { line, st: next, who: -who });
                dests_seen.clear();
                attacks_seen.clear();
            }
            "R" => {
                assert_eq!(format_position(st, who), rest, "line {number}: resulting position");
            }
            "O" => {
                let (winner, reason) = rest.split_once(' ').unwrap();
                let got = outcome(&ctx, st, -who);
                assert_eq!(got.0.to_string(), winner, "line {number}: winner");
                assert_eq!(got.1.unwrap_or("-"), reason, "line {number}: reason");
                case = None;
            }
            other => panic!("line {number}: unknown tag {other}"),
        }
        checks += 1;
    }
    assert!(positions > 300, "fixture too small: {positions} positions");
    println!("{positions} positions, {checks} checks");
}
