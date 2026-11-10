//! Evaluation statique, en centiemes de point, positive pour le Nord.
//!
//! Memes termes que `KriegspielAI.evaluate` de jocly2 (materiel pondere par la
//! communication, arsenaux, menaces immediates, avance vers les arsenaux
//! adverses, forteresses et cols), pour que la difference de force entre les
//! deux IA vienne de la recherche et non d'un jugement different.

use crate::rules::*;

/// valeur des unites : -, I, C, A, AC, T, E
pub const VALUE: [i32; 7] = [0, 1000, 1200, 1400, 1600, 1300, 1500];
pub const ARSENAL_VALUE: i32 = 7000;
/// score d'une partie gagnee (le Nord gagne : +WIN)
pub const WIN: i32 = 1_000_000;

pub struct Eval {
    /// score pour le Nord ; +-WIN si la partie est finie
    pub score: i32,
    /// 0 : en cours, 1 / -1 : vainqueur, 2 : nulle
    pub winner: i8,
}

/// Evalue `st` quand c'est a `to_move` de jouer (le dernier coup est donc
/// celui de `-to_move`). `cn` et `cs` sont les communications du Nord et du Sud.
pub fn evaluate_with(ctx: &Ctx, st: &State, to_move: i8, cn: &Comm, cs: &Comm) -> Eval {
    evaluate_units(ctx, st, to_move, cn, cs, &Units::scan(st))
}

/// comme [`evaluate_with`], avec la liste des cases occupees deja relevee
pub fn evaluate_units(ctx: &Ctx, st: &State, to_move: i8, cn: &Comm, cs: &Comm, units: &Units) -> Eval {
    let mut score = 0i32;
    let mut alive = [0u8; 2]; // arsenaux debout : Nord, Sud
    for i in 0..4 {
        if st.ars[i] {
            score += ctx.ars_side[i] as i32 * ARSENAL_VALUE;
            alive[if ctx.ars_side[i] > 0 { 0 } else { 1 }] += 1;
        }
    }
    let mut combat = [0u32; 2];
    let mut signals = [0u32; 2];
    // pour chaque arsenal : en combien de tours l'unite combattante ennemie
    // en communication la plus proche peut y entrer
    let mut raid = [99u16; 4];
    for pos in units.iter() {
        let v = st.grid[pos];
        if v == 0 {
            continue;
        }
        let side = v.signum();
        let t = v.abs() as usize;
        let idx = if side > 0 { 0 } else { 1 };
        let in_comm = if side > 0 { cn.on[pos] } else { cs.on[pos] };
        let mut worth = if in_comm { VALUE[t] } else { VALUE[t] * 65 / 100 };
        if (t as i8) < SIGNAL {
            combat[idx] += 1;
            let mut dist = 999u16;
            for i in 0..4 {
                if ctx.ars_side[i] != side && st.ars[i] {
                    dist = dist.min(ctx.ars_dist[i][pos]);
                }
            }
            if dist < 999 {
                worth -= 12 * dist as i32;
            }
            if in_comm {
                for i in 0..4 {
                    if ctx.ars_side[i] != side && st.ars[i] {
                        let turns = (ctx.ars_dist[i][pos] + MOVE[t] as u16 - 1) / MOVE[t] as u16;
                        raid[i] = raid[i].min(turns);
                    }
                }
                if ctx.terr[pos] == FORT && FORT_BONUS[t] > 0 {
                    worth += 150;
                } else if ctx.terr[pos] == PASS && PASS_BONUS[t] > 0 {
                    worth += 100;
                }
                // arsenal ennemi vide a portee de mouvement : menace majeure
                if dist <= MOVE[t] as u16 {
                    for i in 0..4 {
                        if ctx.ars_side[i] != side
                            && st.ars[i]
                            && st.grid[ctx.ars_pos[i]] == 0
                            && ctx.ars_dist[i][pos] <= MOVE[t] as u16
                        {
                            worth += if side == to_move { 4000 } else { 2500 };
                        }
                    }
                }
            }
        } else {
            signals[idx] += 1;
        }
        score += side as i32 * worth;
    }

    // fin de partie : le camp qui vient de subir le coup d'abord
    let lost = |side: i8| -> bool {
        let idx = if side > 0 { 0 } else { 1 };
        let comm = if side > 0 { cn } else { cs };
        alive[idx] == 0
            || combat[idx] == 0
            || (ctx.isolation_victory && signals[idx] == 0 && comm.count == 0)
    };
    if st.phase >= 2 {
        if lost(to_move) {
            return Eval { score: -(to_move as i32) * WIN, winner: -to_move };
        }
        if lost(-to_move) {
            return Eval { score: to_move as i32 * WIN, winner: to_move };
        }
        if ctx.max_turns > 0 && st.turn >= ctx.max_turns {
            return Eval { score: 0, winner: 2 };
        }
    }

    // Raids sur les arsenaux : l'evaluation ne voit une attaque qu'a un tour ;
    // sans ce terme, une armee part au combat en laissant un cavalier adverse
    // marcher trois tours vers un arsenal vide. Un arsenal occupe par une
    // unite amie ne peut pas etre pris sans la detruire d'abord ; le dernier
    // arsenal vaut la partie.
    for i in 0..4 {
        if !st.ars[i] {
            continue;
        }
        let owner = ctx.ars_side[i];
        let mut penalty = match raid[i] {
            0 | 1 => 0, // deja compte plus haut, unite par unite
            // toujours moins qu'a un tour (2500 au moins, plus haut) : se
            // rapprocher doit rapporter a chaque pas, jusqu'a l'entree
            2 => 1000,
            3 => 500,
            4 => 250,
            5 => 100,
            _ => 0,
        };
        let occupant = st.grid[ctx.ars_pos[i]];
        if occupant != 0 && (occupant > 0) == (owner > 0) {
            penalty /= 3;
        }
        if alive[if owner > 0 { 0 } else { 1 }] == 1 {
            penalty *= 2;
        }
        score -= owner as i32 * penalty;
    }

    // menaces : ce que chaque camp peut detruire tout de suite
    for att_side in [NORTH, SOUTH] {
        let (ca, cd) = if att_side > 0 { (cn, cs) } else { (cs, cn) };
        let (mut best, mut sum) = (0i32, 0i32);
        for pos in units.iter() {
            let v = st.grid[pos];
            if v == 0 || (v > 0) == (att_side > 0) {
                continue;
            }
            let (att, def) = strength(ctx, st, pos, att_side, ca, cd, -1);
            if att > def {
                let value = VALUE[v.abs() as usize];
                let gain = if att - def >= 2 { value } else { value * 35 / 100 };
                sum += gain;
                best = best.max(gain);
            }
        }
        // une seule attaque par tour : la meilleure compte, les autres pesent peu
        let weight = if att_side == to_move { 80 } else { 30 };
        score += att_side as i32 * (weight * best + 5 * (sum - best)) / 100;
    }
    // sans unite de transmission, un camp ne tient plus que par ses arsenaux
    if signals[0] == 0 {
        score -= 1200;
    }
    if signals[1] == 0 {
        score += 1200;
    }
    if st.retreat >= 0 && st.grid[st.retreat as usize] != 0 {
        score -= st.grid[st.retreat as usize].signum() as i32 * 200;
    }
    Eval { score, winner: 0 }
}

pub fn evaluate(ctx: &Ctx, st: &State, to_move: i8) -> Eval {
    let cn = communications(ctx, st, NORTH);
    let cs = communications(ctx, st, SOUTH);
    evaluate_with(ctx, st, to_move, &cn, &cs)
}
