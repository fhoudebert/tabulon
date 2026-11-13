//! Les règles de Péan : portage fidèle de `pean-rules.js` (jocly2), qui reste
//! la référence. Mêmes noms, même ordre des contrôles, mêmes codes d'erreur :
//! `tests/differential.rs` compare tout, position par position.
//!
//! Hexagones : `row * cols + col`, colonnes impaires décalées vers le bas ;
//! camps 1 et -1 ; coûts de mouvement en demi-points.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ctx::{CombatResult, Ctx};

pub const DEAD: i32 = -1;
pub const PENDING: i32 = -2;

#[derive(Debug, Clone, PartialEq)]
pub struct Unit {
    pub i: usize,
    pub s: i8,
    /// indice du type dans le contexte
    pub t: usize,
    pub h: i32,
    pub p: i32,
    pub f: i32,
    pub a: i32,
    pub e: i32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct State {
    pub phase: i32,
    pub turn: i32,
    pub played: i32,
    pub u: Vec<Unit>,
    pub ctrl: Vec<i8>,
    pub hold: Vec<i32>,
    pub hs: Vec<i8>,
}

/// l'état tel que jocly2 l'écrit (le type d'une unité par son nom)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonUnit {
    pub i: usize,
    pub s: i8,
    pub t: String,
    pub h: i32,
    pub p: i32,
    pub f: i32,
    pub a: i32,
    pub e: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonState {
    pub phase: i32,
    pub turn: i32,
    pub played: i32,
    pub u: Vec<JsonUnit>,
    pub ctrl: Vec<i8>,
    pub hold: Vec<i32>,
    pub hs: Vec<i8>,
}

impl State {
    pub fn from_json(ctx: &Ctx, js: &JsonState) -> Result<State, String> {
        let mut u = Vec::with_capacity(js.u.len());
        for (k, x) in js.u.iter().enumerate() {
            let t = ctx.type_index(&x.t).ok_or_else(|| format!("type inconnu : {}", x.t))?;
            if x.i != k || (x.s != 1 && x.s != -1) || x.h < PENDING || x.h >= ctx.n as i32 {
                return Err("unite incoherente".into());
            }
            u.push(Unit { i: x.i, s: x.s, t, h: x.h, p: x.p, f: x.f, a: x.a, e: x.e });
        }
        let m = ctx.x.objectives.len();
        if js.ctrl.len() != m || js.hold.len() != m || js.hs.len() != m {
            return Err("objectifs incoherents".into());
        }
        Ok(State { phase: js.phase, turn: js.turn, played: js.played, u, ctrl: js.ctrl.clone(), hold: js.hold.clone(), hs: js.hs.clone() })
    }

    pub fn parse(ctx: &Ctx, v: &Value) -> Result<State, String> {
        let js: JsonState = serde_json::from_value(v.clone()).map_err(|e| format!("position illisible : {e}"))?;
        State::from_json(ctx, &js)
    }

    pub fn to_json(&self, ctx: &Ctx) -> JsonState {
        JsonState {
            phase: self.phase,
            turn: self.turn,
            played: self.played,
            u: self
                .u
                .iter()
                .map(|x| JsonUnit { i: x.i, s: x.s, t: ctx.x.types[x.t].key.clone(), h: x.h, p: x.p, f: x.f, a: x.a, e: x.e })
                .collect(),
            ctrl: self.ctrl.clone(),
            hold: self.hold.clone(),
            hs: self.hs.clone(),
        }
    }
}

/// le camp au trait, d'après l'état
pub fn to_move(st: &State) -> i8 {
    if st.phase < 2 {
        return if st.phase == 0 { 1 } else { -1 };
    }
    if st.played % 2 == 0 {
        1
    } else {
        -1
    }
}

pub fn round(st: &State) -> i32 {
    st.played / 2 + 1
}

pub fn occupancy(ctx: &Ctx, st: &State) -> Vec<i32> {
    let mut occ = vec![0; ctx.n];
    for (i, u) in st.u.iter().enumerate() {
        if u.h >= 0 {
            occ[u.h as usize] = i as i32 + 1;
        }
    }
    occ
}

/// zone de contrôle exercée par les unités du camp `side`
pub fn zoc(ctx: &Ctx, st: &State, side: i8) -> Vec<bool> {
    let mut z = vec![false; ctx.n];
    for u in &st.u {
        if u.s != side || u.h < 0 {
            continue;
        }
        for d in 0..6 {
            let n = ctx.nb(u.h, d);
            if n < 0 {
                continue;
            }
            let e = ctx.edge(u.h, d);
            if e != 0 && ctx.x.sides[e as usize - 1].cuts_zoc {
                continue;
            }
            z[n as usize] = true;
        }
    }
    z
}

pub fn force_of(ctx: &Ctx, u: &Unit) -> f64 {
    let t = &ctx.x.types[u.t];
    if u.p >= t.steps {
        t.force
    } else {
        (t.force / 2.0).ceil()
    }
}

/// coût (demi-points) pour passer de `from` à son voisin `to` (direction d) ; -1 : infranchissable
pub fn step_cost(ctx: &Ctx, t: usize, from: i32, to: i32, d: usize) -> i32 {
    let tt = ctx.terrain(to);
    let Some(cost) = tt.cost else { return -1 };
    let ty = &ctx.x.types[t];
    let mut c = cost[if ty.mounted { 1 } else { 0 }];
    if ty.light && c > 2 {
        c = 2;
    }
    if tt.road && ctx.terrain(from).road {
        c = 1;
    }
    let e = ctx.edge(from, d);
    if e != 0 {
        c += ctx.x.sides[e as usize - 1].cost;
    }
    c
}

pub fn losses(ctx: &Ctx, st: &State, side: i8) -> f64 {
    let mut lost = 0.0;
    for u in &st.u {
        if u.s != side {
            continue;
        }
        let t = &ctx.x.types[u.t];
        lost += t.value * (t.steps - u.p) as f64 / t.steps as f64;
    }
    lost
}

pub fn army_value(ctx: &Ctx, st: &State, side: i8) -> f64 {
    st.u.iter().filter(|u| u.s == side).map(|u| ctx.x.types[u.t].value).sum()
}

pub fn orders_for(ctx: &Ctx, st: &State, side: i8) -> i32 {
    let mut n = ctx.x.orders[0];
    for u in &st.u {
        if u.s == side && u.h >= 0 && ctx.x.types[u.t].general {
            n += ctx.x.orders[1];
        }
    }
    n
}

/// ligne de vue à 2 hexagones : au moins un voisin commun libre et ouvert
pub fn line_of_fire(ctx: &Ctx, occ: &[i32], a: i32, b: i32) -> bool {
    if ctx.distance(a, b) != 2 {
        return false;
    }
    for d in 0..6 {
        let m = ctx.nb(a, d);
        if m < 0 || ctx.distance(m, b) != 1 {
            continue;
        }
        if occ[m as usize] == 0 && !ctx.terrain(m).blocks_fire {
            return true;
        }
    }
    false
}

/// indice de colonne de la table (-1 : attaque interdite)
pub fn column(ctx: &Ctx, att: f64, def: f64) -> i32 {
    let mut col = -1;
    for (i, c) in ctx.x.table.iter().enumerate() {
        if def <= 0.0 || att * c.den >= def * c.num {
            col = i as i32;
        }
    }
    col
}

#[derive(Debug, Clone)]
pub struct Strength {
    pub att: f64,
    pub def: f64,
    pub col: i32,
    pub result: Option<CombatResult>,
    pub ranged: bool,
    pub flank: bool,
    pub charge: bool,
}

/// destinations brutes d'une unité (voir `Turn::reach_one_raw`)
#[derive(Debug, Clone, Default)]
pub struct RawReach {
    pub dij: Vec<(i32, Vec<i32>)>,
    pub lines: Vec<(i32, Vec<i32>)>,
}

/// destinations brutes d'un groupe : meneur, chemin, hexagones d'arrivée
#[derive(Debug, Clone, Default)]
pub struct RawGroup {
    pub entries: Vec<(i32, Vec<i32>, Vec<i32>)>,
}

/// Un ordre : unités (le meneur d'abord), chemin du meneur, orientation finale.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Order {
    pub u: Vec<usize>,
    pub c: Vec<i32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub f: Option<i32>,
}

/// Un combat : attaquants, cible, hexagone de la cible, unité qui avance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Combat {
    pub a: Vec<usize>,
    pub t: usize,
    pub h: i32,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub v: Option<usize>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Move {
    #[serde(default)]
    pub o: Vec<Order>,
    #[serde(default)]
    pub k: Vec<Combat>,
}

/// argument d'orientation d'un ordre, tel qu'il arrive en JSON
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Facing {
    None,
    Dir(i32),
    Invalid,
}

#[derive(Debug, Clone)]
pub struct Turn<'a> {
    pub ctx: &'a Ctx,
    pub who: i8,
    pub st: State,
    pub error: Option<&'static str>,
    pub o: Vec<Order>,
    pub k: Vec<Combat>,
    pub ordered: Vec<bool>,
    /// direction de la course droite d'une unité qui charge, -1 sinon
    pub charged: Vec<i32>,
    pub attacked: Vec<bool>,
    pub targeted: Vec<bool>,
    pub combat: bool,
    pub arrived: Vec<usize>,
    pub max_orders: i32,
    pub occ: Vec<i32>,
    pub z_enemy: Vec<bool>,
}

impl<'a> Turn<'a> {
    pub fn new(ctx: &'a Ctx, st: &State, who: i8) -> Turn<'a> {
        let n = st.u.len();
        let mut turn = Turn {
            ctx,
            who,
            st: st.clone(),
            error: None,
            o: Vec::new(),
            k: Vec::new(),
            ordered: vec![false; n],
            charged: vec![-1; n],
            attacked: vec![false; n],
            targeted: vec![false; n],
            combat: false,
            arrived: Vec::new(),
            max_orders: 0,
            occ: Vec::new(),
            z_enemy: Vec::new(),
        };
        turn.arrived = turn.arrivals();
        turn.max_orders = orders_for(ctx, &turn.st, who);
        turn.refresh();
        turn
    }

    pub fn refresh(&mut self) {
        self.occ = occupancy(self.ctx, &self.st);
        self.z_enemy = zoc(self.ctx, &self.st, -self.who);
    }

    fn arrivals(&mut self) -> Vec<usize> {
        let ctx = self.ctx;
        let mut list = Vec::new();
        if self.st.phase < 2 {
            return list;
        }
        let now = round(&self.st);
        let mut occ = occupancy(ctx, &self.st);
        for k in 0..self.st.u.len() {
            let (s, h, a, e) = (self.st.u[k].s, self.st.u[k].h, self.st.u[k].a, self.st.u[k].e);
            if s != self.who || h != PENDING || a > now {
                continue;
            }
            if occ[e as usize] == 0 {
                self.st.u[k].h = e;
                occ[e as usize] = k as i32 + 1;
                list.push(k);
                continue;
            }
            let (mut best, mut best_d) = (-1, i32::MAX);
            for d in 0..6 {
                let n = ctx.nb(e, d);
                if n < 0 || occ[n as usize] != 0 || ctx.terrain(n).cost.is_none() {
                    continue;
                }
                let dd = ctx.edge_distance(self.who, n);
                if dd < best_d {
                    best_d = dd;
                    best = n;
                }
            }
            if best >= 0 {
                self.st.u[k].h = best;
                occ[best as usize] = k as i32 + 1;
                list.push(k);
            }
        }
        list
    }

    pub fn orders_left(&self) -> i32 {
        self.max_orders - self.o.len() as i32
    }

    pub fn unit_at(&self, h: i32) -> Option<&Unit> {
        let k = self.occ[h as usize];
        if k > 0 {
            Some(&self.st.u[k as usize - 1])
        } else {
            None
        }
    }

    fn fail(&mut self, why: &'static str) -> bool {
        self.error = Some(why);
        false
    }

    /// pourquoi ces unités ne peuvent pas recevoir un ordre ; None si elles le peuvent
    pub fn why_not_order(&self, ids: &[i64]) -> Option<&'static str> {
        let ctx = self.ctx;
        if self.combat {
            return Some("combat-started");
        }
        if ids.is_empty() {
            return Some("no-unit");
        }
        if self.o.len() as i32 >= self.max_orders {
            return Some("no-order-left");
        }
        let mut ty: Option<usize> = None;
        let mut seen = vec![false; self.st.u.len()];
        for &id in ids {
            if id < 0 || id as usize >= self.st.u.len() {
                return Some("not-yours");
            }
            let u = &self.st.u[id as usize];
            if u.s != self.who || u.h < 0 {
                return Some("not-yours");
            }
            if seen[u.i] {
                return Some("bad-group");
            }
            seen[u.i] = true;
            if self.ordered[u.i] {
                return Some("already-ordered");
            }
            if let Some(t) = ty {
                if u.t != t {
                    return Some("mixed-group");
                }
            }
            ty = Some(u.t);
            let tt = &ctx.x.types[u.t];
            if ids.len() > 1 && self.z_enemy[u.h as usize] {
                return Some("group-in-zoc");
            }
            if ids.len() == 1 && self.z_enemy[u.h as usize] && !tt.disengage && !(tt.phalanx && ctx.x.options.orientation) {
                return Some("in-zoc");
            }
        }
        if ids.len() > 1 {
            let hexes: Vec<i32> = ids.iter().map(|&id| self.st.u[id as usize].h).collect();
            let mut reached = vec![hexes[0]];
            let mut stack = vec![hexes[0]];
            while let Some(h) = stack.pop() {
                for d in 0..6 {
                    let n = ctx.nb(h, d);
                    if n >= 0 && hexes.contains(&n) && !reached.contains(&n) {
                        reached.push(n);
                        stack.push(n);
                    }
                }
            }
            if reached.len() != ids.len() {
                return Some("not-contiguous");
            }
        }
        None
    }

    /// destinations (hexagone du meneur, chemin), triées par hexagone
    pub fn reach(&self, ids: &[usize]) -> Vec<(i32, Vec<i32>)> {
        let ids64: Vec<i64> = ids.iter().map(|&x| x as i64).collect();
        if self.why_not_order(&ids64).is_some() {
            return Vec::new();
        }
        if ids.len() == 1 {
            self.reach_one(ids[0])
        } else {
            self.reach_group(ids)
        }
    }

    pub fn reach_one(&self, id: usize) -> Vec<(i32, Vec<i32>)> {
        let raw = self.reach_one_raw(id);
        self.filter_one(&raw).into_iter().map(|(h, p)| (h, p.to_vec())).collect()
    }

    /// Destinations d'une unité sans tenir compte de l'occupation amie (qui ne
    /// change pas les coûts : on traverse ses propres unités) : valable tant
    /// que l'ennemi n'a pas bougé, c'est-à-dire pendant tous les ordres d'un tour.
    pub fn reach_one_raw(&self, id: usize) -> RawReach {
        let ctx = self.ctx;
        let u = &self.st.u[id];
        let t = &ctx.x.types[u.t];
        let start = u.h;
        let mp = t.mp;
        let mut raw = RawReach { dij: Vec::new(), lines: Vec::new() };
        if self.z_enemy[start as usize] && !t.disengage {
            return raw;
        }
        let enemy_at = |h: i32| {
            let oc = self.occ[h as usize];
            oc != 0 && self.st.u[oc as usize - 1].s != self.who
        };
        let n = ctx.n;
        let mut best = vec![-1i32; n];
        let mut prev = vec![-1i32; n];
        let mut queue = vec![start];
        let mut reached = Vec::new();
        best[start as usize] = 0;
        while !queue.is_empty() {
            let mut bi = 0;
            for q in 1..queue.len() {
                if best[queue[q] as usize] < best[queue[bi] as usize] {
                    bi = q;
                }
            }
            let h = queue.remove(bi);
            if h != start && self.z_enemy[h as usize] {
                continue;
            }
            for d in 0..6 {
                let nx = ctx.nb(h, d);
                if nx < 0 || enemy_at(nx) {
                    continue;
                }
                if h == start && self.z_enemy[start as usize] && self.z_enemy[nx as usize] {
                    continue;
                }
                let c = step_cost(ctx, u.t, h, nx, d);
                if c < 0 {
                    continue;
                }
                let total = best[h as usize] + c;
                if total > mp {
                    continue;
                }
                if best[nx as usize] < 0 || total < best[nx as usize] {
                    if best[nx as usize] < 0 {
                        queue.push(nx);
                        reached.push(nx);
                    }
                    best[nx as usize] = total;
                    prev[nx as usize] = h;
                }
            }
        }
        reached.sort_unstable();
        for dest in reached {
            if dest == start {
                continue;
            }
            let mut path = vec![dest];
            let mut h = dest;
            while h != start {
                h = prev[h as usize];
                path.push(h);
            }
            path.reverse();
            raw.dij.push((dest, path));
        }
        // ligne droite à coût égal ou supérieur, dans le potentiel
        for dd in 0..6 {
            let mut line = vec![start];
            let mut spent = 0;
            let mut h2 = start;
            for _ in 0..20 {
                let nx = ctx.nb(h2, dd);
                if nx < 0 || enemy_at(nx) {
                    break;
                }
                if h2 == start && self.z_enemy[start as usize] && self.z_enemy[nx as usize] {
                    break;
                }
                let cc = step_cost(ctx, u.t, h2, nx, dd);
                if cc < 0 || spent + cc > mp {
                    break;
                }
                spent += cc;
                line.push(nx);
                h2 = nx;
                if line.len() - 1 >= 2 {
                    raw.lines.push((nx, line.clone()));
                }
                if self.z_enemy[nx as usize] {
                    break;
                }
            }
        }
        raw
    }

    /// les destinations libres d'après l'occupation actuelle, triées
    pub fn filter_one<'r>(&self, raw: &'r RawReach) -> Vec<(i32, &'r [i32])> {
        let mut out: Vec<(i32, &[i32])> = raw.dij.iter().filter(|(h, _)| self.occ[*h as usize] == 0).map(|(h, p)| (*h, p.as_slice())).collect();
        for (h, line) in &raw.lines {
            if self.occ[*h as usize] != 0 {
                continue;
            }
            match out.binary_search_by_key(h, |x| x.0) {
                Ok(i) => out[i].1 = line.as_slice(),
                Err(i) => out.insert(i, (*h, line.as_slice())),
            }
        }
        out
    }

    fn shifted(&self, from: i32, leader_from: i32, leader_to: i32) -> i32 {
        let ctx = self.ctx;
        ctx.hex_at(
            ctx.aq[from as usize] + ctx.aq[leader_to as usize] - ctx.aq[leader_from as usize],
            ctx.ar[from as usize] + ctx.ar[leader_to as usize] - ctx.ar[leader_from as usize],
        )
    }

    pub fn reach_group(&self, ids: &[usize]) -> Vec<(i32, Vec<i32>)> {
        let raw = self.reach_group_raw(ids);
        self.filter_group(&raw, ids).into_iter().map(|(h, p)| (h, p.to_vec())).collect()
    }

    /// destinations d'un groupe, sans l'occupation amie finale (voir reach_one_raw)
    pub fn reach_group_raw(&self, ids: &[usize]) -> RawGroup {
        let ctx = self.ctx;
        let units: Vec<&Unit> = ids.iter().map(|&id| &self.st.u[id]).collect();
        let t = units[0].t;
        let mp = ctx.x.types[t].mp;
        let lead = units[0].h;
        let n = ctx.n;
        let mut spent: Vec<Option<Vec<i32>>> = vec![None; n];
        let mut prev = vec![-1i32; n];
        let mut queue = vec![lead];
        spent[lead as usize] = Some(vec![0; units.len()]);
        let worst = |a: &Vec<i32>| *a.iter().max().unwrap();
        while !queue.is_empty() {
            let mut bi = 0;
            for q in 1..queue.len() {
                if worst(spent[queue[q] as usize].as_ref().unwrap()) < worst(spent[queue[bi] as usize].as_ref().unwrap()) {
                    bi = q;
                }
            }
            let l = queue.remove(bi);
            let here: Vec<i32> = units.iter().map(|u| self.shifted(u.h, lead, l)).collect();
            if l != lead && here.iter().any(|&h| self.z_enemy[h as usize]) {
                continue;
            }
            let cur = spent[l as usize].clone().unwrap();
            for d in 0..6 {
                let nl = ctx.nb(l, d);
                if nl < 0 {
                    continue;
                }
                let mut cost = Vec::with_capacity(units.len());
                let mut ok = true;
                for i in 0..units.len() {
                    let from = here[i];
                    let to = ctx.nb(from, d);
                    if to < 0 {
                        ok = false;
                        break;
                    }
                    let oc = self.occ[to as usize];
                    if oc != 0 && self.st.u[oc as usize - 1].s != self.who {
                        ok = false;
                        break;
                    }
                    let c = step_cost(ctx, t, from, to, d);
                    if c < 0 || cur[i] + c > mp {
                        ok = false;
                        break;
                    }
                    cost.push(cur[i] + c);
                }
                if !ok {
                    continue;
                }
                let better = match &spent[nl as usize] {
                    None => true,
                    Some(old) => worst(&cost) < worst(old),
                };
                if better {
                    if spent[nl as usize].is_none() {
                        queue.push(nl);
                    }
                    spent[nl as usize] = Some(cost);
                    prev[nl as usize] = l;
                }
            }
        }
        let mut out = RawGroup { entries: Vec::new() };
        for l in 0..n as i32 {
            if spent[l as usize].is_none() || l == lead {
                continue;
            }
            let members: Vec<i32> = units.iter().map(|u| self.shifted(u.h, lead, l)).collect();
            let mut path = vec![l];
            let mut h = l;
            while h != lead {
                h = prev[h as usize];
                path.push(h);
            }
            path.reverse();
            out.entries.push((l, path, members));
        }
        out
    }

    pub fn filter_group<'r>(&self, raw: &'r RawGroup, ids: &[usize]) -> Vec<(i32, &'r [i32])> {
        raw.entries
            .iter()
            .filter(|(_, _, members)| {
                members.iter().all(|&h| {
                    let oc = self.occ[h as usize];
                    oc == 0 || ids.contains(&(oc as usize - 1))
                })
            })
            .map(|(l, p, _)| (*l, p.as_slice()))
            .collect()
    }

    /// Donne un ordre ; false (et `error`) s'il est refusé. Rien n'est modifié
    /// avant que tout soit vérifié.
    pub fn order(&mut self, ids: &[i64], path: &[i64], facing: Facing) -> bool {
        let ctx = self.ctx;
        self.error = None;
        if let Some(why) = self.why_not_order(ids) {
            return self.fail(why);
        }
        let idx: Vec<usize> = ids.iter().map(|&x| x as usize).collect();
        let t = self.st.u[idx[0]].t;
        let ty = &ctx.x.types[t];
        if path.is_empty() || path[0] != self.st.u[idx[0]].h as i64 {
            return self.fail("bad-path");
        }
        let steps = path.len() - 1;
        let mut spent = vec![0; idx.len()];
        let mut pos: Vec<i32> = idx.iter().map(|&i| self.st.u[i].h).collect();
        let start_in_zoc: Vec<bool> = idx.iter().map(|&i| self.z_enemy[self.st.u[i].h as usize]).collect();
        if steps > 0 && idx.len() == 1 && start_in_zoc[0] && !ty.disengage {
            return self.fail("in-zoc");
        }
        let mut dirs = Vec::with_capacity(steps);
        for s in 1..=steps {
            let a = path[s - 1];
            let b = path[s];
            let d = if a < 0 || a >= ctx.n as i64 || b < -1 || b > i32::MAX as i64 { -1 } else { ctx.dir_between(a as i32, b as i32) };
            if d < 0 {
                return self.fail("bad-path");
            }
            let d = d as usize;
            dirs.push(d);
            for i in 0..idx.len() {
                let from = pos[i];
                let to = ctx.nb(from, d);
                if to < 0 {
                    return self.fail("off-map");
                }
                if s > 1 && self.z_enemy[from as usize] {
                    return self.fail("zoc-stop");
                }
                if s == 1 && start_in_zoc[i] && self.z_enemy[to as usize] {
                    return self.fail("zoc-to-zoc");
                }
                let oc = self.occ[to as usize];
                if oc != 0 && self.st.u[oc as usize - 1].s != self.who {
                    return self.fail("enemy-in-way");
                }
                let c = step_cost(ctx, t, from, to, d);
                if c < 0 {
                    return self.fail("impassable");
                }
                spent[i] += c;
                if spent[i] > ty.mp {
                    return self.fail("too-far");
                }
                pos[i] = to;
            }
        }
        let mut dest: Vec<i32> = Vec::new();
        for j in 0..idx.len() {
            let oc = self.occ[pos[j] as usize];
            if dest.contains(&pos[j]) {
                return self.fail("stacking");
            }
            dest.push(pos[j]);
            if oc != 0 && !idx.contains(&(oc as usize - 1)) {
                return self.fail("stacking");
            }
        }
        let mut new_facing: Vec<i32> = idx.iter().map(|&i| self.st.u[i].f).collect();
        if ctx.x.options.orientation && ty.phalanx {
            let natural = if steps > 0 { dirs[steps - 1] as i32 } else { self.st.u[idx[0]].f };
            let wanted = match facing {
                Facing::None => natural,
                Facing::Dir(f) => f,
                Facing::Invalid => return self.fail("bad-facing"),
            };
            if !(0..=5).contains(&wanted) {
                return self.fail("bad-facing");
            }
            if wanted != natural {
                for w in 0..idx.len() {
                    spent[w] += 2;
                    if spent[w] > ty.mp {
                        return self.fail("too-far");
                    }
                }
            }
            new_facing = vec![wanted; idx.len()];
        } else if facing != Facing::None {
            return self.fail("no-facing");
        }
        if steps == 0 && !(ctx.x.options.orientation && ty.phalanx && new_facing[0] != self.st.u[idx[0]].f) {
            return self.fail("no-move");
        }
        let straight = steps >= ctx.x.charge_min && dirs.iter().all(|&x| x == dirs[0]);
        for (k, &i) in idx.iter().enumerate() {
            self.st.u[i].h = pos[k];
            self.st.u[i].f = new_facing[k];
            self.ordered[i] = true;
            let ut = &ctx.x.types[self.st.u[i].t];
            if straight && ut.charge && ctx.x.options.charge && !ctx.terrain(pos[k]).no_charge {
                self.charged[i] = dirs[0] as i32;
            }
        }
        self.o.push(Order {
            u: idx.clone(),
            c: path.iter().map(|&x| x as i32).collect(),
            f: match facing {
                Facing::Dir(f) => Some(f),
                _ => None,
            },
        });
        self.refresh();
        true
    }

    /// les unités du camp au trait qui peuvent encore attaquer `target`
    pub fn attackers_of(&self, target_id: usize) -> Vec<usize> {
        let ctx = self.ctx;
        let mut list = Vec::new();
        let Some(target) = self.st.u.get(target_id) else { return list };
        if target.h < 0 || target.s == self.who || self.targeted[target_id] {
            return list;
        }
        for (i, u) in self.st.u.iter().enumerate() {
            if u.s != self.who || u.h < 0 || self.attacked[i] {
                continue;
            }
            let t = &ctx.x.types[u.t];
            if t.force <= 0.0 {
                continue;
            }
            let dist = ctx.distance(u.h, target.h);
            let ok = if t.fire { dist == 2 && line_of_fire(ctx, &self.occ, u.h, target.h) } else { dist == 1 };
            if ok {
                list.push(i);
            }
        }
        list
    }

    /// les cibles possibles et leurs attaquants possibles
    pub fn targets(&self) -> Vec<(usize, Vec<usize>)> {
        let mut out = Vec::new();
        for (i, u) in self.st.u.iter().enumerate() {
            if u.s == self.who || u.h < 0 || self.targeted[i] {
                continue;
            }
            let a = self.attackers_of(i);
            if !a.is_empty() {
                out.push((i, a));
            }
        }
        out
    }

    /// phalanges amies alignées derrière `u`, à l'opposé de la direction d
    pub fn depth(&self, u: &Unit, d: usize) -> i32 {
        let ctx = self.ctx;
        if !ctx.x.options.profondeur || !ctx.x.types[u.t].phalanx || ctx.terrain(u.h).disorder {
            return 0;
        }
        let back = (d + 3) % 6;
        let mut h = u.h;
        let mut n = 0;
        while n < 2 {
            h = ctx.nb(h, back);
            if h < 0 {
                break;
            }
            let oc = self.occ[h as usize];
            if oc == 0 {
                break;
            }
            let v = &self.st.u[oc as usize - 1];
            if v.s != u.s || !ctx.x.types[v.t].phalanx {
                break;
            }
            n += 1;
        }
        n
    }

    /// rapport de force d'une attaque ; None si elle est impossible
    pub fn strength(&self, ids: &[i64], target_id: i64) -> Option<Strength> {
        let ctx = self.ctx;
        if target_id < 0 || target_id as usize >= self.st.u.len() {
            return None;
        }
        let tid = target_id as usize;
        let target = &self.st.u[tid];
        if target.h < 0 || target.s == self.who || self.targeted[tid] {
            return None;
        }
        let allowed = self.attackers_of(tid);
        if ids.is_empty() {
            return None;
        }
        let mut seen: Vec<i64> = Vec::new();
        for &id in ids {
            if id < 0 || !allowed.contains(&(id as usize)) || seen.contains(&id) {
                return None;
            }
            seen.push(id);
        }
        let tt = &ctx.x.types[target.t];
        let terrain = ctx.terrain(target.h);
        let (mut att, mut melee, mut flank, mut first_dir, mut best_depth) = (0.0, 0, false, -1i32, 0);
        let mut charge = false;
        for &id in ids {
            let u = &self.st.u[id as usize];
            let t = &ctx.x.types[u.t];
            let mut f = force_of(ctx, u);
            if !t.fire {
                melee += 1;
                let d = ctx.dir_between(u.h, target.h) as usize;
                let from_defender = ((d + 3) % 6) as i32;
                if first_dir < 0 {
                    first_dir = from_defender;
                }
                let rel = (from_defender - target.f + 6).rem_euclid(6);
                if ctx.x.options.orientation && tt.phalanx && target.f >= 0 && (rel == 2 || rel == 3 || rel == 4) {
                    flank = true;
                }
                let e = ctx.edge(u.h, d);
                let frontal = tt.phalanx && !(ctx.x.options.orientation && target.f >= 0 && (rel == 2 || rel == 3 || rel == 4));
                if self.charged[id as usize] >= 0 && e == 0 && !terrain.no_charge && !frontal && !(terrain.height > ctx.terrain(u.h).height) {
                    f *= 2.0;
                    charge = true;
                }
                if e != 0 && ctx.x.sides[e as usize - 1].attack != 1.0 {
                    f *= ctx.x.sides[e as usize - 1].attack;
                }
                let dp = self.depth(u, d);
                if dp > best_depth {
                    best_depth = dp;
                }
            }
            att += f;
        }
        if best_depth > 0 {
            att += best_depth as f64;
        }
        let mut def = force_of(ctx, target) * terrain.def;
        if flank {
            def *= ctx.x.flank;
        }
        if first_dir >= 0 {
            let dd = self.depth(target, first_dir as usize);
            if dd > 0 {
                def += dd as f64;
            }
        }
        let col = column(ctx, att, def);
        let mut result = if col < 0 { None } else { Some(ctx.x.table[col as usize].result) };
        if melee == 0 {
            if let Some(r) = result {
                result = Some(if r == CombatResult::Echange || r == CombatResult::Neant { CombatResult::Neant } else { CombatResult::Recul });
            }
        }
        Some(Strength { att, def, col, result, ranged: melee == 0, flank, charge })
    }

    /// Le plus petit ensemble d'attaquants qui garde le meilleur résultat ; le
    /// premier est l'unité au contact la moins précieuse (perte d'un échange).
    pub fn minimal_attackers(&self, target: usize, all: &[usize]) -> Vec<usize> {
        let ctx = self.ctx;
        let as64 = |v: &[usize]| v.iter().map(|&x| x as i64).collect::<Vec<i64>>();
        if all.is_empty() {
            return Vec::new();
        }
        let Some(full) = self.strength(&as64(all), target as i64) else { return Vec::new() };
        if full.result.is_none() {
            return Vec::new();
        }
        let mut keep: Vec<usize> = all.to_vec();
        let mut order = all.to_vec();
        order.sort_by(|&a, &b| {
            let fa = force_of(ctx, &self.st.u[a]);
            let fb = force_of(ctx, &self.st.u[b]);
            fa.partial_cmp(&fb).unwrap().then(a.cmp(&b))
        });
        for &x in &order {
            let trial: Vec<usize> = keep.iter().copied().filter(|&id| id != x).collect();
            if trial.is_empty() {
                continue;
            }
            if let Some(s) = self.strength(&as64(&trial), target as i64) {
                if s.col == full.col && s.result == full.result {
                    keep = trial;
                }
            }
        }
        let worth = |id: usize| {
            let u = &self.st.u[id];
            let t = &ctx.x.types[u.t];
            t.value * u.p as f64 / t.steps as f64
        };
        keep.sort_by(|&a, &b| {
            let fa = ctx.x.types[self.st.u[a].t].fire as i32;
            let fb = ctx.x.types[self.st.u[b].t].fire as i32;
            fa.cmp(&fb).then(worth(a).partial_cmp(&worth(b)).unwrap()).then(a.cmp(&b))
        });
        keep
    }

    /// hexagone de recul : vers le bord du camp, libre, hors zone ennemie
    pub fn retreat_hex(&self, k: usize) -> i32 {
        let ctx = self.ctx;
        let u = &self.st.u[k];
        let z = zoc(ctx, &self.st, -u.s);
        let mut best = -1;
        let mut best_key: Option<(i32, f64, usize)> = None;
        for d in 0..6 {
            let n = ctx.nb(u.h, d);
            if n < 0 || self.occ[n as usize] != 0 || z[n as usize] || step_cost(ctx, u.t, u.h, n, d) < 0 {
                continue;
            }
            let key = (ctx.edge_distance(u.s, n), -ctx.terrain(n).def, d);
            let better = match best_key {
                None => true,
                Some(b) => key.0 < b.0 || (key.0 == b.0 && (key.1 < b.1 || (key.1 == b.1 && key.2 < b.2))),
            };
            if better {
                best_key = Some(key);
                best = n;
            }
        }
        best
    }

    fn lose_step(&mut self, k: usize) {
        let u = &mut self.st.u[k];
        u.p -= 1;
        if u.p <= 0 {
            u.p = 0;
            u.h = DEAD;
        }
    }

    /// Livre un combat ; une avance refusée annule tout le combat.
    pub fn attack(&mut self, ids: &[i64], target_id: i64, advance: Option<i64>) -> bool {
        let ctx = self.ctx;
        self.error = None;
        let Some(s) = self.strength(ids, target_id) else { return self.fail("no-attack") };
        let Some(result) = s.result else { return self.fail("too-weak") };
        let tid = target_id as usize;
        let from = self.st.u[tid].h;
        let saved = (self.st.clone(), self.attacked.clone(), self.targeted.clone(), self.combat);
        match result {
            CombatResult::Neant => {}
            CombatResult::Echange => {
                self.lose_step(tid);
                let victim = ids.iter().map(|&x| x as usize).find(|&id| !ctx.x.types[self.st.u[id].t].fire);
                if let Some(v) = victim {
                    self.lose_step(v);
                }
            }
            CombatResult::Recul => self.retreat(tid),
            CombatResult::PerteRecul => {
                self.lose_step(tid);
                if self.st.u[tid].h >= 0 {
                    self.retreat(tid);
                }
            }
            CombatResult::Elimination => {
                self.st.u[tid].p = 0;
                self.st.u[tid].h = DEAD;
            }
        }
        for &id in ids {
            self.attacked[id as usize] = true;
        }
        self.targeted[tid] = true;
        self.combat = true;
        self.refresh();
        let mut advanced = None;
        if let Some(adv) = advance {
            let ok = adv >= 0 && (adv as usize) < self.st.u.len() && ids.contains(&adv) && {
                let a = &self.st.u[adv as usize];
                a.h >= 0
                    && !ctx.x.types[a.t].fire
                    && ctx.distance(a.h, from) == 1
                    && self.occ[from as usize] == 0
                    && step_cost(ctx, a.t, a.h, from, ctx.dir_between(a.h, from) as usize) >= 0
            };
            if !ok {
                self.st = saved.0;
                self.attacked = saved.1;
                self.targeted = saved.2;
                self.combat = saved.3;
                self.refresh();
                return self.fail("bad-advance");
            }
            let a = adv as usize;
            let d = ctx.dir_between(self.st.u[a].h, from);
            self.st.u[a].h = from;
            if self.st.u[a].f >= 0 {
                self.st.u[a].f = d;
            }
            advanced = Some(a);
            self.refresh();
        }
        self.k.push(Combat { a: ids.iter().map(|&x| x as usize).collect(), t: tid, h: from, v: advanced });
        true
    }

    fn retreat(&mut self, k: usize) {
        self.refresh();
        let to = self.retreat_hex(k);
        if to < 0 {
            self.lose_step(k);
        } else {
            self.st.u[k].h = to;
        }
    }

    /// fin du tour : contrôle des objectifs, compteurs de tenue
    pub fn finish(&mut self) {
        let ctx = self.ctx;
        let occ = occupancy(ctx, &self.st);
        let who = self.who;
        for (i, o) in ctx.x.objectives.iter().enumerate() {
            let oc = occ[o.hex as usize];
            let side = if oc != 0 { self.st.u[oc as usize - 1].s } else { 0 };
            if side != 0 {
                self.st.ctrl[i] = side;
            }
            if side == who {
                self.st.hold[i] = if self.st.hs[i] == who { self.st.hold[i] + 1 } else { 1 };
                self.st.hs[i] = who;
            } else if side != self.st.hs[i] {
                self.st.hold[i] = 0;
                self.st.hs[i] = side;
            }
        }
        self.st.played += 1;
        self.st.turn += 1;
    }

    pub fn to_move(&self) -> Move {
        Move { o: self.o.clone(), k: self.k.clone() }
    }
}

fn int_list(v: &Value) -> Option<Vec<i64>> {
    let arr = v.as_array()?;
    let mut out = Vec::with_capacity(arr.len());
    for x in arr {
        // un element qui n'est pas un entier ne designe rien : -1
        out.push(x.as_i64().filter(|_| x.is_i64() || x.is_u64()).unwrap_or(i64::MIN));
    }
    Some(out)
}

/// Joue un tour donné en JSON, comme `PeanRules.playTurn` (phase de jeu
/// seulement : le déploiement libre reste à jocly2).
pub fn play_turn<'a>(ctx: &'a Ctx, st: &State, who: i8, mv: &Value) -> Result<Turn<'a>, &'static str> {
    if !mv.is_object() {
        return Err("no-move");
    }
    if to_move(st) != who {
        return Err("wrong-side");
    }
    if st.phase < 2 {
        return Err("placement");
    }
    if mv.get("p").is_some() {
        return Err("bad-move");
    }
    let mut turn = Turn::new(ctx, st, who);
    let empty = Value::Array(Vec::new());
    let orders = mv.get("o").unwrap_or(&empty);
    let combats = mv.get("k").unwrap_or(&empty);
    let (Some(orders), Some(combats)) = (orders.as_array(), combats.as_array()) else { return Err("bad-move") };
    for o in orders {
        let (Some(u), Some(c)) = (o.get("u").and_then(int_list), o.get("c").and_then(int_list)) else { return Err("bad-order") };
        let facing = match o.get("f") {
            None | Some(Value::Null) => Facing::None,
            Some(v) => match v.as_f64() {
                Some(x) if x == x.floor() && (0.0..=5.0).contains(&x) => Facing::Dir(x as i32),
                _ => Facing::Invalid,
            },
        };
        if !turn.order(&u, &c, facing) {
            return Err(turn.error.unwrap_or("bad-order"));
        }
    }
    for k in combats {
        let Some(a) = k.get("a").and_then(int_list) else { return Err("bad-combat") };
        let tv = k.get("t");
        let t_int = tv.and_then(|v| if v.is_i64() || v.is_u64() { v.as_i64() } else { None });
        if let Some(h) = k.get("h") {
            let ok = matches!(t_int, Some(t) if t >= 0 && (t as usize) < turn.st.u.len() && h.as_i64() == Some(turn.st.u[t as usize].h as i64));
            if !ok {
                return Err("bad-target-hex");
            }
        }
        let t = match (t_int, tv) {
            (Some(t), _) => t,
            // un nombre non entier ne désigne aucune unité
            (None, Some(v)) if v.is_number() => -1,
            _ => return Err("bad-combat"),
        };
        let v = match k.get("v") {
            None | Some(Value::Null) => None,
            Some(x) => Some(x.as_i64().unwrap_or(-1)),
        };
        if !turn.attack(&a, t, v) {
            return Err(turn.error.unwrap_or("bad-combat"));
        }
    }
    turn.finish();
    Ok(turn)
}

/// Joue un tour déjà construit (coup du moteur) : pas de JSON.
pub fn apply(ctx: &Ctx, st: &State, who: i8, mv: &Move) -> Result<State, &'static str> {
    let mut turn = Turn::new(ctx, st, who);
    for o in &mv.o {
        let ids: Vec<i64> = o.u.iter().map(|&x| x as i64).collect();
        let path: Vec<i64> = o.c.iter().map(|&x| x as i64).collect();
        let f = o.f.map(Facing::Dir).unwrap_or(Facing::None);
        if !turn.order(&ids, &path, f) {
            return Err(turn.error.unwrap_or("bad-order"));
        }
    }
    for k in &mv.k {
        let ids: Vec<i64> = k.a.iter().map(|&x| x as i64).collect();
        if !turn.attack(&ids, k.t as i64, k.v.map(|x| x as i64)) {
            return Err(turn.error.unwrap_or("bad-combat"));
        }
    }
    turn.finish();
    Ok(turn.st)
}

pub fn points(ctx: &Ctx, st: &State, side: i8) -> f64 {
    let mut vp = losses(ctx, st, -side);
    for (i, o) in ctx.x.objectives.iter().enumerate() {
        if st.ctrl[i] == side && (o.only == 0 || o.only == side) {
            vp += o.points;
        }
    }
    vp
}

/// (vainqueur : 0 en cours, 1, -1, 2 nulle ; raison)
pub fn outcome(ctx: &Ctx, st: &State, mover: i8) -> (i8, &'static str) {
    if st.phase < 2 {
        return (0, "");
    }
    for s in [-mover, mover] {
        if !st.u.iter().any(|u| u.s == s && (u.h >= 0 || u.h == PENDING)) {
            return (-s, "annihilated");
        }
    }
    let broken = |s: i8| {
        let total = army_value(ctx, st, s);
        total > 0.0 && losses(ctx, st, s) >= total * ctx.x.rupture
    };
    let (b1, b2) = (broken(1), broken(-1));
    if b1 && b2 {
        let r1 = losses(ctx, st, 1) / army_value(ctx, st, 1);
        let r2 = losses(ctx, st, -1) / army_value(ctx, st, -1);
        if r1 == r2 {
            return (2, "broken");
        }
        return (if r1 > r2 { -1 } else { 1 }, "broken");
    }
    let broken_of = |s: i8| if s == 1 { b1 } else { b2 };
    if broken_of(-mover) {
        return (mover, "broken");
    }
    if broken_of(mover) {
        return (-mover, "broken");
    }
    for (i, o) in ctx.x.objectives.iter().enumerate() {
        if o.immediate && st.hs[i] == mover && st.hold[i] >= o.hold && (o.only == 0 || o.only == mover) {
            return (mover, "objective");
        }
    }
    if st.played >= 2 * ctx.x.tours {
        let diff = points(ctx, st, 1) - points(ctx, st, -1);
        if diff.abs() <= ctx.x.nulle {
            return (2, "points");
        }
        return (if diff > 0.0 { 1 } else { -1 }, "points");
    }
    (0, "")
}
