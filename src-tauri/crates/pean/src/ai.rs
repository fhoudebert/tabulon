//! Heuristiques : portage de `pean-ai.js` (évaluation statique, combats,
//! tours candidats). Les générateurs sont ceux de jocly2, au tirage près :
//! avec le même générateur pseudo-aléatoire, ils produisent les mêmes tours
//! (tests/differential.rs).

use crate::ctx::{CombatResult, Ctx};
use std::collections::HashMap;

use crate::rules::{RawGroup, RawReach, force_of, points, to_move, Facing, Move, State, Turn, Unit, PENDING};

/// Générateur de jocly2 (`lab.js`) : congruentiel, `Math.imul`.
#[derive(Debug, Clone)]
pub struct Rng {
    pub seed: i32,
}

impl Rng {
    pub fn new(seed: i32) -> Rng {
        Rng { seed }
    }
    pub fn next(&mut self, n: i32) -> i32 {
        self.seed = self.seed.wrapping_mul(1103515245).wrapping_add(12345) & 0x7fffffff;
        if n <= 0 {
            0
        } else {
            self.seed % n
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Weights {
    pub material: f64,
    pub objective: f64,
    pub approach: f64,
    pub exposure: f64,
    pub terrain: f64,
    pub cohesion: f64,
    pub contact: f64,
    pub urgency: f64,
}

pub const WEIGHTS: Weights = Weights {
    material: 1.0,
    objective: 0.5,
    approach: 0.04,
    exposure: 0.45,
    terrain: 0.6,
    cohesion: 0.5,
    contact: 0.02,
    urgency: 0.25,
};

fn units_of(st: &State, side: i8) -> Vec<&Unit> {
    st.u.iter().filter(|u| u.s == side && u.h >= 0).collect()
}

pub fn worth(ctx: &Ctx, u: &Unit) -> f64 {
    let t = &ctx.x.types[u.t];
    t.value * u.p as f64 / t.steps as f64
}

fn defense_at(ctx: &Ctx, u: &Unit, h: i32) -> f64 {
    force_of(ctx, u) * ctx.terrain(h).def
}

/// force adverse qui pourrait frapper `h` au prochain tour, à la grosse
pub fn threat_on(ctx: &Ctx, enemies: &[&Unit], h: i32) -> f64 {
    let mut sum = 0.0;
    for e in enemies {
        let t = &ctx.x.types[e.t];
        if t.force <= 0.0 {
            continue;
        }
        let reach = (t.mp as f64 / 2.0 / 1.4).floor() as i32;
        let d = ctx.distance(e.h, h);
        let hit = if t.fire { d <= reach + 2 && d >= 2 } else { d <= reach + 1 };
        if hit {
            sum += force_of(ctx, e) * if t.charge && d >= 3 { 1.5 } else { 1.0 };
        }
    }
    sum
}

fn risk_of(ratio: f64) -> f64 {
    if ratio >= 3.0 {
        0.7
    } else if ratio >= 2.0 {
        0.45
    } else if ratio >= 1.5 {
        0.2
    } else {
        0.0
    }
}

/// évaluation statique, > 0 pour le camp 1
pub fn evaluate(ctx: &Ctx, st: &State, w: &Weights) -> f64 {
    let mover = to_move(st);
    let mut score = 0.0;
    let progress = (st.played as f64 / (2 * ctx.x.tours) as f64).min(1.0);
    let units = [units_of(st, 1), units_of(st, -1)];
    let us = |s: i8| if s == 1 { 0 } else { 1 };
    let lead = points(ctx, st, 1) - points(ctx, st, -1);
    let behind: i8 = if lead > ctx.x.nulle {
        -1
    } else if lead < -ctx.x.nulle {
        1
    } else {
        0
    };
    let urge = if behind != 0 { w.urgency * (lead.abs() / 20.0).min(1.0) * (0.3 + progress) } else { 0.0 };
    for s in [1i8, -1] {
        let mine = &units[us(s)];
        let enemies = &units[us(-s)];
        let mut sub = 0.0;
        for u in &st.u {
            if u.s == s && (u.h >= 0 || u.h == PENDING) {
                sub += w.material * worth(ctx, u);
            }
        }
        for u in mine.iter() {
            let t = &ctx.x.types[u.t];
            let terrain = ctx.terrain(u.h);
            let wu = worth(ctx, u);
            let threat = threat_on(ctx, enemies, u.h);
            if threat > 0.0 {
                let risk = risk_of(threat / defense_at(ctx, u, u.h).max(0.5));
                sub -= w.exposure * risk * wu * if s == mover { 0.35 } else { 1.0 };
            }
            if terrain.def > 1.0 && !t.fire {
                sub += w.terrain * (terrain.def - 1.0) * force_of(ctx, u);
            }
            if t.phalanx {
                for d in 0..6 {
                    let n = ctx.nb(u.h, d);
                    if n < 0 {
                        continue;
                    }
                    if mine.iter().any(|m| m.h == n && ctx.x.types[m.t].phalanx) {
                        sub += w.cohesion;
                    }
                }
            }
            if !enemies.is_empty() {
                let mut best = 99;
                for e in enemies.iter() {
                    best = best.min(ctx.distance(u.h, e.h));
                }
                sub -= (w.contact + if s == behind { urge } else { 0.0 }) * best.min(12) as f64;
            }
        }
        score += s as f64 * sub;
    }
    for (k, o) in ctx.x.objectives.iter().enumerate() {
        let w_obj = w.objective + (1.0 - w.objective) * progress * progress;
        for side in [1i8, -1] {
            if o.only != 0 && o.only != side {
                continue;
            }
            if st.ctrl[k] == side {
                score += side as f64 * w_obj * o.points;
            }
            let mut mine_d = 99;
            let mut their_d = 99;
            for u in &units[us(side)] {
                mine_d = mine_d.min(ctx.distance(u.h, o.hex));
            }
            for u in &units[us(-side)] {
                their_d = their_d.min(ctx.distance(u.h, o.hex));
            }
            score += side as f64 * w.approach * o.points * ((their_d - mine_d).clamp(-4, 4) as f64) / 4.0;
        }
    }
    score
}

/* ---------- combats ---------- */

fn combat_gain(ctx: &Ctx, turn: &Turn, ids: &[usize], target_id: usize, result: Option<CombatResult>) -> f64 {
    let target = &turn.st.u[target_id];
    let tt = &ctx.x.types[target.t];
    let step = tt.value / tt.steps as f64;
    let mut gain = match result {
        Some(CombatResult::Elimination) => worth(ctx, target) + 2.0,
        Some(CombatResult::PerteRecul) => step * 1.25,
        Some(CombatResult::Recul) => step * 0.3,
        Some(CombatResult::Echange) => {
            let victim = ids.iter().copied().find(|&id| !ctx.x.types[turn.st.u[id].t].fire).unwrap();
            let vt = &ctx.x.types[turn.st.u[victim].t];
            step - vt.value / vt.steps as f64 + if target.p == 1 { 3.0 } else { 0.0 }
        }
        _ => -1.0,
    };
    let r = result;
    if (r == Some(CombatResult::Recul) || r == Some(CombatResult::PerteRecul))
        && target.p > if r == Some(CombatResult::Recul) { 0 } else { 1 }
        && turn.retreat_hex(target_id) < 0
    {
        gain += step;
    }
    gain
}

/// Livre les combats rentables, le meilleur d'abord.
pub fn fight(ctx: &Ctx, turn: &mut Turn, greed: f64, rng: &mut Rng, noise: f64) {
    for _ in 0..12 {
        let mut best: Option<(Vec<usize>, usize, f64, Option<CombatResult>)> = None;
        for (t, a) in turn.targets() {
            let a64: Vec<i64> = a.iter().map(|&x| x as i64).collect();
            let Some(s) = turn.strength(&a64, t as i64) else { continue };
            if s.result.is_none() || s.result == Some(CombatResult::Neant) {
                continue;
            }
            let ids = turn.minimal_attackers(t, &a);
            let ids64: Vec<i64> = ids.iter().map(|&x| x as i64).collect();
            let s2 = turn.strength(&ids64, t as i64).unwrap();
            let mut gain = combat_gain(ctx, turn, &ids, t, s2.result);
            if noise != 0.0 {
                gain += rng.next(100) as f64 / 100.0 * noise;
            }
            if gain > greed && best.as_ref().map_or(true, |b| gain > b.2) {
                best = Some((ids, t, gain, s2.result));
            }
        }
        let Some((ids, t, _, result)) = best else { return };
        let from = turn.st.u[t].h;
        let mut adv = None;
        if matches!(result, Some(CombatResult::Elimination) | Some(CombatResult::PerteRecul) | Some(CombatResult::Recul)) {
            let melee: Vec<usize> = ids
                .iter()
                .copied()
                .filter(|&id| !ctx.x.types[turn.st.u[id].t].fire && ctx.distance(turn.st.u[id].h, from) == 1)
                .collect();
            if !melee.is_empty() && (ctx.obj_at[from as usize] != 0 || greed < 0.0 || rng.next(3) == 0) {
                adv = Some(*melee.last().unwrap() as i64);
            }
        }
        let ids64: Vec<i64> = ids.iter().map(|&x| x as i64).collect();
        if !turn.attack(&ids64, t as i64, adv) && !turn.attack(&ids64, t as i64, None) {
            return;
        }
    }
}

/* ---------- mouvements ---------- */

fn groups_of(ctx: &Ctx, turn: &Turn, who: i8) -> Vec<Vec<usize>> {
    let free: Vec<&Unit> = units_of(&turn.st, who).into_iter().filter(|u| !turn.ordered[u.i] && !turn.z_enemy[u.h as usize]).collect();
    let mut at = vec![usize::MAX; ctx.n];
    for u in &free {
        at[u.h as usize] = u.i;
    }
    let mut seen = vec![false; turn.st.u.len()];
    let mut groups = Vec::new();
    for u in &free {
        if seen[u.i] {
            continue;
        }
        let mut comp = vec![u.i];
        let mut stack = vec![u.i];
        seen[u.i] = true;
        while let Some(v) = stack.pop() {
            let vh = turn.st.u[v].h;
            for d in 0..6 {
                let n = ctx.nb(vh, d);
                if n < 0 {
                    continue;
                }
                let w = at[n as usize];
                if w != usize::MAX && !seen[w] && turn.st.u[w].t == u.t {
                    seen[w] = true;
                    comp.push(w);
                    stack.push(w);
                }
            }
        }
        if comp.len() >= 2 {
            groups.push(comp);
        }
    }
    groups
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Advance,
    Objective,
    Hold,
}

/// Ce que les ennemis imposent à chaque hexagone : ils ne bougent pas
/// pendant le tour (jusqu'au premier combat), on le calcule une fois.
pub struct Field {
    pub nearest: Vec<i32>,
    pub nearest_e: Vec<usize>,
    pub threat: Vec<f64>,
}

impl Field {
    pub fn new(ctx: &Ctx, enemies: &[&Unit]) -> Field {
        let mut f = Field { nearest: vec![99; ctx.n], nearest_e: vec![usize::MAX; ctx.n], threat: vec![0.0; ctx.n] };
        for h in 0..ctx.n as i32 {
            for e in enemies {
                let d = ctx.distance(h, e.h);
                if d < f.nearest[h as usize] {
                    f.nearest[h as usize] = d;
                    f.nearest_e[h as usize] = e.i;
                }
            }
            f.threat[h as usize] = threat_on(ctx, enemies, h);
        }
        f
    }
}

fn place_score(ctx: &Ctx, turn: &Turn, u: &Unit, h: i32, mode: Mode, field: &Field, friends_at: &[usize], charge: bool) -> f64 {
    let t = &ctx.x.types[u.t];
    let terrain = ctx.terrain(h);
    let mut score = 0.0;
    let nearest = field.nearest[h as usize];
    let nearest_e: Option<&Unit> = if nearest_e_ok(field, h) { Some(&turn.st.u[field.nearest_e[h as usize]]) } else { None };
    for (i, o) in ctx.x.objectives.iter().enumerate() {
        if o.only != 0 && o.only != u.s {
            continue;
        }
        let mine = turn.st.ctrl[i] == u.s;
        let d_obj = ctx.distance(h, o.hex) as f64;
        let w_obj = if mode == Mode::Objective { 1.2 } else { 0.35 };
        if !mine {
            score -= w_obj * o.points / 10.0 * d_obj;
        } else if h == o.hex {
            score += o.points / 5.0;
        }
    }
    if t.fire {
        if nearest == 2 {
            score += 8.0;
        } else if nearest == 1 {
            score -= 10.0;
        } else {
            score -= 1.5 * (nearest - 2) as f64;
        }
    } else if mode == Mode::Hold {
        score += 4.0 * (terrain.def - 1.0) * force_of(ctx, u);
        if nearest <= 1 {
            score -= 3.0;
        }
    } else if !t.general {
        if let (1, Some(ne)) = (nearest, nearest_e) {
            let mut att = force_of(ctx, u) * if charge { 2.0 } else { 1.0 };
            let def = defense_at(ctx, ne, ne.h);
            for dd in 0..6 {
                let n = ctx.nb(ne.h, dd);
                if n < 0 {
                    continue;
                }
                let f = friends_at[n as usize];
                if f != usize::MAX && f != u.i {
                    att += force_of(ctx, &turn.st.u[f]);
                }
            }
            let ratio = att / def.max(0.5);
            score += if ratio >= 3.0 {
                12.0
            } else if ratio >= 2.0 {
                9.0
            } else if ratio >= 1.5 {
                5.0
            } else if ratio >= 1.0 {
                1.0
            } else {
                -6.0
            };
        } else {
            score -= if mode == Mode::Advance { 1.6 } else { 0.6 } * nearest as f64;
        }
    }
    if t.general {
        score -= if nearest <= 2 { 15.0 } else { 0.0 };
        score -= 0.5 * (nearest - 4).abs() as f64;
    }
    let threat = field.threat[h as usize];
    let risk = risk_of(threat / (force_of(ctx, u) * terrain.def).max(0.5));
    score -= risk * worth(ctx, u) * if mode == Mode::Advance { 0.25 } else { 0.6 };
    if !t.fire && terrain.def > 1.0 {
        score += 1.5 * (terrain.def - 1.0);
    }
    score
}

#[inline]
fn nearest_e_ok(field: &Field, h: i32) -> bool {
    field.nearest_e[h as usize] != usize::MAX
}

fn facing_toward(ctx: &Ctx, h: i32, enemies: &[&Unit], fallback: i32) -> i32 {
    let mut best: Option<&Unit> = None;
    let mut bd = 99;
    for e in enemies {
        let d = ctx.distance(h, e.h);
        if d < bd {
            bd = d;
            best = Some(e);
        }
    }
    let Some(best) = best else { return fallback };
    if bd > 4 {
        return fallback;
    }
    let mut best_dir = fallback;
    let mut best_dist = 99;
    for d in 0..6 {
        let n = ctx.nb(h, d);
        if n < 0 {
            continue;
        }
        let dist = ctx.distance(n, best.h);
        if dist < best_dist {
            best_dist = dist;
            best_dir = d as i32;
        }
    }
    best_dir
}

#[derive(Debug, Clone, Copy)]
pub struct Plan {
    pub mode: Mode,
    pub groups: f64,
    pub greed: f64,
    pub noise: f64,
    pub compat: bool,
}

pub const PLANS: [Plan; 6] = [
    Plan { mode: Mode::Advance, groups: 1.0, greed: 0.5, noise: 0.0, compat: false },
    Plan { mode: Mode::Objective, groups: 1.0, greed: 0.5, noise: 0.0, compat: false },
    Plan { mode: Mode::Hold, groups: 0.6, greed: 1.0, noise: 0.0, compat: false },
    Plan { mode: Mode::Advance, groups: 0.0, greed: -2.0, noise: 0.0, compat: false },
    Plan { mode: Mode::Advance, groups: 1.4, greed: 0.0, noise: 0.0, compat: false },
    Plan { mode: Mode::Objective, groups: 0.5, greed: 0.0, noise: 0.0, compat: false },
];

fn friends_map(ctx: &Ctx, turn: &Turn, who: i8) -> Vec<usize> {
    let mut m = vec![usize::MAX; ctx.n];
    for u in units_of(&turn.st, who) {
        m[u.h as usize] = u.i;
    }
    m
}

fn is_straight(ctx: &Ctx, path: &[i32]) -> bool {
    let d0 = ctx.dir_between(path[0], path[1]);
    (2..path.len()).all(|s| ctx.dir_between(path[s - 1], path[s]) == d0)
}

/// Les destinations brutes, communes à tous les tours candidats d'une même
/// position (l'ennemi ne bouge pas avant le premier combat).
#[derive(Default)]
pub struct ReachCache {
    single: HashMap<(usize, i32), RawReach>,
    groups: HashMap<Vec<(usize, i32)>, RawGroup>,
}

/// Un tour par un générateur.
pub fn build_turn<'a>(ctx: &'a Ctx, st: &State, who: i8, plan: &Plan, rng: &mut Rng) -> Turn<'a> {
    build_turn_cached(ctx, st, who, plan, rng, &mut ReachCache::default())
}

pub fn build_turn_cached<'a>(ctx: &'a Ctx, st: &State, who: i8, plan: &Plan, rng: &mut Rng, cache: &mut ReachCache) -> Turn<'a> {
    let mut turn = Turn::new(ctx, st, who);
    let noise = plan.noise;
    // jocly2 déclare `var facing` dans la boucle : la variable n'est pas
    // remise à zéro d'un ordre à l'autre (une orientation fuit vers l'ordre
    // suivant). `plan.compat` reproduit ce comportement, pour les tests.
    let mut facing = Facing::None;
    let jitter = |rng: &mut Rng| if noise != 0.0 { (rng.next(1000) as f64 / 1000.0 - 0.5) * noise } else { 0.0 };
    let enemies_owned: Vec<Unit> = units_of(&turn.st, -who).into_iter().cloned().collect();
    let enemies: Vec<&Unit> = enemies_owned.iter().collect();
    let field = Field::new(ctx, &enemies);
    while turn.orders_left() > 0 && !turn.combat {
        let friends = friends_map(ctx, &turn, who);
        let mut best: Option<(Vec<usize>, Vec<i32>, f64)> = None;
        if plan.groups != 0.0 {
            for ids in groups_of(ctx, &turn, who) {
                let ids64: Vec<i64> = ids.iter().map(|&x| x as i64).collect();
                if turn.why_not_order(&ids64).is_some() {
                    continue;
                }
                let key: Vec<(usize, i32)> = ids.iter().map(|&id| (id, turn.st.u[id].h)).collect();
                let raw = cache.groups.entry(key).or_insert_with(|| turn.reach_group_raw(&ids));
                let dests = turn.filter_group(raw, &ids);
                let lead_h = turn.st.u[ids[0]].h;
                let units: Vec<&Unit> = ids.iter().map(|&id| &turn.st.u[id]).collect();
                let here: f64 = units.iter().map(|u| place_score(ctx, &turn, u, u.h, plan.mode, &field, &friends, false)).sum();
                for (l, path) in dests {
                    let mut sc = 0.0;
                    for u in &units {
                        let h = ctx.hex_at(
                            ctx.aq[u.h as usize] + ctx.aq[l as usize] - ctx.aq[lead_h as usize],
                            ctx.ar[u.h as usize] + ctx.ar[l as usize] - ctx.ar[lead_h as usize],
                        );
                        sc += place_score(ctx, &turn, u, h, plan.mode, &field, &friends, false);
                    }
                    let value = (sc - here) * plan.groups + 0.5 * ids.len() as f64 + jitter(rng);
                    if value > 0.5 && best.as_ref().map_or(true, |b| value > b.2) {
                        best = Some((ids.clone(), path.to_vec(), value));
                    }
                }
            }
        }
        for k in 0..turn.st.u.len() {
            let u = &turn.st.u[k];
            if u.s != who || u.h < 0 {
                continue;
            }
            if turn.ordered[u.i] || turn.why_not_order(&[u.i as i64]).is_some() {
                continue;
            }
            let t = &ctx.x.types[u.t];
            let here = place_score(ctx, &turn, u, u.h, plan.mode, &field, &friends, false);
            let raw = cache.single.entry((u.i, u.h)).or_insert_with(|| turn.reach_one_raw(u.i));
            for (h, path) in turn.filter_one(raw) {
                let straight = path.len() - 1 >= ctx.x.charge_min && t.charge && ctx.x.options.charge && is_straight(ctx, path);
                let value = place_score(ctx, &turn, u, h, plan.mode, &field, &friends, straight) - here + jitter(rng);
                if value > 0.5 && best.as_ref().map_or(true, |b| value > b.2) {
                    best = Some((vec![u.i], path.to_vec(), value));
                }
            }
        }
        let Some((ids, path, _)) = best else { break };
        if !plan.compat {
            facing = Facing::None;
        }
        let t0 = &ctx.x.types[turn.st.u[ids[0]].t];
        if ctx.x.options.orientation && t0.phalanx {
            let end = *path.last().unwrap();
            let natural = if path.len() > 1 { ctx.dir_between(path[path.len() - 2], end) } else { turn.st.u[ids[0]].f };
            let want = facing_toward(ctx, end, &enemies, natural);
            if want != natural {
                facing = Facing::Dir(want);
            }
        }
        let ids64: Vec<i64> = ids.iter().map(|&x| x as i64).collect();
        let p64: Vec<i64> = path.iter().map(|&x| x as i64).collect();
        if !turn.order(&ids64, &p64, facing) && !turn.order(&ids64, &p64, Facing::None) {
            break;
        }
    }
    if ctx.x.options.orientation {
        for k in 0..turn.st.u.len() {
            let (s, h, f, t, i) = (turn.st.u[k].s, turn.st.u[k].h, turn.st.u[k].f, turn.st.u[k].t, turn.st.u[k].i);
            if s != who || h < 0 {
                continue;
            }
            if turn.orders_left() <= 0 || turn.combat || turn.ordered[i] || !ctx.x.types[t].phalanx || !turn.z_enemy[h as usize] {
                continue;
            }
            let enemies: Vec<Unit> = units_of(&turn.st, -who).into_iter().cloned().collect();
            let er: Vec<&Unit> = enemies.iter().collect();
            let want = facing_toward(ctx, h, &er, f);
            if want != f && ctx.x.types[t].mp >= 2 {
                turn.order(&[i as i64], &[h as i64], Facing::Dir(want));
            }
        }
    }
    fight(ctx, &mut turn, plan.greed, rng, if noise != 0.0 { 1.0 } else { 0.0 });
    turn
}

/// Les tours candidats de jocly2 : combats sans bouger, puis les plans, puis
/// les plans bruités, sans doublon.
pub fn candidates(ctx: &Ctx, st: &State, who: i8, max: usize, rng: &mut Rng) -> Vec<Move> {
    candidates_with(ctx, st, who, max, rng, true)
}

pub fn candidates_with(ctx: &Ctx, st: &State, who: i8, max: usize, rng: &mut Rng, compat: bool) -> Vec<Move> {
    let mut list: Vec<Move> = Vec::new();
    let mut cache = ReachCache::default();
    let mut still = Turn::new(ctx, st, who);
    fight(ctx, &mut still, 0.5, rng, 0.0);
    list.push(still.to_move());
    let mut tries = 0;
    while list.len() < max && tries < max * 2 {
        let base = PLANS[tries % PLANS.len()];
        let noisy = tries >= PLANS.len();
        let plan = Plan { noise: if noisy { 6.0 + (tries % 3) as f64 * 4.0 } else { 0.0 }, compat, ..base };
        let mv = build_turn_cached(ctx, st, who, &plan, rng, &mut cache).to_move();
        if !list.contains(&mv) {
            list.push(mv);
        }
        tries += 1;
    }
    list
}
