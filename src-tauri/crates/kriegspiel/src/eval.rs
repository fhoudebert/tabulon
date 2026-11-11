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

pub const NF: usize = 39;

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
];

/// Les poids en service. Voir le README pour la facon de les reproduire.
pub const TUNED: [f32; NF] = HANDMADE;

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
    for att_side in [to_move, -to_move] {
        let (ca, cd) = (comm_of(att_side), comm_of(-att_side));
        let (mut best, mut sum) = (0i32, 0i32);
        for pos in units.iter() {
            let v = st.grid[pos];
            if v == 0 || (v > 0) == (att_side > 0) {
                continue;
            }
            let (att, def) = strength(ctx, st, pos, att_side, ca, cd, -1);
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
    (f, 0)
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
