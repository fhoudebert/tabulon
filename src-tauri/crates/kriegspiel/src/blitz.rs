//! La charge eclair : une cavalerie pre-positionnee qui se deploie en un tour
//! en une colonne de 3 ou 4 cavaliers alignee sur une cible, dans l'une des
//! huit directions, avec le moins de deplacements possible pour qu'il en
//! reste au soutien (artillerie, infanterie) avant l'attaque.
//!
//! Rappel de la regle (rules.rs, `strength`) : un cavalier au contact de la
//! cible vaut 7 au lieu de 4, ainsi que chaque cavalier qui le suit sans
//! interruption sur la meme ligne, jusqu'a quatre ; pas de charge contre une
//! forteresse ou un col, ni depuis une forteresse.
//!
//! Ce module repond a deux questions, pour un camp :
//! - [`columns`] : contre chaque cible proche, quelle colonne peut-on former
//!   en un tour, et avec quels deplacements ? C'est la mesure du
//!   pre-positionnement, que l'evaluation recompense (eval.rs) ;
//! - [`execute`] : jouer cette colonne pour de bon, dans un ordre legal, puis
//!   amener des soutiens ; c'est le generateur de tours de la recherche.
//!
//! Approximation assumee : les destinations sont calculees sur la position
//! de depart (les autres cavaliers immobiles). `execute` verifie chaque
//! deplacement avec les regles et essaie plusieurs ordres ; une colonne que
//! l'ordre des deplacements rend impossible n'est simplement pas jouee.

use crate::rules::*;

/// Une colonne formable en un tour contre `target`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Column {
    pub target: u16,
    /// direction (0..8) de la cible vers la colonne
    pub dir: u8,
    /// cavaliers dans la colonne apres le tour (2 a 4)
    pub n: u8,
    /// deplacements de cavalerie necessaires, (de, vers)
    pub moves: Vec<(u16, u16)>,
}

impl Column {
    /// note de pre-positionnement : une longue colonne d'abord, peu de
    /// deplacements ensuite
    pub fn readiness(&self) -> i32 {
        4 * self.n as i32 - self.moves.len() as i32
    }
}

/// Les cavaliers du camp qui peuvent prendre part a une charge : en
/// communication (pour bouger, et pour compter dans l'attaque), pas encore
/// deplaces ce tour (`moved`, cases deja jouees), avec leurs destinations.
fn riders(ctx: &Ctx, st: &State, side: i8, comm: &Comm, units: &Units, moved: &[u64; 8]) -> Vec<(usize, Vec<u16>)> {
    let mut out = Vec::new();
    for pos in units.iter() {
        if st.grid[pos] != side * CAVALRY || !comm.on[pos] {
            continue;
        }
        let mut dests = Vec::with_capacity(24);
        if moved[pos >> 6] & (1 << (pos & 63)) == 0 {
            reach(ctx, st, pos, &mut dests);
        }
        out.push((pos, dests));
    }
    out
}

/// Attribue des cavaliers distincts aux cases vides `slots` ; `free` :
/// indices des cavaliers disponibles. Renvoie les (cavalier, case).
fn assign(riders: &[(usize, Vec<u16>)], free: &[usize], slots: &[usize]) -> Option<Vec<(usize, usize)>> {
    fn go(riders: &[(usize, Vec<u16>)], free: &[usize], slots: &[usize], used: &mut Vec<usize>, out: &mut Vec<(usize, usize)>) -> bool {
        let Some((&slot, rest)) = slots.split_first() else { return true };
        for &r in free {
            if used.contains(&r) || !riders[r].1.contains(&(slot as u16)) {
                continue;
            }
            used.push(r);
            out.push((riders[r].0, slot));
            if go(riders, free, rest, used, out) {
                return true;
            }
            used.pop();
            out.pop();
        }
        false
    }
    let mut out = Vec::new();
    if go(riders, free, slots, &mut Vec::new(), &mut out) { Some(out) } else { None }
}

/// La meilleure colonne contre `target` (au moins 2 cavaliers), toutes
/// directions confondues ; None si aucune.
fn best_against(ctx: &Ctx, st: &State, side: i8, target: usize, riders: &[(usize, Vec<u16>)]) -> Option<Column> {
    if ctx.terr[target] == FORT || ctx.terr[target] == PASS {
        return None; // pas de charge contre une forteresse ou un col
    }
    let mut best: Option<Column> = None;
    for d in 0..8 {
        // les cases de la colonne, du contact vers l'arriere
        let mut squares = Vec::with_capacity(4);
        let mut p = target;
        for _ in 0..4 {
            let q = ctx.next[p * 8 + d];
            if q < 0 {
                break;
            }
            p = q as usize;
            if ctx.terr[p] == MOUNTAIN || ctx.terr[p] == FORT {
                break; // un cavalier en forteresse ne charge pas
            }
            let v = st.grid[p];
            if v != 0 && v != side * CAVALRY {
                break; // une autre unite coupe la colonne
            }
            if v == side * CAVALRY && !riders.iter().any(|r| r.0 == p) {
                break; // cavalier isole : il ne compte pas
            }
            squares.push(p);
        }
        // la plus longue colonne realisable, de 4 a 2
        for n in (2..=squares.len()).rev() {
            let column = &squares[..n];
            let fixed: Vec<usize> = column.iter().copied().filter(|&q| st.grid[q] == side * CAVALRY).collect();
            let empty: Vec<usize> = column.iter().copied().filter(|&q| st.grid[q] == 0).collect();
            let free: Vec<usize> = (0..riders.len()).filter(|&r| !fixed.contains(&riders[r].0)).collect();
            if empty.len() > free.len() {
                continue;
            }
            if let Some(moves) = assign(riders, &free, &empty) {
                let candidate = Column {
                    target: target as u16,
                    dir: d as u8,
                    n: n as u8,
                    moves: moves.into_iter().map(|(a, b)| (a as u16, b as u16)).collect(),
                };
                if best.as_ref().map_or(true, |b| candidate.readiness() > b.readiness()) {
                    best = Some(candidate);
                }
                break;
            }
        }
    }
    best
}

/// Les colonnes formables en un tour par `side`, une par cible (la
/// meilleure), contre les unites adverses a `max_dist` cases au plus d'un
/// cavalier ; de la meilleure a la moins bonne. Vide avec moins de deux
/// cavaliers en communication.
pub fn columns(ctx: &Ctx, st: &State, side: i8, comm: &Comm, units: &Units, moved: &[u64; 8], max_dist: usize) -> Vec<Column> {
    // d'abord sans rien calculer : au moins deux cavaliers en communication,
    // et une cible a portee de l'un d'eux (le cas de loin le plus frequent
    // dans une evaluation est qu'il n'y en a pas)
    let mut cavalry = [0usize; 4];
    let mut count = 0;
    for pos in units.iter() {
        if st.grid[pos] == side * CAVALRY && comm.on[pos] && count < 4 {
            cavalry[count] = pos;
            count += 1;
        }
    }
    if count < 2 {
        return Vec::new();
    }
    let near = |target: usize| cavalry[..count].iter().any(|&c| distance(c, target) <= max_dist);
    if !units.iter().any(|t| {
        let v = st.grid[t];
        v != 0 && v.signum() != side && ctx.terr[t] != FORT && ctx.terr[t] != PASS && near(t)
    }) {
        return Vec::new();
    }
    let riders = riders(ctx, st, side, comm, units, moved);
    let mut out = Vec::new();
    for target in units.iter() {
        let v = st.grid[target];
        if v == 0 || v.signum() == side {
            continue;
        }
        if !near(target) {
            continue;
        }
        if let Some(column) = best_against(ctx, st, side, target, &riders) {
            out.push(column);
        }
    }
    out.sort_by(|a, b| b.readiness().cmp(&a.readiness()));
    out
}

/// Joue la colonne sur une copie de la position, dans un ordre legal (les
/// cavaliers liberent et occupent des cases : on essaie les ordres possibles).
/// Renvoie les deplacements dans l'ordre joue et la position obtenue.
pub fn play_column(ctx: &Ctx, st: &State, side: i8, column: &Column) -> Option<(Vec<(u16, u16)>, State)> {
    let moves = &column.moves;
    let k = moves.len();
    let mut order: Vec<usize> = (0..k).collect();
    // permutations par l'algorithme de Heap, 24 au plus
    let mut c = vec![0usize; k];
    let mut i = 0;
    loop {
        if let Some(result) = try_order(ctx, st, side, moves, &order) {
            return Some(result);
        }
        while i < k && c[i] >= i {
            c[i] = 0;
            i += 1;
        }
        if i >= k {
            return None;
        }
        if i % 2 == 0 { order.swap(0, i) } else { order.swap(c[i], i) }
        c[i] += 1;
        i = 0;
    }
}

fn try_order(ctx: &Ctx, st: &State, side: i8, moves: &[(u16, u16)], order: &[usize]) -> Option<(Vec<(u16, u16)>, State)> {
    let mut st = st.clone();
    let mut played = Vec::with_capacity(moves.len());
    let mut dests = Vec::with_capacity(24);
    for &i in order {
        let (from, to) = (moves[i].0 as usize, moves[i].1 as usize);
        if !communications(ctx, &st, side).on[from] {
            return None;
        }
        reach(ctx, &st, from, &mut dests);
        if !dests.contains(&(to as u16)) || ctx.enemy_arsenal_at(&st, to, side).is_some() {
            return None;
        }
        st.grid[to] = st.grid[from];
        st.grid[from] = 0;
        played.push(moves[i]);
    }
    Some((played, st))
}

/// Ce que vaudrait l'attaque sur la cible une fois la colonne en place, sans
/// autre deplacement : (attaque, defense).
pub fn strength_after(ctx: &Ctx, st: &State, side: i8, column: &Column) -> Option<(i32, i32)> {
    let (_, after) = play_column(ctx, st, side, column)?;
    let units = Units::scan(&after);
    let ca = communications_of(ctx, &after, side, &units);
    let cd = communications_of(ctx, &after, -side, &units);
    Some(strength(ctx, &after, column.target as usize, side, &ca, &cd, -1))
}

/// Combien de cavaliers chargent dans l'attaque sur `target` : la plus longue
/// colonne contigue de cavaliers en communication, au contact. Sert a
/// compter les charges jouees (kriegspiel-lab).
pub fn charge_length(ctx: &Ctx, st: &State, target: usize, side: i8) -> u8 {
    if ctx.terr[target] == FORT || ctx.terr[target] == PASS {
        return 0;
    }
    let comm = communications(ctx, st, side);
    let mut best = 0;
    for d in 0..8 {
        let mut p = target;
        let mut n = 0;
        for _ in 0..4 {
            let q = ctx.next[p * 8 + d];
            if q < 0 {
                break;
            }
            p = q as usize;
            if st.grid[p] != side * CAVALRY || !comm.on[p] || ctx.terr[p] == FORT {
                break;
            }
            n += 1;
        }
        best = best.max(n);
    }
    best
}

/// Version rapide de [`columns`] pour l'evaluation : la note de la meilleure
/// colonne (`4 x cavaliers - deplacements`), 0 s'il n'y en a pas. Memes
/// regles, sans allocation : elle est appelee a chaque position evaluee.
pub fn readiness(ctx: &Ctx, st: &State, side: i8, comm: &Comm, units: &Units, max_dist: usize) -> i32 {
    // les cavaliers en communication, et leurs destinations en bits
    let mut pos = [0usize; 4];
    let mut reachable = [[0u64; 8]; 4];
    let mut count = 0;
    for p in units.iter() {
        if st.grid[p] == side * CAVALRY && comm.on[p] && count < 4 {
            pos[count] = p;
            count += 1;
        }
    }
    if count < 2 {
        return 0;
    }
    let near = |t: usize| pos[..count].iter().any(|&c| distance(c, t) <= max_dist);
    let mut any = false;
    for t in units.iter() {
        let v = st.grid[t];
        if v != 0 && v.signum() != side && ctx.terr[t] != FORT && ctx.terr[t] != PASS && near(t) {
            any = true;
            break;
        }
    }
    if !any {
        return 0;
    }
    let mut dests: Vec<u16> = Vec::with_capacity(24);
    for k in 0..count {
        reach(ctx, st, pos[k], &mut dests);
        for &q in &dests {
            reachable[k][q as usize >> 6] |= 1 << (q & 63);
        }
    }
    let can = |k: usize, q: usize| reachable[k][q >> 6] & (1 << (q & 63)) != 0;
    // attribue des cavaliers distincts (masque `free`) aux cases `slots`
    fn fill(slots: &[usize], free: u8, count: usize, can: &dyn Fn(usize, usize) -> bool) -> bool {
        let Some((&slot, rest)) = slots.split_first() else { return true };
        for k in 0..count {
            if free & (1 << k) != 0 && can(k, slot) && fill(rest, free & !(1 << k), count, can) {
                return true;
            }
        }
        false
    }
    let mut best = 0;
    for t in units.iter() {
        let v = st.grid[t];
        if v == 0 || v.signum() == side || ctx.terr[t] == FORT || ctx.terr[t] == PASS || !near(t) {
            continue;
        }
        for d in 0..8 {
            let mut squares = [0usize; 4];
            let mut len = 0;
            let mut p = t;
            for _ in 0..4 {
                let q = ctx.next[p * 8 + d];
                if q < 0 {
                    break;
                }
                p = q as usize;
                if ctx.terr[p] == MOUNTAIN || ctx.terr[p] == FORT {
                    break;
                }
                let w = st.grid[p];
                if w != 0 && (w != side * CAVALRY || !comm.on[p]) {
                    break;
                }
                squares[len] = p;
                len += 1;
            }
            for n in (2..=len).rev() {
                // ne peut pas faire mieux que ce qu'on a deja
                if 4 * n as i32 <= best {
                    break;
                }
                let mut fixed: u8 = 0;
                let mut empty = [0usize; 4];
                let mut holes = 0;
                for &q in &squares[..n] {
                    if st.grid[q] == 0 {
                        empty[holes] = q;
                        holes += 1;
                    } else if let Some(k) = pos[..count].iter().position(|&c| c == q) {
                        fixed |= 1 << k;
                    }
                }
                let free = ((1u8 << count) - 1) & !fixed;
                if holes as u32 <= free.count_ones() && fill(&empty[..holes], free, count, &can) {
                    best = best.max(4 * n as i32 - holes as i32);
                    break;
                }
            }
        }
    }
    best
}
