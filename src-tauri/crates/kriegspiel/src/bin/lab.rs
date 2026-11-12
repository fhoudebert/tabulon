//! `kriegspiel-lab` : le banc de reglage de l'evaluation.
//!
//!   selfplay <ouvertures> <parties> <sortie> [--weights f] [--net f] [--depth n]
//!            [--eps x] [--seed n] [--threads n] [--planes 0|1]
//!       joue des parties moteur contre lui-meme et ecrit, pour chaque
//!       position, le resultat final vu du camp au trait puis ses termes ;
//!       avec --planes 1, les positions codees pour le reseau de valeur, au
//!       format binaire decrit a `write_planes_header`
//!
//!   fit <echantillons>... --out <poids> [--l2 x] [--iters n]
//!       regression logistique : les poids qui expliquent le mieux les
//!       resultats a partir des termes
//!
//!   match <ouvertures> <parties> <poids A> <poids B> [--depth n] [--depth-b n]
//!         [--plans 0|1] [--plans-b 0|1] [--net-a f|none] [--net-b f|none]
//!         [--movetime ms] [--seed n] [--threads n]
//!       fait jouer A contre B, chaque ouverture avec les deux couleurs ;
//!       --net-a / --net-b donnent a chacun un reseau de valeur (nn.rs) ;
//!       --movetime : budget en temps par coup au lieu de la profondeur (la
//!       comparaison « a budget egal » ; les parties ne sont plus reproductibles)
//!
//!   nneval <reseau> <echantillons> [--count n]
//!       valeur donnee par le reseau aux premieres positions d'un fichier
//!       `selfplay --planes 1` : sert a verifier l'export de tools/train
//!
//!   nnbench <ouvertures> [--channels c] [--blocks b] [--head h] [--hidden k] [--evals n]
//!       vitesse du reseau de valeur pour une taille donnee, sur un fil
//!
//! Un jeu de poids est un fichier `nom valeur` par ligne, ou l'un des mots
//! `tuned` (les poids en service) et `handmade` (ceux de la premiere version).

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use kriegspiel::eval::{features, Weights, FEATURES, NF};
use kriegspiel::nn::{self, Net};
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

/// un reseau de valeur : un fichier, ou `none` (aucun)
fn load_net(name: Option<String>) -> Option<std::sync::Arc<Net>> {
    match name.as_deref() {
        None | Some("none") => None,
        Some(path) => Some(std::sync::Arc::new(Net::load(path).unwrap_or_else(|e| panic!("{e}")))),
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

/// budget en temps par coup pour `match --movetime` ; 0 : budget en profondeur
static MOVETIME_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn limits(depth: u32) -> Limits {
    let movetime = MOVETIME_MS.load(Ordering::Relaxed);
    if movetime > 0 {
        // les reglages du service, ceux que le joueur a en face de lui
        return Limits { movetime_ms: movetime, ..Limits::default() };
    }
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
        plans: false,
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
    /// plans binaires tasses (nn::pack_binary), si on les releve
    packed: Vec<u8>,
    /// plan 26 : avancement de la partie
    progress: f32,
    /// score de la recherche pour le camp au trait (i32::MIN : coup tire au hasard)
    score: i32,
    ply: u16,
}

/// En-tete d'un fichier d'echantillons `selfplay --planes 1` : `KSPL`, puis
/// trois `u32` petit-boutistes : version (1), plans binaires (nn::BINARY_PLANES),
/// cases (500). Suivent des enregistrements de taille fixe :
///
/// | octets | contenu |
/// |---|---|
/// | BINARY_PLANES * 500 / 8 | plans binaires tasses, voir nn::pack_binary |
/// | 4 (f32) | plan 26, avancement de la partie |
/// | 4 (f32) | resultat de la partie pour le camp au trait : 1, 0 ou -1 |
/// | 4 (i32) | score de la recherche pour le camp au trait, i32::MIN si le coup a ete tire au hasard |
/// | 1 (i8)  | camp au trait : 1 Nord, -1 Sud |
/// | 1 (u8)  | 1 si ce score vient du reseau de valeur (echelle search::NET_SCALE), 0 s'il vient de l'evaluation ponderee |
/// | 2 (u16) | numero du coup dans la partie, a partir de 0 |
/// | 2 (u16) | longueur de la partie, en coups |
///
/// tools/train/data.py relit ce format ; le changer, c'est changer les deux.
fn write_planes_header(file: &mut fs::File) {
    let mut head = b"KSPL".to_vec();
    for v in [1u32, nn::BINARY_PLANES as u32, N as u32] {
        head.extend_from_slice(&v.to_le_bytes());
    }
    file.write_all(&head).unwrap();
}

/// Joue une partie : `north` et `south` portent les poids de chaque camp.
/// Renvoie le vainqueur (0 : nulle), le nombre de coups, et les positions.
fn play_game(north: &Ctx, south: &Ctx, opening: &State, depth: u32, eps: f64, rng: &mut Rng, record: Record) -> (i8, u32, Vec<Sample>) {
    play_game_full(north, south, opening, (depth, depth), (false, false), eps, rng, record)
}

/// ce que `play_game` releve de chaque position
#[derive(Clone, Copy, PartialEq)]
enum Record {
    Nothing,
    Features,
    /// les termes et les plans du reseau
    Planes,
}

/// la partie elle-meme : profondeur et plans (voir search::Limits) par camp
#[allow(clippy::too_many_arguments)]
fn play_game_full(north: &Ctx, south: &Ctx, opening: &State, depths: (u32, u32), plans: (bool, bool), eps: f64, rng: &mut Rng, record: Record) -> (i8, u32, Vec<Sample>) {
    let mut st = opening.clone();
    let mut who = NORTH;
    let mut samples = Vec::new();
    let mut seen: HashMap<String, u32> = HashMap::new();
    let mut plies = 0;
    let mut planes = if record == Record::Planes { vec![0f32; nn::PLANES * N] } else { Vec::new() };
    loop {
        let ctx = if who > 0 { north } else { south };
        let mut limits = limits(if who > 0 { depths.0 } else { depths.1 });
        limits.plans = if who > 0 { plans.0 } else { plans.1 };
        let mut recorded = false;
        if record != Record::Nothing {
            let units = Units::scan(&st);
            let cn = communications_of(ctx, &st, NORTH, &units);
            let cs = communications_of(ctx, &st, SOUTH, &units);
            let (f, winner) = features(ctx, &st, who, &cn, &cs, &units);
            if winner == 0 {
                let mut packed = Vec::new();
                let mut progress = 0.0;
                if record == Record::Planes {
                    nn::encode(ctx, &st, who, &mut planes);
                    nn::pack_binary(&planes, &mut packed);
                    progress = planes[26 * N];
                }
                samples.push(Sample { mover: who, features: f, packed, progress, score: i32::MIN, ply: plies as u16 });
                recorded = true;
            }
        }
        let mut searcher = Searcher::new(ctx);
        searcher.plans = limits.plans;
        let mv = if eps > 0.0 && rng.unit() < eps {
            // un peu de hasard : sans lui, toutes les parties d'une meme
            // ouverture seraient identiques
            let cands = searcher.generate(&st, who, limits.root_beam, 4);
            cands[rng.below(cands.len())].mv.clone()
        } else {
            let result = searcher.search(&st, who, &limits);
            if recorded {
                samples.last_mut().unwrap().score = result.score;
            }
            result.best
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
    let planes = number(args, "--planes", 0u32) != 0;
    let mut ctx = Ctx::default();
    ctx.weights = weights;
    ctx.net = load_net(flag(args, "--net"));
    let next = AtomicUsize::new(0);
    let mut file = fs::File::create(out).unwrap_or_else(|e| panic!("{out}: {e}"));
    if planes {
        write_planes_header(&mut file);
    }
    let file = Mutex::new(file);
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
                let (winner, plies, samples) = play_game(&ctx, &ctx, opening, depth, eps, &mut rng, if planes { Record::Planes } else { Record::Features });
                if planes {
                    let mut bytes = Vec::with_capacity(samples.len() * 1700);
                    let from_net = ctx.net.is_some() as u8;
                    for s in &samples {
                        let z: f32 = if winner == 0 { 0.0 } else if winner == s.mover { 1.0 } else { -1.0 };
                        bytes.extend_from_slice(&s.packed);
                        bytes.extend_from_slice(&s.progress.to_le_bytes());
                        bytes.extend_from_slice(&z.to_le_bytes());
                        bytes.extend_from_slice(&s.score.to_le_bytes());
                        bytes.push(s.mover as u8);
                        bytes.push(from_net);
                        bytes.extend_from_slice(&s.ply.to_le_bytes());
                        bytes.extend_from_slice(&(plies as u16).to_le_bytes());
                    }
                    file.lock().unwrap().write_all(&bytes).unwrap();
                } else {
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
                }
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
    println!("  endings: {}", reasons_text());
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
    // tempo : constante, sert d'ordonnee a l'origine
    scale[FEATURES.iter().position(|f| *f == "tempo").unwrap()] = 1.0;
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
            let g = grad[j] / n as f64 + if FEATURES[j] != "tempo" { l2 * theta[j] } else { 0.0 };
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
    let (net_a, net_b) = (flag(args, "--net-a").unwrap_or("none".into()), flag(args, "--net-b").unwrap_or("none".into()));
    a.net = load_net(Some(net_a.clone()));
    b.net = load_net(Some(net_b.clone()));
    let depth = number(args, "--depth", 2u32);
    // profondeur de B, si elle differe : mesure ce que rapporte un tour de plus
    let depth_b = number(args, "--depth-b", depth);
    // tours construits selon un plan : 1 ou 0, pour A et pour B
    let plans_a = number(args, "--plans", 0u32) != 0;
    let plans_b = number(args, "--plans-b", plans_a as u32) != 0;
    let seed = number(args, "--seed", 1u64);
    let threads = number(args, "--threads", 2usize);
    let eps = number(args, "--eps", 0.05f64);
    MOVETIME_MS.store(number(args, "--movetime", 0u64), Ordering::Relaxed);
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
                let plans = if a_side > 0 { (plans_a, plans_b) } else { (plans_b, plans_a) };
                let (winner, plies, _) = play_game_full(north, south, opening, depths, plans, eps, &mut rng, Record::Nothing);
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
    // marge d'erreur a 95 % : 1,96 ecart-type d'un score sur `games` parties
    let var = ((t.0 as f64) * (1.0 - score).powi(2) + (t.1 as f64) * score.powi(2) + (t.2 as f64) * (0.5 - score).powi(2)) / games as f64;
    let margin = 1.96 * (var / games as f64).sqrt();
    println!(
        "{} net {net_a} (depth {depth}, plans {plans_a}) vs {} net {net_b} (depth {depth_b}, plans {plans_b}), {games} games: +{} -{} ={}  score {:.1}% (+-{:.1})  mean length {} plies",
        args[2], args[3], t.0, t.1, t.2, score * 100.0, margin * 100.0, t.3 / games as u64
    );
    println!("  endings: {}", reasons_text());
}

/// Valeurs du reseau pour les premieres positions d'un fichier d'echantillons.
fn nneval(args: &[String]) {
    let net = Net::load(&args[0]).unwrap_or_else(|e| panic!("{e}"));
    let path = &args[1];
    let count = number(args, "--count", 32usize);
    let bytes = fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    assert!(bytes.len() >= 16 && &bytes[..4] == b"KSPL", "{path}: pas un fichier d'echantillons KSPL");
    let packed = nn::BINARY_PLANES * N / 8;
    let record = packed + 4 + 4 + 4 + 1 + 1 + 2 + 2;
    let mut scratch = net.scratch();
    let mut planes = vec![0f32; nn::PLANES * N];
    for (i, rec) in bytes[16..].chunks_exact(record).take(count).enumerate() {
        for b in 0..nn::BINARY_PLANES * N {
            planes[b] = ((rec[b / 8] >> (b % 8)) & 1) as f32;
        }
        let progress = f32::from_le_bytes(rec[packed..packed + 4].try_into().unwrap());
        planes[nn::BINARY_PLANES * N..].iter_mut().for_each(|v| *v = progress);
        println!("{i} {:.6}", net.forward(&planes, &mut scratch));
    }
}

/// Vitesse du reseau de valeur : codage de la position + passe avant, sur un
/// fil, pour une taille donnee (poids tires au hasard : seule la duree compte).
/// Pour mesurer sur 4 coeurs d'une machine plus grosse, lancer plusieurs
/// instances sous `taskset`.
fn nnbench(args: &[String]) {
    use kriegspiel::nn::Net;
    let openings = load_openings(&args[0]);
    let channels = number(args, "--channels", 32usize);
    let blocks = number(args, "--blocks", 4usize);
    let head = number(args, "--head", 2usize);
    let hidden = number(args, "--hidden", 64usize);
    let evals = number(args, "--evals", 2000usize);
    let net = Net::random(channels, blocks, head, hidden, 1);
    let ctx = Ctx::default();
    let mut scratch = net.scratch();
    // quelques positions de jeu reelles : les ouvertures, jouees un peu
    let states: Vec<State> = openings.iter().take(16).cloned().collect();
    let mut sink = 0f32;
    for st in &states {
        sink += net.value(&ctx, st, NORTH, &mut scratch);
    }
    let started = std::time::Instant::now();
    for i in 0..evals {
        let st = &states[i % states.len()];
        sink += net.value(&ctx, st, if i % 2 == 0 { NORTH } else { SOUTH }, &mut scratch);
    }
    let elapsed = started.elapsed().as_secs_f64();
    let bytes = net.to_bytes().len();
    println!(
        "{blocks} blocs x {channels} canaux (tete {head}, cachee {hidden}) : {} parametres, {:.2} Mo ; {:.0} us par evaluation, {:.0} evaluations/s sur un fil  (controle {sink:.3})",
        net.parameters(),
        bytes as f64 / 1e6,
        elapsed * 1e6 / evals as f64,
        evals as f64 / elapsed
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("selfplay") if args.len() >= 4 => selfplay(&args[1..]),
        Some("fit") if args.len() >= 2 => fit(&args[1..]),
        Some("match") if args.len() >= 5 => run_match(&args[1..]),
        Some("nnbench") if args.len() >= 2 => nnbench(&args[1..]),
        Some("nneval") if args.len() >= 3 => nneval(&args[1..]),
        _ => {
            eprintln!("usage: kriegspiel-lab selfplay <openings> <games> <out> [--weights f] [--net f] [--depth n] [--eps x] [--seed n] [--threads n] [--planes 0|1]");
            eprintln!("       kriegspiel-lab fit <samples>... --out <weights> [--l2 x] [--iters n]");
            eprintln!("       kriegspiel-lab match <openings> <games> <weights A> <weights B> [--depth n] [--net-a f|none] [--net-b f|none] [--seed n] [--threads n]");
            eprintln!("       kriegspiel-lab nnbench <openings> [--channels c] [--blocks b] [--head h] [--hidden k] [--evals n]");
            std::process::exit(2);
        }
    }
}
