//! Evaluation statique.
//!
//! L'evaluation est une somme ponderee de termes ([`FEATURES`]) mesures du
//! point de vue du camp au trait : chaque terme vaut « le mien moins celui de
//! l'adversaire », sauf ceux qui dependent du trait (ce que je peux detruire
//! tout de suite n'a pas le poids de ce que l'adversaire pourrait detruire
//! s'il avait le trait).
//!
//! Les poids ([`Weights`]) ne sont pas choisis a la main : `kriegspiel-lab`
//! joue des parties moteur contre moteur, releve les termes de chaque
//! position avec le resultat de la partie, et ajuste les poids par regression
//! logistique (voir src/bin/lab.rs et le README).

use crate::rules::*;

/// score d'une partie gagnee, du point de vue du Nord
pub const WIN: i32 = 1_000_000;

/// valeur relative des unites pour les menaces, en centiemes : -, I, C, A, AC, T, E
pub const VALUE: [i32; 7] = [0, 100, 120, 140, 160, 130, 150];

pub const NF: usize = 50;

pub const FEATURES: [&str; NF] = [
    "infantry_on", "cavalry_on", "artillery_on", "horse_artillery_on", "signal_on", "courier_on",
    "infantry_off", "cavalry_off", "artillery_off", "horse_artillery_off", "signal_off", "courier_off",
    "arsenals",        // arsenaux debout
    "last_arsenal",    // il ne m'en reste qu'un
    "advance",         // somme des distances de mes unites combattantes a l'arsenal adverse le plus proche
    "fort",            // forteresses tenues par une unite qui en tire un bonus
    "pass",            // cols, idem
    "raid1_mover",     // mes unites qui peuvent entrer ce tour dans un arsenal adverse vide
    "raid1_other",     // les siennes, s'il avait le trait
    "raid2",           // arsenaux adverses a 2 tours d'une de mes unites
    "raid3",
    "raid4",
    "raid_last",       // son dernier arsenal est a 3 tours au plus
    "guard",           // mes arsenaux occupes par une de mes unites
    "threat_mover",    // la meilleure destruction a ma portee tout de suite
    "threat_mover_rest",
    "threat_other",    // la meilleure a sa portee, s'il avait le trait
    "threat_other_rest",
    "no_signal",       // je n'ai plus d'unite de transmission
    "retreat",         // je dois une retraite
    "lines",           // cases couvertes par mes lignes de communication
    "tempo",           // avoir le trait
    "fragile",         // mes unites qui ne sont en communication que grace a mes transmissions
    "signal_threat_mover", // ses unites de transmission que je peux detruire tout de suite
    "signal_threat_other", // les miennes qu'il pourrait detruire s'il avait le trait
    "no_anchor",       // aucune de mes unites combattantes n'est en communication sans mes transmissions
    "one_signal",      // il ne me reste qu'une unite de transmission
    "hunt_mover",      // je peux detruire tout de suite une transmission dont depend toute son armee
    "hunt_other",      // il le pourrait contre moi, s'il avait le trait
    // --- strategies (voir le README, « Strategies ») ---
    "race_mover",      // raids que je gagne : un arsenal adverse vide que j'atteins avant qu'il puisse le couvrir
    "race_other",      // raids qu'il gagne contre moi
    "exposed_mover",   // mes unites que ses forces proches pourraient detruire a son prochain tour
    "exposed_other",   // les siennes, que mes forces proches pourraient detruire
    "advance_safe",    // progres vers l'arsenal adverse (40 - distance), unites non exposees seulement
    "column",          // mes cavaliers flanques d'un autre cavalier, quand l'ennemi est a portee de charge
    "fort_behind",     // en inferiorite : mes forteresses et cols tenus
    "home_behind",     // en inferiorite : mes unites entre l'ennemi et mes arsenaux
    "blitz_ready",     // charge eclair : la meilleure colonne que je forme en un tour (4 x cavaliers - deplacements), moins la sienne
    "blitz_kill_mover",// une cible que ma charge eclair detruirait au prochain tour (valeur)
    "blitz_kill_other",// une des miennes que sa charge eclair detruirait
];

#[derive(Clone, Debug, PartialEq)]
pub struct Weights(pub [f32; NF]);

impl Default for Weights {
    fn default() -> Self {
        Weights(TUNED)
    }
}

/// Les poids regles a la main de la premiere version, gardes comme temoin :
/// `kriegspiel-lab match` mesure tout nouveau jeu de poids contre eux.
pub const HANDMADE: [f32; NF] = [
    1000.0, 1200.0, 1400.0, 1600.0, 1300.0, 1500.0,
    650.0, 780.0, 910.0, 1040.0, 845.0, 975.0,
    7000.0, 0.0, -12.0, 150.0, 100.0,
    4000.0, -2500.0, 1000.0, 500.0, 250.0, 800.0, 0.0,
    8.0, 0.5, -3.0, -0.5,
    -1200.0, -200.0, 0.0, 0.0,
    0.0, 0.0, 0.0,
    0.0, 0.0,
    0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0,
];

/// Les poids en service : ceux de la premiere version, plus quatre termes
/// strategiques (exposition des unites, avance groupee, pre-positionnement
/// de la cavalerie pour la charge eclair). Mesures au banc,
/// voir le README (« Strategies »).
pub const TUNED: [f32; NF] = {
    let mut w = HANDMADE;
    w[41] = -3.0; // exposed_mover
    w[42] = 1.5; // exposed_other
    w[43] = 6.0; // advance_safe
    w[47] = 60.0; // blitz_ready : cavalerie pre-positionnee pour la charge eclair
    w
};

impl Weights {
    pub fn handmade() -> Weights {
        Weights(HANDMADE)
    }

    /// `nom valeur` par ligne ; les termes absents gardent leur valeur
    pub fn parse(text: &str, base: &Weights) -> Result<Weights, String> {
        let mut w = base.clone();
        for line in text.lines() {
            let line = line.split('#').next().unwrap().trim();
            if line.is_empty() {
                continue;
            }
            let mut words = line.split_whitespace();
            let (name, value) = (words.next().unwrap(), words.next().ok_or_else(|| format!("valeur manquante : {line}"))?);
            let index = FEATURES.iter().position(|f| *f == name).ok_or_else(|| format!("terme inconnu : {name}"))?;
            w.0[index] = value.parse().map_err(|_| format!("valeur illisible : {line}"))?;
        }
        Ok(w)
    }

    pub fn format(&self) -> String {
        FEATURES.iter().zip(self.0.iter()).map(|(n, v)| format!("{n} {v:.2}\n")).collect()
    }
}

pub struct Eval {
    /// score pour le Nord ; +-WIN si la partie est finie
    pub score: i32,
    /// 0 : en cours, 1 / -1 : vainqueur, 2 : nulle
    pub winner: i8,
}

/// Les termes de la position, du point de vue de `to_move` (au trait), et le
/// vainqueur si la partie est finie. `cn` et `cs` : communications du Nord et
/// du Sud ; `units` : les cases occupees.
pub fn features(ctx: &Ctx, st: &State, to_move: i8, cn: &Comm, cs: &Comm, units: &Units) -> ([i32; NF], i8) {
    let mut f = [0i32; NF];
    // indice 0 : le camp au trait, 1 : l'autre
    let idx = |side: i8| if side == to_move { 0usize } else { 1usize };
    let sign = |side: i8| if side == to_move { 1i32 } else { -1i32 };
    let comm_of = |side: i8| if side > 0 { cn } else { cs };

    let mut alive = [0i32; 2];
    for i in 0..4 {
        if st.ars[i] {
            alive[idx(ctx.ars_side[i])] += 1;
            let occupant = st.grid[ctx.ars_pos[i]];
            if occupant != 0 && occupant.signum() == ctx.ars_side[i] {
                f[23] += sign(ctx.ars_side[i]);
            }
        }
    }
    f[12] = alive[0] - alive[1];
    f[13] = (alive[0] == 1) as i32 - (alive[1] == 1) as i32;

    let mut combat = [0u32; 2];
    let mut signals = [0u32; 2];
    // pour chaque arsenal : en combien de tours l'unite combattante ennemie en
    // communication la plus proche peut y entrer
    let mut raid = [99u16; 4];
    for pos in units.iter() {
        let v = st.grid[pos];
        if v == 0 {
            continue;
        }
        let side = v.signum();
        let t = v.unsigned_abs() as usize;
        let in_comm = comm_of(side).on[pos];
        f[if in_comm { t - 1 } else { 5 + t }] += sign(side);
        if (t as i8) >= SIGNAL {
            signals[idx(side)] += 1;
            continue;
        }
        combat[idx(side)] += 1;
        if !in_comm {
            continue;
        }
        let mut dist = 999u16;
        for i in 0..4 {
            if ctx.ars_side[i] != side && st.ars[i] {
                let d = ctx.ars_dist[i][pos];
                dist = dist.min(d);
                let turns = (d + MOVE[t] as u16 - 1) / MOVE[t] as u16;
                raid[i] = raid[i].min(turns);
                if d <= MOVE[t] as u16 && st.grid[ctx.ars_pos[i]] == 0 {
                    f[if side == to_move { 17 } else { 18 }] += 1;
                }
            }
        }
        if dist < 999 {
            f[14] += sign(side) * dist as i32;
        }
        if ctx.terr[pos] == FORT && FORT_BONUS[t] > 0 {
            f[15] += sign(side);
        } else if ctx.terr[pos] == PASS && PASS_BONUS[t] > 0 {
            f[16] += sign(side);
        }
    }
    for i in 0..4 {
        if !st.ars[i] {
            continue;
        }
        // l'arsenal i est menace par l'adversaire de son proprietaire
        let raider = -ctx.ars_side[i];
        match raid[i] {
            2 => f[19] += sign(raider),
            3 => f[20] += sign(raider),
            4 => f[21] += sign(raider),
            _ => {}
        }
        if raid[i] <= 3 && alive[idx(ctx.ars_side[i])] == 1 {
            f[22] += sign(raider);
        }
    }

    // fin de partie : le camp qui vient de subir le coup d'abord
    let lost = |side: i8| -> bool {
        let k = idx(side);
        alive[k] == 0
            || combat[k] == 0
            || (ctx.isolation_victory && signals[k] == 0 && comm_of(side).count == 0)
    };
    if st.phase >= 2 {
        if lost(to_move) {
            return (f, -to_move);
        }
        if lost(-to_move) {
            return (f, to_move);
        }
        if ctx.max_turns > 0 && st.turn >= ctx.max_turns {
            return (f, 2);
        }
    }

    // menaces : ce que chaque camp peut detruire tout de suite
    // (la defense de chaque unite est gardee pour les termes strategiques)
    let mut defense_of = [0i32; 40];
    for att_side in [to_move, -to_move] {
        let (ca, cd) = (comm_of(att_side), comm_of(-att_side));
        let (mut best, mut sum) = (0i32, 0i32);
        for (k, pos) in units.iter().enumerate() {
            let v = st.grid[pos];
            if v == 0 || (v > 0) == (att_side > 0) {
                continue;
            }
            let (att, def) = strength(ctx, st, pos, att_side, ca, cd, -1);
            defense_of[k] = def;
            if att > def {
                if v.abs() >= SIGNAL {
                    f[if att_side == to_move { 33 } else { 34 }] += 1;
                }
                let value = VALUE[v.unsigned_abs() as usize];
                let gain = if att - def >= 2 { value } else { value * 35 / 100 };
                sum += gain;
                best = best.max(gain);
            }
        }
        if att_side == to_move {
            f[24] = best;
            f[25] = sum - best;
        } else {
            f[26] = best;
            f[27] = sum - best;
        }
    }
    f[28] = (signals[0] == 0) as i32 - (signals[1] == 0) as i32;
    f[29] = (st.retreat >= 0 && st.grid[st.retreat as usize] != 0) as i32;
    f[30] = comm_of(to_move).lit_count as i32 - comm_of(-to_move).lit_count as i32;
    f[31] = 1;
    // Fragilite : une armee qui s'eloigne de ses arsenaux ne tient plus que
    // par ses deux unites de transmission, qui ne se defendent pas (1) ;
    // qu'elles tombent et tout est isole d'un coup.
    for side in [to_move, -to_move] {
        if signals[idx(side)] == 0 {
            continue; // plus de transmission : rien ne depend d'elles
        }
        let comm = comm_of(side);
        let direct = communications_relay(ctx, st, side, units, false);
        let signals_on = units.iter().filter(|&p| st.grid[p].signum() == side && st.grid[p].abs() >= SIGNAL && comm.on[p]).count() as i32;
        let signals_direct = units.iter().filter(|&p| st.grid[p].signum() == side && st.grid[p].abs() >= SIGNAL && direct.on[p]).count() as i32;
        // unites combattantes seulement : les transmissions sont comptees a part
        let fragile = (comm.count as i32 - signals_on) - (direct.count as i32 - signals_direct);
        f[32] += sign(side) * fragile;
        // plus rien ne tient sans elles : leur perte serait la defaite par
        // isolement (regle optionnelle), ou une armee entiere immobile
        if direct.count as i32 - signals_direct == 0 {
            f[35] += sign(side);
        }
        if signals[idx(side)] == 1 {
            f[36] += sign(side);
        }
        // La chasse aux transmissions : une armee sans ancrage dont une
        // transmission est a portee de destruction. Deux fois plus grave quand
        // c'est la derniere : sa perte isole tout d'un coup.
        let threatened = if side == to_move { f[34] } else { f[33] };
        if threatened > 0 && direct.count as i32 - signals_direct == 0 {
            let weight = if signals[idx(side)] as i32 <= threatened { 2 } else { 1 };
            f[if side == to_move { 38 } else { 37 }] += weight;
        }
    }
    strategy(ctx, st, to_move, cn, cs, units, &defense_of, &mut f);
    (f, 0)
}

/// Combien de tours faut-il a l'unite en `from` pour entrer dans l'arsenal
/// `ars` (vide), en partant de chaque tour d'une case d'ou elle peut bouger :
/// sur une ligne de son camp, ou au contact d'une unite combattante amie en
/// communication. Les autres unites sont supposees immobiles. None au-dela de
/// `max_turns`.
fn race_turns(ctx: &Ctx, st: &State, comm: &Comm, side: i8, from: usize, ars: usize, max_turns: u8) -> Option<u8> {
    let t = st.grid[from].unsigned_abs() as usize;
    let target = ctx.ars_pos[ars];
    let mut seen = [false; N];
    let mut frontier: Vec<u16> = vec![from as u16];
    seen[from] = true;
    for turn in 1..=max_turns {
        let mut reached: Vec<u16> = Vec::new();
        let mut layer = frontier.clone();
        for _ in 0..MOVE[t] {
            let mut next_layer = Vec::new();
            for &p in &layer {
                for d in 0..8 {
                    let q = ctx.next[p as usize * 8 + d];
                    if q < 0 {
                        continue;
                    }
                    let q = q as usize;
                    if q == target {
                        return Some(turn);
                    }
                    if seen[q] || ctx.terr[q] == MOUNTAIN || st.grid[q] != 0 {
                        continue;
                    }
                    // une unite combattante s'arrete dans un arsenal ennemi
                    if ctx.enemy_arsenal_at(st, q, side).is_some() {
                        continue;
                    }
                    seen[q] = true;
                    next_layer.push(q as u16);
                    reached.push(q as u16);
                }
            }
            layer = next_layer;
        }
        // le tour suivant ne part que des cases d'ou l'unite peut bouger
        frontier = reached
            .into_iter()
            .filter(|&q| {
                let q = q as usize;
                comm.lit[q]
                    || (0..8).any(|d| {
                        let r = ctx.next[q * 8 + d];
                        r >= 0 && r as usize != from && comm.on[r as usize] && {
                            let w = st.grid[r as usize];
                            w.signum() == side && w.abs() < SIGNAL
                        }
                    })
            })
            .collect();
        if frontier.is_empty() {
            return None;
        }
    }
    None
}

/// Les termes strategiques (indices 39 a 49). Un terme de poids nul n'est
/// pas calcule (il vaut 0) : la course aux arsenaux, surtout, coute cher.
fn strategy(ctx: &Ctx, st: &State, to_move: i8, cn: &Comm, cs: &Comm, units: &Units, defense_of: &[i32; 40], f: &mut [i32; NF]) {
    let w = &ctx.weights.0;
    let sign = |side: i8| if side == to_move { 1i32 } else { -1i32 };
    let comm_of = |side: i8| if side > 0 { cn } else { cs };

    // materiel, pour la posture : un camp est en inferiorite quand il a
    // perdu l'equivalent d'une infanterie et demie de plus que l'autre
    let mut material = [0i32; 2];
    for pos in units.iter() {
        let v = st.grid[pos];
        if v != 0 && v.abs() < SIGNAL {
            material[if v.signum() == to_move { 0 } else { 1 }] += VALUE[v.unsigned_abs() as usize];
        }
    }
    let behind = |side: i8| {
        let (mine, theirs) = if side == to_move { (material[0], material[1]) } else { (material[1], material[0]) };
        mine - theirs <= -150
    };

    // 1. Exposition : ce que les forces adverses proches pourraient porter
    //    contre chaque unite apres un deplacement (portee + mouvement), contre
    //    sa defense actuelle. Une borne haute, sans les montagnes.
    let mut exposed = [false; 40];
    for (k, pos) in units.iter().enumerate() {
        let v = st.grid[pos];
        if v == 0 {
            continue;
        }
        let side = v.signum();
        let enemy_comm = comm_of(-side);
        let charge_ok = ctx.terr[pos] != FORT && ctx.terr[pos] != PASS;
        let mut potential = 0i32;
        for q in units.iter() {
            let w = st.grid[q];
            if w == 0 || w.signum() == side || w.abs() >= SIGNAL || !enemy_comm.on[q] {
                continue;
            }
            let t = w.unsigned_abs() as usize;
            let d = distance(pos, q);
            if d <= MOVE[t] as usize + RANGE[t] as usize {
                potential += if t as i8 == CAVALRY && charge_ok && d <= MOVE[t] as usize + 1 { CHARGE } else { ATTACK[t] };
            }
        }
        let deficit = potential - defense_of[k];
        if deficit >= 1 {
            exposed[k] = deficit >= 2;
            let value = VALUE[v.unsigned_abs() as usize];
            let loss = if deficit >= 2 { value } else { value * 35 / 100 };
            f[if side == to_move { 41 } else { 42 }] += loss;
        }
    }

    // 2. Avance groupee : le progres vers l'arsenal adverse (40 - distance)
    //    ne compte que pour les unites qui ne sont pas exposees. (Compter la
    //    distance des seules unites non exposees, comme dans un premier essai,
    //    recompensait l'exposition : l'unite exposee sortait de la somme.)
    if w[43] != 0.0 {
    for (k, pos) in units.iter().enumerate() {
        let v = st.grid[pos];
        if v == 0 || v.abs() >= SIGNAL || exposed[k] || !comm_of(v.signum()).on[pos] {
            continue;
        }
        let side = v.signum();
        let mut dist = 999u16;
        for i in 0..4 {
            if ctx.ars_side[i] != side && st.ars[i] {
                dist = dist.min(ctx.ars_dist[i][pos]);
            }
        }
        if dist < 999 {
            f[43] += sign(side) * (40 - dist.min(40) as i32);
        }
    }
    }

    // 3. Colonne de cavalerie : un cavalier flanque d'un autre, quand une
    //    unite combattante adverse est a portee de charge (6 cases)
    if w[44] != 0.0 {
    for pos in units.iter() {
        let v = st.grid[pos];
        if v.abs() != CAVALRY || !comm_of(v.signum()).on[pos] {
            continue;
        }
        let side = v.signum();
        let near_enemy = units.iter().any(|q| {
            let w = st.grid[q];
            w != 0 && w.signum() != side && w.abs() < SIGNAL && distance(pos, q) <= 6
        });
        if !near_enemy {
            continue;
        }
        let paired = (0..8).any(|d| {
            let q = ctx.next[pos * 8 + d];
            q >= 0 && st.grid[q as usize] == v
        });
        if paired {
            f[44] += sign(side);
        }
    }
    }

    // 4. Course aux arsenaux : un raid compte s'il arrive avant que le
    //    proprietaire puisse occuper l'arsenal (le camp au trait joue d'abord)
    if w[39] != 0.0 || w[40] != 0.0 {
    for i in 0..4 {
        if !st.ars[i] || st.grid[ctx.ars_pos[i]] != 0 {
            continue;
        }
        let owner = ctx.ars_side[i];
        let raider = -owner;
        // en combien de tours le proprietaire peut-il occuper son arsenal ?
        let owner_comm = comm_of(owner);
        let mut defend = 99u16;
        for q in units.iter() {
            let w = st.grid[q];
            if w == 0 || w.signum() != owner {
                continue;
            }
            let t = w.unsigned_abs() as usize;
            if (t as i8) < SIGNAL && !owner_comm.on[q] {
                continue;
            }
            let d = ctx.ars_dist[i][q];
            defend = defend.min((d + MOVE[t] as u16 - 1) / MOVE[t] as u16);
        }
        let raider_comm = comm_of(raider);
        let mut best = 0u8;
        for q in units.iter() {
            let w = st.grid[q];
            if w == 0 || w.signum() != raider || w.abs() >= SIGNAL || !raider_comm.on[q] {
                continue;
            }
            let t = w.unsigned_abs() as usize;
            if ctx.ars_dist[i][q] > 4 * MOVE[t] as u16 {
                continue;
            }
            if let Some(k) = race_turns(ctx, st, raider_comm, raider, q, i, 4) {
                let first = raider == to_move;
                let won = if first { defend >= k as u16 } else { defend >= k as u16 + 1 };
                if won {
                    best = best.max(5 - k);
                }
            }
        }
        if best > 0 {
            let alive = (0..4).filter(|&j| st.ars[j] && ctx.ars_side[j] == owner).count();
            let value = best as i32 * if alive == 1 { 2 } else { 1 };
            f[if raider == to_move { 39 } else { 40 }] += value;
        }
    }
    }

    // 6. Charge eclair : la cavalerie pre-positionnee pour former en un tour
    //    une colonne de 3 ou 4 sur une cible proche (blitz.rs)
    if w[47] != 0.0 || w[48] != 0.0 || w[49] != 0.0 {
        let none = [0u64; 8];
        for side in [to_move, -to_move] {
            f[47] += sign(side) * crate::blitz::readiness(ctx, st, side, comm_of(side), units, 6);
            if w[48] != 0.0 || w[49] != 0.0 {
                let cols = crate::blitz::columns(ctx, st, side, comm_of(side), units, &none, 6);
                let mut kill = 0;
                for column in cols.iter().take(3) {
                    if let Some((att, def)) = crate::blitz::strength_after(ctx, st, side, column) {
                        if att - def >= 2 {
                            kill = kill.max(VALUE[st.grid[column.target as usize].unsigned_abs() as usize]);
                        }
                    }
                }
                f[if side == to_move { 48 } else { 49 }] = kill;
            }
        }
    }

    // 5. Posture en inferiorite : tenir forteresses et cols, et se tenir
    //    entre l'ennemi et ses arsenaux
    if w[45] != 0.0 || w[46] != 0.0 {
    for side in [to_move, -to_move] {
        if !behind(side) {
            continue;
        }
        let comm = comm_of(side);
        // distance de l'ennemi le plus proche a chacun de mes arsenaux
        let mut enemy_dist = [999u16; 4];
        for i in 0..4 {
            if ctx.ars_side[i] != side || !st.ars[i] {
                continue;
            }
            for q in units.iter() {
                let w = st.grid[q];
                if w != 0 && w.signum() != side && w.abs() < SIGNAL {
                    enemy_dist[i] = enemy_dist[i].min(ctx.ars_dist[i][q]);
                }
            }
        }
        for pos in units.iter() {
            let v = st.grid[pos];
            if v == 0 || v.signum() != side || v.abs() >= SIGNAL || !comm.on[pos] {
                continue;
            }
            let t = v.unsigned_abs() as usize;
            if (ctx.terr[pos] == FORT && FORT_BONUS[t] > 0) || (ctx.terr[pos] == PASS && PASS_BONUS[t] > 0) {
                f[45] += sign(side);
            }
            if (0..4).any(|i| enemy_dist[i] < 999 && ctx.ars_dist[i][pos] < enemy_dist[i]) {
                f[46] += sign(side);
            }
        }
    }
    }
}

/// Evalue `st` quand c'est a `to_move` de jouer.
pub fn evaluate_units(ctx: &Ctx, st: &State, to_move: i8, cn: &Comm, cs: &Comm, units: &Units) -> Eval {
    let (f, winner) = features(ctx, st, to_move, cn, cs, units);
    match winner {
        0 => {
            let w = &ctx.weights.0;
            let mut total = 0.0f32;
            for i in 0..NF {
                total += w[i] * f[i] as f32;
            }
            Eval { score: (total as i32).clamp(-WIN / 2, WIN / 2) * to_move as i32, winner: 0 }
        }
        2 => Eval { score: 0, winner: 2 },
        side => Eval { score: side as i32 * WIN, winner: side },
    }
}

pub fn evaluate_with(ctx: &Ctx, st: &State, to_move: i8, cn: &Comm, cs: &Comm) -> Eval {
    evaluate_units(ctx, st, to_move, cn, cs, &Units::scan(st))
}

pub fn evaluate(ctx: &Ctx, st: &State, to_move: i8) -> Eval {
    let units = Units::scan(st);
    let cn = communications_of(ctx, st, NORTH, &units);
    let cs = communications_of(ctx, st, SOUTH, &units);
    evaluate_units(ctx, st, to_move, &cn, &cs, &units)
}
