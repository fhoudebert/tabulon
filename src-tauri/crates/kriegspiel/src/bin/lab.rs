//! `kriegspiel-lab` : le banc de reglage de l'evaluation.
//!
//!   selfplay <ouvertures> <parties> <sortie> [--weights f] [--depth n]
//!            [--eps x] [--seed n] [--threads n]
//!       joue des parties moteur contre lui-meme et ecrit, pour chaque
//!       position, le resultat final vu du camp au trait puis ses termes
//!
//!   fit <echantillons>... --out <poids> [--l2 x] [--iters n]
//!       regression logistique : les poids qui expliquent le mieux les
//!       resultats a partir des termes
//!
//!   match <ouvertures> <parties> <poids A> <poids B> [--depth n] [--depth-b n]
//!         [--seed n] [--threads n]
//!       fait jouer A contre B, chaque ouverture avec les deux couleurs
//!
//! Un jeu de poids est un fichier `nom valeur` par ligne, ou l'un des mots
//! `tuned` (les poids en service) et `handmade` (ceux de la premiere version).

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use kriegspiel::eval::{features, Weights, FEATURES, NF};
use kriegspiel::proto::{format_position, parse_position};
use kriegspiel::rules::*;
use kriegspiel::search::{Limits, Searcher};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn number<T: std::str::FromStr>(args: &[String], name: &str, default: T) -> T {
    flag(args, name).and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn load_weights(name: &str) -> Weights {
    match name {
        "tuned" => Weights::default(),
        "handmade" => Weights::handmade(),
        path => {
            let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"));
            Weights::parse(&text, &Weights::default()).unwrap_or_else(|e| panic!("{path}: {e}"))
        }
    }
}

fn load_openings(path: &str) -> Vec<State> {
    fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("{path}: {e}"))
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| parse_position(l).unwrap_or_else(|e| panic!("{path}: {e}")).0)
        .collect()
}

fn limits(depth: u32) -> Limits {
    // budget en profondeur et non en temps : les parties sont reproductibles
    Limits {
        movetime_ms: 3_600_000,
        max_depth: depth,
        root_beam: 8,
        root_keep: 8,
        inner_beam: 4,
        inner_keep: 4,
        leaf_beam: 3,
        leaf_moves: 2,
    }
}

/// comment les parties se terminent : un reglage qui gagne par isolement ne
/// joue pas comme un reglage qui gagne par les arsenaux
static REASONS: Mutex<Vec<(&'static str, u32)>> = Mutex::new(Vec::new());

fn count_reason(reason: &'static str) {
    let mut reasons = REASONS.lock().unwrap();
    match reasons.iter_mut().find(|r| r.0 == reason) {
        Some(entry) => entry.1 += 1,
        None => reasons.push((reason, 1)),
    }
}

fn reasons_text() -> String {
    let mut reasons = REASONS.lock().unwrap().clone();
    reasons.sort_by(|a, b| b.1.cmp(&a.1));
    reasons.iter().map(|(r, n)| format!("{r} {n}")).collect::<Vec<_>>().join(", ")
}

struct Sample {
    mover: i8,
    features: [i32; NF],
}

/// Joue une partie : `north` et `south` portent les poids de chaque camp.
/// Renvoie le vainqueur (0 : nulle), le nombre de coups, et les positions.
fn play_game(north: &Ctx, south: &Ctx, opening: &State, depth: u32, eps: f64, rng: &mut Rng, record: bool) -> (i8, u32, Vec<Sample>) {
    play_game_depths(north, south, opening, (depth, depth), eps, rng, record)
}

/// comme [`play_game`], avec une profondeur par camp (Nord, Sud)
fn play_game_depths(north: &Ctx, south: &Ctx, opening: &State, depths: (u32, u32), eps: f64, rng: &mut Rng, record: bool) -> (i8, u32, Vec<Sample>) {
    let mut st = opening.clone();
    let mut who = NORTH;
    let mut samples = Vec::new();
    let mut seen: HashMap<String, u32> = HashMap::new();
    let mut plies = 0;
    loop {
        let ctx = if who > 0 { north } else { south };
        let limits = limits(if who > 0 { depths.0 } else { depths.1 });
        if record {
            let units = Units::scan(&st);
            let cn = communications_of(ctx, &st, NORTH, &units);
            let cs = communications_of(ctx, &st, SOUTH, &units);
            let (f, winner) = features(ctx, &st, who, &cn, &cs, &units);
            if winner == 0 {
                samples.push(Sample { mover: who, features: f });
            }
        }
        let mut searcher = Searcher::new(ctx);
        let mv = if eps > 0.0 && rng.unit() < eps {
            // un peu de hasard : sans lui, toutes les parties d'une meme
            // ouverture seraient identiques
            let cands = searcher.generate(&st, who, limits.root_beam, 4);
            cands[rng.below(cands.len())].mv.clone()
        } else {
            searcher.search(&st, who, &limits).best
        };
        let (next, _) = play_turn(ctx, &st, who, &mv).expect("the engine plays legal moves");
        st = next;
        plies += 1;
        let (winner, reason) = outcome(ctx, &st, who);
        if winner != 0 {
            count_reason(reason.unwrap_or("?"));
            return (if winner == 2 { 0 } else { winner }, plies, samples);
        }
        who = -who;
        // troisieme occurrence d'une position, ou partie trop longue : nulle
        let mut key = format_position(&st, who);
        let cut = key.match_indices(' ').nth(2).map(|(i, _)| i).unwrap();
        key.replace_range(key.find(' ').unwrap() + 1..cut, "");
        let count = seen.entry(key).or_insert(0);
        *count += 1;
        if *count >= 3 || plies >= 300 {
            count_reason(if plies >= 300 { "too-long" } else { "repetition" });
            return (0, plies, samples);
        }
    }
}

fn selfplay(args: &[String]) {
    let openings = load_openings(&args[0]);
    let games: usize = args[1].parse().expect("number of games");
    let out = &args[2];
    let weights = load_weights(&flag(args, "--weights").unwrap_or_else(|| "tuned".into()));
    let depth = number(args, "--depth", 2u32);
    let eps = number(args, "--eps", 0.1f64);
    let seed = number(args, "--seed", 1u64);
    let threads = number(args, "--threads", 2usize);
    let mut ctx = Ctx::default();
    ctx.weights = weights;
    let next = AtomicUsize::new(0);
    let file = Mutex::new(fs::File::create(out).unwrap_or_else(|e| panic!("{out}: {e}")));
    let tally = Mutex::new((0u32, 0u32, 0u32, 0u64));
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let game = next.fetch_add(1, Ordering::Relaxed);
                if game >= games {
                    break;
                }
                let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9).wrapping_add(game as u64 * 7919 + 1));
                let opening = &openings[game % openings.len()];
                let (winner, plies, samples) = play_game(&ctx, &ctx, opening, depth, eps, &mut rng, true);
                let mut text = String::new();
                for s in &samples {
                    let label = if winner == 0 { 0.5 } else if winner == s.mover { 1.0 } else { 0.0 };
                    text.push_str(&format!("{label}"));
                    for v in s.features {
                        text.push_str(&format!(" {v}"));
                    }
                    text.push('\n');
                }
                file.lock().unwrap().write_all(text.as_bytes()).unwrap();
                let mut t = tally.lock().unwrap();
                match winner {
                    1 => t.0 += 1,
                    -1 => t.1 += 1,
                    _ => t.2 += 1,
                }
                t.3 += plies as u64;
            });
        }
    });
    let t = tally.lock().unwrap();
    println!("{games} games: North {} South {} draws {}, mean length {} plies -> {out}", t.0, t.1, t.2, t.3 / games as u64);
}

fn fit(args: &[String]) {
    let out = flag(args, "--out").expect("--out <weights>");
    let l2 = number(args, "--l2", 0.002f64);
    let iters = number(args, "--iters", 4000usize);
    let mut xs: Vec<[f64; NF]> = Vec::new();
    let mut ys: Vec<f64> = Vec::new();
    for path in args.iter().take_while(|a| !a.starts_with("--")) {
        for line in fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}")).lines() {
            let mut words = line.split_whitespace();
            let Some(label) = words.next() else { continue };
            let mut row = [0f64; NF];
            for (i, w) in words.enumerate().take(NF) {
                row[i] = w.parse().unwrap();
            }
            xs.push(row);
            ys.push(label.parse().unwrap());
        }
    }
    let n = xs.len();
    assert!(n > 100, "not enough samples: {n}");
    // mise a l'echelle : sans elle, un terme qui se compte en dizaines
    // (distances) ecrase ceux qui valent 0 ou 1
    let mut scale = [1f64; NF];
    for j in 0..NF {
        let mean = xs.iter().map(|r| r[j]).sum::<f64>() / n as f64;
        let var = xs.iter().map(|r| (r[j] - mean).powi(2)).sum::<f64>() / n as f64;
        scale[j] = if var > 1e-9 { var.sqrt() } else { 0.0 };
    }
    scale[NF - 1] = 1.0; // tempo : constante, sert d'ordonnee a l'origine
    let loss = |theta: &[f64; NF]| -> (f64, f64) {
        let (mut total, mut right) = (0.0, 0.0);
        for (row, &y) in xs.iter().zip(&ys) {
            let z: f64 = (0..NF).map(|j| if scale[j] > 0.0 { theta[j] * row[j] / scale[j] } else { 0.0 }).sum();
            let p = (1.0 / (1.0 + (-z).exp())).clamp(1e-9, 1.0 - 1e-9);
            total -= y * p.ln() + (1.0 - y) * (1.0 - p).ln();
            if y != 0.5 && ((p > 0.5) == (y > 0.5)) {
                right += 1.0;
            }
        }
        (total / n as f64, right / ys.iter().filter(|&&y| y != 0.5).count().max(1) as f64)
    };
    let mut theta = [0f64; NF];
    // Adam
    let (mut m, mut v) = ([0f64; NF], [0f64; NF]);
    let (lr, b1, b2) = (0.02, 0.9, 0.999);
    for step in 1..=iters {
        let mut grad = [0f64; NF];
        for (row, &y) in xs.iter().zip(&ys) {
            let z: f64 = (0..NF).map(|j| if scale[j] > 0.0 { theta[j] * row[j] / scale[j] } else { 0.0 }).sum();
            let p = 1.0 / (1.0 + (-z).exp());
            for j in 0..NF {
                if scale[j] > 0.0 {
                    grad[j] += (p - y) * row[j] / scale[j];
                }
            }
        }
        for j in 0..NF {
            let g = grad[j] / n as f64 + if j < NF - 1 { l2 * theta[j] } else { 0.0 };
            m[j] = b1 * m[j] + (1.0 - b1) * g;
            v[j] = b2 * v[j] + (1.0 - b2) * g * g;
            let (mh, vh) = (m[j] / (1.0 - b1.powi(step as i32)), v[j] / (1.0 - b2.powi(step as i32)));
            theta[j] -= lr * mh / (vh.sqrt() + 1e-8);
        }
    }
    let (after, accuracy) = loss(&theta);
    let (before, _) = loss(&[0f64; NF]);
    // retour aux unites des termes, puis infanterie en communication = 1000
    let mut w = [0f64; NF];
    for j in 0..NF {
        w[j] = if scale[j] > 0.0 { theta[j] / scale[j] } else { 0.0 };
    }
    let unit = if w[0] > 1e-9 { 1000.0 / w[0] } else { 1000.0 / w.iter().fold(0f64, |a, b| a.max(b.abs())).max(1e-9) };
    let mut weights = Weights([0.0; NF]);
    for j in 0..NF {
        weights.0[j] = (w[j] * unit) as f32;
    }
    fs::write(&out, weights.format()).unwrap_or_else(|e| panic!("{out}: {e}"));
    println!("{n} samples, log-loss {before:.4} -> {after:.4}, {:.1}% of decided positions on the right side", accuracy * 100.0);
    for j in 0..NF {
        println!("  {:<20} {:>10.2}{}", FEATURES[j], weights.0[j], if scale[j] == 0.0 { "   (never varies in the samples)" } else { "" });
    }
    println!("-> {out}");
}

fn run_match(args: &[String]) {
    let openings = load_openings(&args[0]);
    let games: usize = args[1].parse().expect("number of games");
    let (mut a, mut b) = (Ctx::default(), Ctx::default());
    a.weights = load_weights(&args[2]);
    b.weights = load_weights(&args[3]);
    let depth = number(args, "--depth", 2u32);
    // profondeur de B, si elle differe : mesure ce que rapporte un tour de plus
    let depth_b = number(args, "--depth-b", depth);
    let seed = number(args, "--seed", 1u64);
    let threads = number(args, "--threads", 2usize);
    let eps = number(args, "--eps", 0.05f64);
    let next = AtomicUsize::new(0);
    let tally = Mutex::new((0u32, 0u32, 0u32, 0u64));
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let game = next.fetch_add(1, Ordering::Relaxed);
                if game >= games {
                    break;
                }
                // la meme ouverture deux fois, couleurs inversees
                let opening = &openings[(game / 2 + seed as usize * 31) % openings.len()];
                let a_side = if game % 2 == 0 { NORTH } else { SOUTH };
                let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9).wrapping_add((game / 2) as u64 * 7919 + 1));
                let (north, south) = if a_side > 0 { (&a, &b) } else { (&b, &a) };
                let depths = if a_side > 0 { (depth, depth_b) } else { (depth_b, depth) };
                let (winner, plies, _) = play_game_depths(north, south, opening, depths, eps, &mut rng, false);
                let mut t = tally.lock().unwrap();
                if winner == 0 {
                    t.2 += 1;
                } else if winner == a_side {
                    t.0 += 1;
                } else {
                    t.1 += 1;
                }
                t.3 += plies as u64;
            });
        }
    });
    let t = tally.lock().unwrap();
    let score = (t.0 as f64 + 0.5 * t.2 as f64) / games as f64;
    println!(
        "{} (depth {depth}) vs {} (depth {depth_b}), {games} games: +{} -{} ={}  score {:.1}%  mean length {} plies",
        args[2], args[3], t.0, t.1, t.2, score * 100.0, t.3 / games as u64
    );
    println!("  endings: {}", reasons_text());
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("selfplay") if args.len() >= 4 => selfplay(&args[1..]),
        Some("fit") if args.len() >= 2 => fit(&args[1..]),
        Some("match") if args.len() >= 5 => run_match(&args[1..]),
        _ => {
            eprintln!("usage: kriegspiel-lab selfplay <openings> <games> <out> [--weights f] [--depth n] [--eps x] [--seed n] [--threads n]");
            eprintln!("       kriegspiel-lab fit <samples>... --out <weights> [--l2 x] [--iters n]");
            eprintln!("       kriegspiel-lab match <openings> <games> <weights A> <weights B> [--depth n] [--seed n] [--threads n]");
            std::process::exit(2);
        }
    }
}
