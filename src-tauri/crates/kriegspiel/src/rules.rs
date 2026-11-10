//! Les regles. Portage fidele de `kriegspiel-rules.js` : memes noms, meme
//! ordre des verifications, memes codes d'erreur, pour que le test
//! differentiel compare les deux implementations terme a terme.

pub const W: usize = 25;
pub const H: usize = 20;
pub const N: usize = W * H;

pub const NORTH: i8 = 1;
pub const SOUTH: i8 = -1;

pub const INFANTRY: i8 = 1;
pub const CAVALRY: i8 = 2;
pub const ARTILLERY: i8 = 3;
pub const HORSE_ARTILLERY: i8 = 4;
pub const SIGNAL: i8 = 5;
pub const COURIER: i8 = 6;

pub const PLAIN: u8 = 0;
pub const MOUNTAIN: u8 = 1;
pub const PASS: u8 = 2;
pub const FORT: u8 = 3;

// indexes par type d'unite : -, I, C, A, AC, T, E
pub const MOVE: [u8; 7] = [0, 1, 2, 1, 2, 1, 2];
pub const RANGE: [u8; 7] = [0, 2, 2, 3, 3, 2, 2];
pub const ATTACK: [i32; 7] = [0, 4, 4, 5, 5, 0, 0];
pub const DEFENSE: [i32; 7] = [0, 6, 5, 8, 8, 1, 1];
pub const FORT_BONUS: [i32; 7] = [0, 4, 0, 4, 4, 0, 0];
pub const PASS_BONUS: [i32; 7] = [0, 2, 0, 2, 2, 0, 0];
pub const COUNT: [usize; 7] = [0, 9, 4, 1, 1, 1, 1];
pub const CHARGE: i32 = 7;
pub const MAX_MOVES: u8 = 5;

const DX: [i32; 8] = [0, 1, 1, 1, 0, -1, -1, -1];
const DY: [i32; 8] = [-1, -1, 0, 1, 1, 1, 0, -1];

const MOUNTAINS: [&str; 18] = [
    "C10", "C11", "C12", "C13", "D10", "E10", "G10", "H10", "I10", "N11", "N12", "N13", "N14",
    "N15", "N16", "P16", "Q16", "R16",
];
const PASSES: [&str; 2] = ["F10", "O16"];
const FORTS: [&str; 6] = ["B8", "I13", "H21", "M3", "L15", "O23"];
const ARSENALS: [(&str, i8); 4] = [("D8", NORTH), ("B15", NORTH), ("T3", SOUTH), ("T23", SOUTH)];

pub fn pos_of(name: &str) -> Option<usize> {
    let bytes = name.as_bytes();
    if bytes.len() < 2 {
        return None;
    }
    let row = bytes[0].to_ascii_uppercase().wrapping_sub(b'A') as usize;
    let col: usize = name[1..].parse().ok()?;
    if row >= H || col < 1 || col > W {
        return None;
    }
    Some(row * W + col - 1)
}

pub fn pos_name(pos: usize) -> String {
    format!("{}{}", (b'A' + (pos / W) as u8) as char, pos % W + 1)
}

#[inline]
pub fn side_of(v: i8) -> i8 {
    v.signum()
}
#[inline]
pub fn type_of(v: i8) -> i8 {
    v.abs()
}
#[inline]
pub fn territory(pos: usize) -> i8 {
    if pos < N / 2 { NORTH } else { SOUTH }
}
#[inline]
pub fn distance(a: usize, b: usize) -> usize {
    let dr = (a / W).abs_diff(b / W);
    let dc = (a % W).abs_diff(b % W);
    dr.max(dc)
}

/// La carte et ses tables, calculees une fois.
pub struct Ctx {
    pub terr: [u8; N],
    pub ars_pos: [usize; 4],
    pub ars_side: [i8; 4],
    /// indice d'arsenal + 1, ou 0
    pub ars_at: [u8; N],
    /// voisin dans chacune des 8 directions, ou -1
    pub next: Vec<i16>,
    /// distance en pas de roi a chaque arsenal, montagnes contournees
    pub ars_dist: Vec<[u16; N]>,
    /// nulle apres ce nombre de coups (placements compris) ; 0 : pas de limite
    pub max_turns: u32,
    /// victoire quand l'adversaire n'a plus de transmission et que tout est isole
    pub isolation_victory: bool,
}

impl Default for Ctx {
    fn default() -> Self {
        Ctx::new(400, true)
    }
}

impl Ctx {
    pub fn new(max_turns: u32, isolation_victory: bool) -> Ctx {
        let mut terr = [PLAIN; N];
        for name in MOUNTAINS {
            terr[pos_of(name).unwrap()] = MOUNTAIN;
        }
        for name in PASSES {
            terr[pos_of(name).unwrap()] = PASS;
        }
        for name in FORTS {
            terr[pos_of(name).unwrap()] = FORT;
        }
        let mut ars_pos = [0usize; 4];
        let mut ars_side = [0i8; 4];
        let mut ars_at = [0u8; N];
        for (i, (name, side)) in ARSENALS.iter().enumerate() {
            ars_pos[i] = pos_of(name).unwrap();
            ars_side[i] = *side;
            ars_at[ars_pos[i]] = i as u8 + 1;
        }
        let mut next = vec![-1i16; N * 8];
        for pos in 0..N {
            for d in 0..8 {
                let c = (pos % W) as i32 + DX[d];
                let r = (pos / W) as i32 + DY[d];
                if c >= 0 && c < W as i32 && r >= 0 && r < H as i32 {
                    next[pos * 8 + d] = (r * W as i32 + c) as i16;
                }
            }
        }
        let mut ars_dist = Vec::new();
        for &from in ars_pos.iter() {
            let mut dist = [999u16; N];
            let mut queue = vec![from];
            let mut head = 0;
            dist[from] = 0;
            while head < queue.len() {
                let p = queue[head];
                head += 1;
                for d in 0..8 {
                    let q = next[p * 8 + d];
                    if q >= 0 && terr[q as usize] != MOUNTAIN && dist[q as usize] == 999 {
                        dist[q as usize] = dist[p] + 1;
                        queue.push(q as usize);
                    }
                }
            }
            ars_dist.push(dist);
        }
        Ctx { terr, ars_pos, ars_side, ars_at, next, ars_dist, max_turns, isolation_victory }
    }

    /// l'arsenal ENNEMI encore debout qui se trouve sur cette case
    #[inline]
    pub fn enemy_arsenal_at(&self, st: &State, pos: usize, side: i8) -> Option<usize> {
        let i = self.ars_at[pos] as usize;
        if i > 0 && st.ars[i - 1] && self.ars_side[i - 1] != side { Some(i - 1) } else { None }
    }
}

/// L'etat d'une partie : celui que porte le plateau du modele Jocly.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct State {
    /// 0 : le Nord place, 1 : le Sud place, 2 : jeu
    pub phase: u8,
    pub grid: [i8; N],
    pub ars: [bool; 4],
    /// case de l'unite du camp au trait qui doit faire retraite, ou -1
    pub retreat: i16,
    /// nombre de coups joues, placements compris
    pub turn: u32,
}

impl State {
    pub fn new() -> State {
        State { phase: 0, grid: [0; N], ars: [true; 4], retreat: -1, turn: 0 }
    }
}

impl Default for State {
    fn default() -> Self {
        State::new()
    }
}

/// Les communications d'un camp.
#[derive(Clone)]
pub struct Comm {
    /// la case est sur une ligne de communication du camp
    pub lit: [bool; N],
    /// l'unite du camp qui s'y trouve est en communication
    pub on: [bool; N],
    pub count: u32,
    pub total: u32,
}

/// Les cases occupees, relevees une fois : la recherche evite ainsi de
/// reparcourir les 500 cases a chaque calcul.
#[derive(Clone)]
pub struct Units {
    pub pos: [u16; 40],
    pub len: usize,
}

impl Units {
    pub fn scan(st: &State) -> Units {
        let mut units = Units { pos: [0; 40], len: 0 };
        for (pos, &v) in st.grid.iter().enumerate() {
            if v != 0 && units.len < units.pos.len() {
                units.pos[units.len] = pos as u16;
                units.len += 1;
            }
        }
        units
    }
    #[inline]
    pub fn iter(&self) -> impl Iterator<Item = usize> + '_ {
        self.pos[..self.len].iter().map(|&p| p as usize)
    }
}

pub fn communications(ctx: &Ctx, st: &State, side: i8) -> Comm {
    communications_of(ctx, st, side, &Units::scan(st))
}

/// comme [`communications`], avec la liste des cases occupees deja relevee
pub fn communications_of(ctx: &Ctx, st: &State, side: i8, units: &Units) -> Comm {
    let grid = &st.grid;
    let mut lit = [false; N];
    let mut on = [false; N];
    let mut emitted = [false; N];
    let mut queue: [u16; 8] = [0; 8]; // 2 arsenaux + 2 transmissions au plus
    let mut len = 0;
    for i in 0..4 {
        if ctx.ars_side[i] == side && st.ars[i] {
            lit[ctx.ars_pos[i]] = true;
            queue[len] = ctx.ars_pos[i] as u16;
            len += 1;
        }
    }
    while len > 0 {
        len -= 1;
        let src = queue[len] as usize;
        for d in 0..8 {
            let mut p = src;
            loop {
                let q = ctx.next[p * 8 + d];
                if q < 0 {
                    break;
                }
                p = q as usize;
                if ctx.terr[p] == MOUNTAIN {
                    break;
                }
                let v = grid[p];
                if v != 0 {
                    let enemy = (v > 0) != (side > 0);
                    let signal = v.abs() >= SIGNAL;
                    // une unite ennemie arrete la ligne AVANT sa case, sauf une
                    // unite de transmission, que la ligne traverse
                    if enemy && !signal {
                        break;
                    }
                    if !enemy && signal && !emitted[p] {
                        emitted[p] = true;
                        if len < queue.len() {
                            queue[len] = p as u16;
                            len += 1;
                        }
                    }
                }
                lit[p] = true;
            }
        }
    }
    // unites sur une ligne, puis contact en chaine entre unites combattantes
    let mut stack: [u16; 40] = [0; 40];
    let mut top = 0;
    let (mut count, mut total) = (0u32, 0u32);
    for pos in units.iter() {
        let u = grid[pos];
        if u == 0 || (u > 0) != (side > 0) {
            continue;
        }
        total += 1;
        if lit[pos] {
            on[pos] = true;
            count += 1;
            if u.abs() < SIGNAL && top < stack.len() {
                stack[top] = pos as u16;
                top += 1;
            }
        }
    }
    while top > 0 {
        top -= 1;
        let pos = stack[top] as usize;
        for d in 0..8 {
            let q = ctx.next[pos * 8 + d];
            if q < 0 || on[q as usize] {
                continue;
            }
            let q = q as usize;
            let w = grid[q];
            if w != 0 && (w > 0) == (side > 0) && w.abs() < SIGNAL {
                on[q] = true;
                count += 1;
                if top < stack.len() {
                    stack[top] = q as u16;
                    top += 1;
                }
            }
        }
    }
    Comm { lit, on, count, total }
}

/// Cases que l'unite posee en `from` peut atteindre : pas dans les 8
/// directions par des cases VIDES, montagnes exclues, sur une longueur au plus
/// egale a son mouvement. Une unite combattante qui entre dans un arsenal
/// ennemi debout s'y arrete. Ne dit rien du droit de bouger.
pub fn reach(ctx: &Ctx, st: &State, from: usize, dests: &mut Vec<u16>) {
    dests.clear();
    let v = st.grid[from];
    if v == 0 {
        return;
    }
    let side = side_of(v);
    let t = type_of(v);
    let combat = t < SIGNAL;
    for d in 0..8 {
        let q = ctx.next[from * 8 + d];
        if q < 0 {
            continue;
        }
        let q = q as usize;
        if ctx.terr[q] == MOUNTAIN || st.grid[q] != 0 {
            continue;
        }
        dests.push(q as u16);
    }
    if MOVE[t as usize] < 2 {
        return;
    }
    let first = dests.len();
    for i in 0..first {
        let p = dests[i] as usize;
        if combat && ctx.enemy_arsenal_at(st, p, side).is_some() {
            continue;
        }
        for d in 0..8 {
            let q = ctx.next[p * 8 + d];
            if q < 0 {
                continue;
            }
            let q = q as usize;
            if q == from || ctx.terr[q] == MOUNTAIN || st.grid[q] != 0 {
                continue;
            }
            if !dests.contains(&(q as u16)) {
                dests.push(q as u16);
            }
        }
    }
}

/// coefficient defensif d'une unite, bonus de terrain compris
#[inline]
pub fn defense_at(ctx: &Ctx, st: &State, pos: usize) -> i32 {
    let t = type_of(st.grid[pos]) as usize;
    DEFENSE[t]
        + match ctx.terr[pos] {
            FORT => FORT_BONUS[t],
            PASS => PASS_BONUS[t],
            _ => 0,
        }
}

/// Rapport de force sur `target`, attaquee par `att_side` : (attaque, defense).
/// `excluded` : case de l'unite qui a fait retraite ce tour, ou -1.
pub fn strength(
    ctx: &Ctx,
    st: &State,
    target: usize,
    att_side: i8,
    comm_a: &Comm,
    comm_d: &Comm,
    excluded: i16,
) -> (i32, i32) {
    let grid = &st.grid;
    let (mut att, mut def) = (0, 0);
    if grid[target] != 0 && comm_d.on[target] {
        def += defense_at(ctx, st, target);
    }
    let charge_allowed = ctx.terr[target] != FORT && ctx.terr[target] != PASS;
    for d in 0..8 {
        let mut p = target;
        let mut charging = charge_allowed;
        for k in 1..=4u8 {
            let q = ctx.next[p * 8 + d];
            if q < 0 {
                break;
            }
            p = q as usize;
            if ctx.terr[p] == MOUNTAIN {
                break;
            }
            let v = grid[p];
            if v == 0 {
                charging = false;
                continue;
            }
            let t = v.abs();
            if (v > 0) == (att_side > 0) {
                let able = t < SIGNAL && comm_a.on[p] && p as i16 != excluded;
                if charging && t == CAVALRY && able && ctx.terr[p] != FORT {
                    att += CHARGE;
                    continue;
                }
                charging = false;
                if able && k <= RANGE[t as usize] {
                    att += ATTACK[t as usize];
                }
            } else {
                charging = false;
                if comm_d.on[p] && k <= RANGE[t as usize] {
                    def += defense_at(ctx, st, p);
                }
            }
        }
    }
    (att, def)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Attack {
    pub target: u16,
    pub att: i32,
    pub def: i32,
}

/// toutes les attaques qui ont un effet (attaque > defense) pour `att_side`
pub fn attacks_for(
    ctx: &Ctx,
    st: &State,
    att_side: i8,
    comm_a: &Comm,
    comm_d: &Comm,
    excluded: i16,
    out: &mut Vec<Attack>,
) {
    out.clear();
    for pos in 0..N {
        let v = st.grid[pos];
        if v == 0 || (v > 0) == (att_side > 0) {
            continue;
        }
        let (att, def) = strength(ctx, st, pos, att_side, comm_a, comm_d, excluded);
        if att > def {
            out.push(Attack { target: pos as u16, att, def });
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
    Destroy,
    Retreat,
}

/// Ce que donne une attaque d'ecart `delta` >= 1 sur `target` : une retraite
/// forcee impossible (unite isolee, ou sans case libre) est une destruction.
pub fn outcome_of(ctx: &Ctx, st: &State, target: usize, delta: i32, comm_d: &Comm) -> Outcome {
    if delta >= 2 {
        return Outcome::Destroy;
    }
    let v = st.grid[target];
    let can_move = type_of(v) >= SIGNAL || comm_d.on[target];
    if !can_move {
        return Outcome::Destroy;
    }
    let mut dests = Vec::with_capacity(24);
    reach(ctx, st, target, &mut dests);
    if dests.is_empty() { Outcome::Destroy } else { Outcome::Retreat }
}

/// Un coup Jocly : un tour complet, ou un placement.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Move {
    /// placement : (type, case) des 17 unites
    pub p: Option<Vec<(i8, u16)>>,
    /// retraite forcee
    pub r: Option<(u16, u16)>,
    /// deplacements, dans l'ordre
    pub m: Vec<(u16, u16)>,
    /// case attaquee
    pub a: Option<u16>,
    /// case de l'arsenal detruit pendant le tour
    pub d: Option<u16>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct AttackResult {
    pub target: u16,
    pub att: i32,
    pub def: i32,
    pub outcome: Outcome,
}

/// Un tour en cours de construction : memes regles pour la validation, la
/// recherche et le test differentiel.
pub struct Turn<'a> {
    pub ctx: &'a Ctx,
    pub st: State,
    pub who: i8,
    pub n: u8,
    pub moved: Vec<u16>,
    pub r: Option<(u16, u16)>,
    pub m: Vec<(u16, u16)>,
    pub a: Option<u16>,
    pub d: Option<u16>,
    pub excluded: i16,
    pub need_retreat: bool,
    pub result: Option<AttackResult>,
}

impl<'a> Turn<'a> {
    pub fn new(ctx: &'a Ctx, st: &State, who: i8) -> Turn<'a> {
        let mut st = st.clone();
        let need_retreat = st.retreat >= 0 && side_of(st.grid[st.retreat as usize]) == who;
        if !need_retreat {
            st.retreat = -1;
        }
        Turn {
            ctx, st, who, n: 0, moved: Vec::new(), r: None, m: Vec::new(), a: None, d: None,
            excluded: -1, need_retreat, result: None,
        }
    }

    /// None si l'unite en `from` a le droit de bouger maintenant, sinon la raison
    pub fn why_not_move(&self, from: usize, comm: &Comm) -> Option<&'static str> {
        let v = self.st.grid[from];
        if self.a.is_some() {
            return Some("attack-done");
        }
        if v == 0 || side_of(v) != self.who {
            return Some("not-yours");
        }
        if self.need_retreat && from as i16 != self.st.retreat {
            return Some("retreat-first");
        }
        if self.moved.contains(&(from as u16)) {
            return Some("already-moved");
        }
        if self.n >= MAX_MOVES {
            return Some("too-many-moves");
        }
        // les unites de transmission se deplacent meme isolees
        if type_of(v) < SIGNAL && !comm.on[from] {
            return Some("isolated");
        }
        None
    }

    /// destinations permises pour l'unite en `from` (vide si elle ne peut pas bouger)
    pub fn dests(&self, from: usize, comm: &Comm, out: &mut Vec<u16>) {
        out.clear();
        if self.why_not_move(from, comm).is_some() {
            return;
        }
        reach(self.ctx, &self.st, from, out);
        if self.d.is_some() && type_of(self.st.grid[from]) < SIGNAL {
            // la destruction d'un arsenal compte comme l'attaque du tour
            let (ctx, st, who) = (self.ctx, &self.st, self.who);
            out.retain(|&q| ctx.enemy_arsenal_at(st, q as usize, who).is_none());
        }
    }

    pub fn comm(&self, side: i8) -> Comm {
        communications(self.ctx, &self.st, side)
    }

    pub fn do_move(&mut self, from: usize, to: usize) -> Result<(), &'static str> {
        let comm = self.comm(self.who);
        if let Some(why) = self.why_not_move(from, &comm) {
            return Err(why);
        }
        let mut dests = Vec::with_capacity(24);
        self.dests(from, &comm, &mut dests);
        if !dests.contains(&(to as u16)) {
            return Err("unreachable");
        }
        self.apply_move(from, to);
        Ok(())
    }

    /// le deplacement lui-meme, sans verification
    pub fn apply_move(&mut self, from: usize, to: usize) {
        let v = self.st.grid[from];
        self.st.grid[from] = 0;
        self.st.grid[to] = v;
        if type_of(v) < SIGNAL {
            if let Some(i) = self.ctx.enemy_arsenal_at(&self.st, to, self.who) {
                self.st.ars[i] = false;
                self.d = Some(to as u16);
            }
        }
        self.moved.push(to as u16);
        self.n += 1;
        if self.need_retreat {
            self.r = Some((from as u16, to as u16));
            self.excluded = to as i16;
            self.need_retreat = false;
            self.st.retreat = -1;
        } else {
            self.m.push((from as u16, to as u16));
        }
    }

    /// les attaques possibles maintenant
    pub fn attacks(&self, out: &mut Vec<Attack>) {
        out.clear();
        if self.a.is_some() || self.d.is_some() || self.need_retreat {
            return;
        }
        let (ca, cd) = (self.comm(self.who), self.comm(-self.who));
        attacks_for(self.ctx, &self.st, self.who, &ca, &cd, self.excluded, out);
    }

    pub fn attack(&mut self, target: usize) -> Result<(), &'static str> {
        if self.a.is_some() {
            return Err("attack-done");
        }
        if self.d.is_some() {
            return Err("arsenal-destroyed");
        }
        if self.need_retreat {
            return Err("retreat-first");
        }
        if target >= N {
            return Err("no-target");
        }
        let v = self.st.grid[target];
        if v == 0 || side_of(v) == self.who {
            return Err("no-target");
        }
        let (ca, cd) = (self.comm(self.who), self.comm(-self.who));
        let (att, def) = strength(self.ctx, &self.st, target, self.who, &ca, &cd, self.excluded);
        if att <= def {
            return Err("no-effect");
        }
        let outcome = outcome_of(self.ctx, &self.st, target, att - def, &cd);
        self.a = Some(target as u16);
        self.result = Some(AttackResult { target: target as u16, att, def, outcome });
        match outcome {
            Outcome::Destroy => self.st.grid[target] = 0,
            Outcome::Retreat => self.st.retreat = target as i16,
        }
        Ok(())
    }

    pub fn finish(&mut self) -> Result<(), &'static str> {
        if self.need_retreat {
            return Err("retreat-first");
        }
        self.st.turn += 1;
        Ok(())
    }

    pub fn to_move(&self) -> Move {
        Move { p: None, r: self.r, m: self.m.clone(), a: self.a, d: self.d }
    }
}

pub fn check_placement(ctx: &Ctx, st: &State, who: i8, p: &[(i8, u16)]) -> Result<(), &'static str> {
    let mut counts = [0usize; 7];
    let mut used = [false; N];
    for &(t, pos) in p {
        if !(1..=6).contains(&t) {
            return Err("bad-unit");
        }
        let pos = pos as usize;
        if pos >= N {
            return Err("bad-square");
        }
        if territory(pos) != who {
            return Err("outside-territory");
        }
        if ctx.terr[pos] == MOUNTAIN {
            return Err("mountain");
        }
        if st.grid[pos] != 0 || used[pos] {
            return Err("occupied");
        }
        used[pos] = true;
        counts[t as usize] += 1;
    }
    if (1..=6).any(|t| counts[t] != COUNT[t]) {
        return Err("bad-count");
    }
    Ok(())
}

/// Joue un coup complet sur une copie de l'etat, en verifiant tout.
pub fn play_turn(ctx: &Ctx, st: &State, who: i8, mv: &Move) -> Result<(State, Option<AttackResult>), &'static str> {
    if st.phase < 2 {
        if (st.phase == 0) != (who == NORTH) {
            return Err("wrong-side");
        }
        let p = mv.p.as_ref().ok_or("no-placement")?;
        check_placement(ctx, st, who, p)?;
        if mv.r.is_some() || !mv.m.is_empty() || mv.a.is_some() || mv.d.is_some() {
            return Err("bad-move");
        }
        let mut out = st.clone();
        for &(t, pos) in p {
            out.grid[pos as usize] = who * t;
        }
        out.phase += 1;
        out.turn += 1;
        return Ok((out, None));
    }
    if mv.p.is_some() {
        return Err("bad-move");
    }
    let mut turn = Turn::new(ctx, st, who);
    let ok = |x: (u16, u16)| (x.0 as usize) < N && (x.1 as usize) < N;
    if turn.need_retreat {
        match mv.r {
            Some(r) if ok(r) && r.0 as i16 == st.retreat => turn.do_move(r.0 as usize, r.1 as usize)?,
            _ => return Err("retreat-first"),
        }
    } else if mv.r.is_some() {
        return Err("no-retreat-due");
    }
    for &step in &mv.m {
        if !ok(step) {
            return Err("bad-move");
        }
        turn.do_move(step.0 as usize, step.1 as usize)?;
    }
    if let Some(target) = mv.a {
        turn.attack(target as usize)?;
    }
    if mv.d != turn.d {
        return Err("bad-arsenal-flag");
    }
    turn.finish()?;
    Ok((turn.st, turn.result))
}

/// pourquoi ce camp a perdu, s'il a perdu
pub fn loss_reason(ctx: &Ctx, st: &State, side: i8) -> Option<&'static str> {
    if !(0..4).any(|i| ctx.ars_side[i] == side && st.ars[i]) {
        return Some("arsenals");
    }
    let (mut combat, mut signals) = (0, 0);
    for &v in st.grid.iter() {
        if v != 0 && (v > 0) == (side > 0) {
            if v.abs() < SIGNAL { combat += 1 } else { signals += 1 }
        }
    }
    if combat == 0 {
        return Some("annihilated");
    }
    if ctx.isolation_victory && signals == 0 && communications(ctx, st, side).count == 0 {
        return Some("isolated");
    }
    None
}

/// Issue apres le coup de `mover` : (0 en cours | 1 | -1 | 2 nulle, raison).
pub fn outcome(ctx: &Ctx, st: &State, mover: i8) -> (i8, Option<&'static str>) {
    if st.phase < 2 {
        return (0, None);
    }
    if let Some(reason) = loss_reason(ctx, st, -mover) {
        return (mover, Some(reason));
    }
    if let Some(reason) = loss_reason(ctx, st, mover) {
        return (-mover, Some(reason));
    }
    if ctx.max_turns > 0 && st.turn >= ctx.max_turns {
        return (2, Some("max-turns"));
    }
    (0, None)
}
