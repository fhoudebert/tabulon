//! La recherche.
//!
//! Un tour compte jusqu'a 5 deplacements puis une attaque : une position
//! offre une centaine de sous-coups et de l'ordre de 10^7 tours distincts.
//! On ne les enumere donc pas. La recherche est a deux etages :
//!
//! 1. **Construction des tours par faisceau.** A partir de la position, on
//!    ajoute un deplacement a la fois ; a chaque etage on evalue tous les
//!    etats obtenus (meilleure attaque comprise) et on ne garde que les
//!    `beam` meilleurs pour l'etage suivant. Les etats atteints par deux
//!    ordres differents des memes deplacements sont confondus par leur cle de
//!    Zobrist. Tous les etats rencontres sont des tours candidats, puisqu'un
//!    tour peut s'arreter apres n'importe quel nombre de deplacements.
//! 2. **Alpha-beta sur les tours**, en approfondissement iteratif : a chaque
//!    noeud, les `keep` meilleurs tours du faisceau, du plus prometteur au
//!    moins prometteur.
//!
//! Avec un reseau de valeur (`Ctx::net`, voir nn.rs), le faisceau construit
//! toujours les tours avec l'evaluation ponderee, qui est rapide, mais les
//! feuilles sont jugees par le reseau : il remplace la reponse adverse que la
//! recherche construisait a chaque feuille. Le reseau ne sert donc qu'aux
//! positions de fin de tour, quelques dizaines a quelques centaines par coup.
//!
//! Limites connues de cette premiere version : pas de table de transposition
//! entre les noeuds, pas de detection des repetitions (c'est Jocly qui
//! arbitre la nulle), pas de placement (Jocly le tire de ses gabarits).

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::eval::{evaluate_units, VALUE, WIN};
use crate::nn::Scratch;
use crate::rules::*;

/// Echelle des valeurs du reseau ([-1, 1]) dans les unites de la recherche :
/// assez grande pour que l'arrondi a l'entier ne confonde pas deux positions,
/// tres en dessous de WIN / 2, ou commencent les fins de partie.
pub const NET_SCALE: f32 = 20_000.0;

/// Budget d'une recherche.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// temps maximal, en millisecondes
    pub movetime_ms: u64,
    /// profondeur maximale, en tours (1 = mon tour, 2 = + la reponse...)
    pub max_depth: u32,
    /// largeur du faisceau et nombre de tours gardes, a la racine
    pub root_beam: usize,
    pub root_keep: usize,
    /// idem aux noeuds interieurs
    pub inner_beam: usize,
    pub inner_keep: usize,
    /// largeur du faisceau aux feuilles (on n'y garde que le meilleur tour)
    pub leaf_beam: usize,
    /// nombre de deplacements explores aux feuilles : la reponse la plus
    /// courante a une menace tient en un renfort ou deux, et un faisceau
    /// complet a chaque feuille coute l'essentiel du temps de recherche
    pub leaf_moves: u8,
    /// ajouter aux tours du faisceau des tours construits selon un plan
    /// (avance en ordre, mise a l'abri des transmissions, retour sur une
    /// ligne directe) : voir `plans`
    pub plans: bool,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            movetime_ms: 2000,
            max_depth: 6,
            root_beam: 16,
            root_keep: 16,
            inner_beam: 6,
            inner_keep: 6,
            leaf_beam: 3,
            leaf_moves: 2,
            // mesures au banc : aucun effet (50,0 % sur 200 parties) ; les
            // plans restent disponibles pour les essais, pas en service
            plans: false,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SearchResult {
    pub best: Move,
    /// score du point de vue du camp au trait, en centiemes de point
    pub score: i32,
    /// derniere profondeur terminee
    pub depth: u32,
    /// etats evalues
    pub nodes: u64,
    pub time_ms: u64,
}

/// Cles de Zobrist : une par (case, contenu).
struct Zobrist {
    keys: Vec<u64>,
}

impl Zobrist {
    fn new() -> Zobrist {
        // xorshift64*, graine fixe : les cles n'ont pas a etre secretes
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut keys = Vec::with_capacity(N * 13);
        for _ in 0..N * 13 {
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            keys.push(x.wrapping_mul(0x2545_F491_4F6C_DD1D));
        }
        Zobrist { keys }
    }
    #[inline]
    fn key(&self, pos: usize, v: i8) -> u64 {
        self.keys[pos * 13 + (v + 6) as usize]
    }
}

/// Un etat du faisceau : la position apres quelques deplacements du tour.
#[derive(Clone)]
struct Node {
    st: State,
    hash: u64,
    n: u8,
    moved: [u64; 8],
    r: Option<(u16, u16)>,
    m: [(u16, u16); 5],
    m_len: u8,
    d: Option<u16>,
    excluded: i16,
    /// meilleure attaque a lancer depuis cet etat, et son issue
    attack: Option<(u16, Outcome)>,
    /// evaluation apres cette attaque, du point de vue du camp qui joue
    score: i32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Plan {
    Escort,
    AdvanceFront,
    AdvanceRear,
    Anchor,
}

const PLANS: [Plan; 4] = [Plan::Escort, Plan::AdvanceFront, Plan::AdvanceRear, Plan::Anchor];

/// Un tour candidat : le coup, la position qui en resulte, son evaluation.
#[derive(Clone)]
pub struct Candidate {
    pub mv: Move,
    pub st: State,
    pub score: i32,
}

pub struct Searcher<'a> {
    ctx: &'a Ctx,
    zobrist: Zobrist,
    pub nodes: u64,
    deadline: Option<Instant>,
    stop: Option<&'a AtomicBool>,
    aborted: bool,
    /// tours construits selon un plan, en plus du faisceau
    pub plans: bool,
    /// memoire de travail du reseau, s'il y en a un
    scratch: Option<Scratch>,
    /// positions jugees par le reseau
    pub net_evals: u64,
}

impl<'a> Searcher<'a> {
    pub fn new(ctx: &'a Ctx) -> Searcher<'a> {
        let scratch = ctx.net.as_ref().map(|net| net.scratch());
        Searcher { ctx, zobrist: Zobrist::new(), nodes: 0, deadline: None, stop: None, aborted: false, plans: false, scratch, net_evals: 0 }
    }

    /// drapeau d'arret externe (commande `stop`)
    pub fn with_stop(mut self, stop: &'a AtomicBool) -> Searcher<'a> {
        self.stop = Some(stop);
        self
    }

    fn out_of_time(&mut self) -> bool {
        if self.aborted {
            return true;
        }
        if let Some(deadline) = self.deadline {
            if Instant::now() >= deadline {
                self.aborted = true;
            }
        }
        if let Some(stop) = self.stop {
            if stop.load(Ordering::Relaxed) {
                self.aborted = true;
            }
        }
        self.aborted
    }

    /// Valeur de `st` pour `who`, au trait, selon le reseau, dans les unites
    /// de la recherche ; None sans reseau.
    pub fn net_value(&mut self, st: &State, who: i8) -> Option<i32> {
        let net = self.ctx.net.as_ref()?;
        let scratch = self.scratch.as_mut()?;
        self.nodes += 1;
        self.net_evals += 1;
        Some((net.value(self.ctx, st, who, scratch) * NET_SCALE).round() as i32)
    }

    fn hash_of(&self, st: &State) -> u64 {
        let mut h = 0;
        for pos in 0..N {
            if st.grid[pos] != 0 {
                h ^= self.zobrist.key(pos, st.grid[pos]);
            }
        }
        h
    }

    /// Choisit la meilleure attaque de l'etat et l'evalue.
    fn score_node(&mut self, node: &mut Node, who: i8) {
        let ctx = self.ctx;
        self.nodes += 1;
        let units = Units::scan(&node.st);
        let ca = communications_of(ctx, &node.st, who, &units);
        let cd = communications_of(ctx, &node.st, -who, &units);
        let (cn, cs) = if who > 0 { (&ca, &cd) } else { (&cd, &ca) };
        // sans attaque ; le compteur de coups n'est avance que le temps de l'evaluation
        node.st.turn += 1;
        let quiet = evaluate_units(ctx, &node.st, -who, cn, cs, &units);
        node.st.turn -= 1;
        node.attack = None;
        node.score = quiet.score * who as i32;
        if node.d.is_some() {
            return; // la destruction d'un arsenal tient lieu d'attaque
        }
        for target in units.iter() {
            let v = node.st.grid[target];
            if v == 0 || (v > 0) == (who > 0) {
                continue;
            }
            let (att, def) = strength(ctx, &node.st, target, who, &ca, &cd, node.excluded);
            if att <= def {
                continue;
            }
            let outcome = outcome_of(ctx, &node.st, target, att - def, &cd);
            let mut st = node.st.clone();
            st.turn += 1;
            match outcome {
                Outcome::Destroy => st.grid[target] = 0,
                Outcome::Retreat => st.retreat = target as i16,
            }
            self.nodes += 1;
            let score = match outcome {
                // une destruction change les communications de la cible
                Outcome::Destroy => {
                    let units2 = Units::scan(&st);
                    let ca2 = communications_of(ctx, &st, who, &units2);
                    let cd2 = communications_of(ctx, &st, -who, &units2);
                    let (cn2, cs2) = if who > 0 { (&ca2, &cd2) } else { (&cd2, &ca2) };
                    evaluate_units(ctx, &st, -who, cn2, cs2, &units2).score
                }
                Outcome::Retreat => evaluate_units(ctx, &st, -who, cn, cs, &units).score,
            } * who as i32;
            // a evaluation egale, on attaque : un petit bonus departage
            let score = score + VALUE[v.unsigned_abs() as usize] / 10;
            if score > node.score {
                node.score = score;
                node.attack = Some((target as u16, outcome));
            }
        }
    }

    fn finish(&self, node: &Node) -> Candidate {
        let mut st = node.st.clone();
        st.turn += 1;
        let mut mv = Move {
            p: None,
            r: node.r,
            m: node.m[..node.m_len as usize].to_vec(),
            a: None,
            d: node.d,
        };
        if let Some((target, outcome)) = node.attack {
            mv.a = Some(target);
            match outcome {
                Outcome::Destroy => st.grid[target as usize] = 0,
                Outcome::Retreat => st.retreat = target as i16,
            }
        }
        Candidate { mv, st, score: node.score }
    }

    /// Les `keep` meilleurs tours de `who` dans la position `st`, du meilleur
    /// au moins bon, construits par un faisceau de largeur `beam`.
    pub fn generate(&mut self, st: &State, who: i8, beam: usize, keep: usize) -> Vec<Candidate> {
        self.generate_limited(st, who, beam, keep, MAX_MOVES)
    }

    /// comme [`generate`], en s'arretant apres `max_moves` deplacements
    pub fn generate_limited(&mut self, st: &State, who: i8, beam: usize, keep: usize, max_moves: u8) -> Vec<Candidate> {
        let ctx = self.ctx;
        let mut root = Node {
            st: st.clone(),
            hash: self.hash_of(st),
            n: 0,
            moved: [0; 8],
            r: None,
            m: [(0, 0); 5],
            m_len: 0,
            d: None,
            excluded: -1,
            attack: None,
            score: 0,
        };
        let need_retreat = st.retreat >= 0 && side_of(st.grid[st.retreat as usize]) == who;
        if !need_retreat {
            root.st.retreat = -1;
        }
        let mut pool: Vec<Node> = Vec::new();
        if !need_retreat {
            self.score_node(&mut root, who);
            pool.push(root.clone());
        }
        let mut level = vec![root];
        let mut dests: Vec<u16> = Vec::with_capacity(24);
        let mut seen: HashSet<u64> = HashSet::new();
        // une retraite due est toujours exploree, meme si max_moves vaut 0
        for depth in 0..max_moves.clamp(if need_retreat { 1 } else { 0 }, MAX_MOVES) {
            let mut children: Vec<Node> = Vec::new();
            seen.clear();
            for node in &level {
                let units = Units::scan(&node.st);
                let comm = communications_of(ctx, &node.st, who, &units);
                let retreating = depth == 0 && need_retreat;
                for from in units.iter() {
                    let v = node.st.grid[from];
                    if v == 0 || (v > 0) != (who > 0) {
                        continue;
                    }
                    if retreating && from as i16 != st.retreat {
                        continue;
                    }
                    if node.moved[from >> 6] & (1 << (from & 63)) != 0 {
                        continue;
                    }
                    let combat = v.abs() < SIGNAL;
                    if combat && !comm.on[from] {
                        continue;
                    }
                    reach(ctx, &node.st, from, &mut dests);
                    for &to in &dests {
                        let to = to as usize;
                        let arsenal = if combat { ctx.enemy_arsenal_at(&node.st, to, who) } else { None };
                        if arsenal.is_some() && node.d.is_some() {
                            continue; // pas deux destructions dans le meme tour
                        }
                        let hash = node.hash ^ self.zobrist.key(from, v) ^ self.zobrist.key(to, v)
                            ^ if arsenal.is_some() { 0x5bd1_e995_u64.rotate_left(to as u32) } else { 0 };
                        if !seen.insert(hash) {
                            continue; // meme etat, autre ordre des deplacements
                        }
                        let mut child = node.clone();
                        child.hash = hash;
                        child.st.grid[from] = 0;
                        child.st.grid[to] = v;
                        if let Some(i) = arsenal {
                            child.st.ars[i] = false;
                            child.d = Some(to as u16);
                        }
                        child.moved[to >> 6] |= 1 << (to & 63);
                        child.n += 1;
                        if retreating {
                            child.r = Some((from as u16, to as u16));
                            child.excluded = to as i16;
                            child.st.retreat = -1;
                        } else {
                            child.m[child.m_len as usize] = (from as u16, to as u16);
                            child.m_len += 1;
                        }
                        self.score_node(&mut child, who);
                        children.push(child);
                    }
                }
                if self.out_of_time() {
                    break;
                }
            }
            if children.is_empty() {
                break;
            }
            children.sort_by(|a, b| b.score.cmp(&a.score));
            children.truncate(beam.max(1));
            pool.extend(children.iter().cloned());
            level = children;
            if self.aborted {
                break;
            }
        }
        if self.plans && max_moves == MAX_MOVES && !self.aborted {
            // les plans partent de la position du tour, ou de la meilleure
            // retraite quand une retraite est due
            let base = if need_retreat { pool.iter().filter(|n| n.n == 1).max_by_key(|n| n.score).cloned() } else { pool.first().cloned() };
            if let Some(base) = base {
                for plan in PLANS {
                    if let Some(mut node) = self.plan(&base, who, plan) {
                        self.score_node(&mut node, who);
                        pool.push(node);
                    }
                }
            }
        }
        if pool.is_empty() {
            // retraite due mais impossible : ne devrait pas arriver, les regles
            // detruisent l'unite des l'attaque ; on rend le tour vide
            let mut node = level.into_iter().next().unwrap();
            self.score_node(&mut node, who);
            pool.push(node);
        }
        pool.sort_by(|a, b| b.score.cmp(&a.score));
        // deux tours qui menent a la meme position : on garde le premier
        let mut out: Vec<Candidate> = Vec::with_capacity(keep);
        let mut finals: HashSet<(u64, Option<u16>)> = HashSet::new();
        for node in &pool {
            if finals.insert((node.hash, node.attack.map(|a| a.0))) {
                out.push(self.finish(node));
                if out.len() >= keep.max(1) {
                    break;
                }
            }
        }
        out
    }

    /// Applique un deplacement deja reconnu legal a un etat du faisceau.
    fn step(&self, node: &mut Node, from: usize, to: usize, who: i8) {
        let v = node.st.grid[from];
        node.hash ^= self.zobrist.key(from, v) ^ self.zobrist.key(to, v);
        node.st.grid[from] = 0;
        node.st.grid[to] = v;
        if v.abs() < SIGNAL {
            if let Some(i) = self.ctx.enemy_arsenal_at(&node.st, to, who) {
                node.st.ars[i] = false;
                node.d = Some(to as u16);
                node.hash ^= 0x5bd1_e995_u64.rotate_left(to as u32);
            }
        }
        node.moved[to >> 6] |= 1 << (to & 63);
        node.n += 1;
        node.m[node.m_len as usize] = (from as u16, to as u16);
        node.m_len += 1;
    }

    /// Un tour construit selon un plan, a partir de `base`. None si le plan
    /// ne trouve rien a faire.
    ///
    /// Le faisceau choisit chaque deplacement pour ce qu'il rapporte tout de
    /// suite a l'evaluation ; il ne tient pas une intention sur cinq
    /// deplacements. Ces plans en proposent trois, que l'evaluation juge
    /// ensuite comme n'importe quel autre tour.
    fn plan(&mut self, base: &Node, who: i8, plan: Plan) -> Option<Node> {
        let ctx = self.ctx;
        let mut node = base.clone();
        let mut dests: Vec<u16> = Vec::with_capacity(24);
        let enemy_dist = |st: &State, pos: usize| -> usize {
            let mut best = 99;
            for q in 0..N {
                let v = st.grid[q];
                if v != 0 && (v > 0) != (who > 0) && v.abs() < SIGNAL {
                    best = best.min(distance(pos, q));
                }
            }
            best
        };
        let arsenal_dist = |st: &State, pos: usize| -> u16 {
            let mut best = 999;
            for i in 0..4 {
                if ctx.ars_side[i] != who && st.ars[i] {
                    best = best.min(ctx.ars_dist[i][pos]);
                }
            }
            best
        };
        // resterait en communication : sur une ligne, ou au contact d'une
        // autre unite combattante qui l'est
        let connected = |st: &State, comm: &Comm, from: usize, dest: usize, combat: bool| -> bool {
            if comm.lit[dest] {
                return true;
            }
            if !combat {
                return false;
            }
            (0..8).any(|d| {
                let q = ctx.next[dest * 8 + d];
                q >= 0 && q as usize != from && comm.on[q as usize] && st.grid[q as usize].abs() < SIGNAL
            })
        };
        let moved = |node: &Node, pos: usize| node.moved[pos >> 6] & (1 << (pos & 63)) != 0;

        match plan {
            // les transmissions menacees se mettent a l'abri, sans quitter les lignes
            Plan::Escort => {
                for from in Units::scan(&base.st).iter() {
                    let v = node.st.grid[from];
                    if v == 0 || (v > 0) != (who > 0) || v.abs() < SIGNAL || moved(&node, from) || node.n >= MAX_MOVES {
                        continue;
                    }
                    let here = enemy_dist(&node.st, from);
                    if here > 4 {
                        continue;
                    }
                    let comm = communications_of(ctx, &node.st, who, &Units::scan(&node.st));
                    reach(ctx, &node.st, from, &mut dests);
                    let mut best: Option<(usize, usize)> = None;
                    for &to in &dests {
                        let to = to as usize;
                        if !comm.lit[to] {
                            continue;
                        }
                        let far = enemy_dist(&node.st, to);
                        if far > here && best.map_or(true, |b| far > b.1) {
                            best = Some((to, far));
                        }
                    }
                    if let Some((to, _)) = best {
                        self.step(&mut node, from, to, who);
                    }
                }
            }
            // avance vers l'arsenal adverse, les unites de tete (ou de queue)
            // d'abord, chacune restant en communication
            Plan::AdvanceFront | Plan::AdvanceRear => {
                let mut order: Vec<usize> = Units::scan(&base.st)
                    .iter()
                    .filter(|&p| (node.st.grid[p] > 0) == (who > 0) && node.st.grid[p].abs() < SIGNAL)
                    .collect();
                order.sort_by_key(|&p| arsenal_dist(&node.st, p));
                if plan == Plan::AdvanceRear {
                    order.reverse();
                }
                for from in order {
                    if node.n >= MAX_MOVES {
                        break;
                    }
                    if moved(&node, from) || node.st.grid[from] == 0 {
                        continue;
                    }
                    let comm = communications_of(ctx, &node.st, who, &Units::scan(&node.st));
                    if !comm.on[from] {
                        continue;
                    }
                    reach(ctx, &node.st, from, &mut dests);
                    let mut best: Option<(usize, u16)> = None;
                    let current = arsenal_dist(&node.st, from);
                    for &to in &dests {
                        let to = to as usize;
                        if node.d.is_some() && ctx.enemy_arsenal_at(&node.st, to, who).is_some() {
                            continue;
                        }
                        let dist = arsenal_dist(&node.st, to);
                        if dist < current && best.map_or(true, |b| dist < b.1) && connected(&node.st, &comm, from, to, true) {
                            best = Some((to, dist));
                        }
                    }
                    if let Some((to, _)) = best {
                        self.step(&mut node, from, to, who);
                    }
                }
            }
            // les unites qui ne tiennent que par les transmissions reviennent
            // vers une ligne directe d'arsenal, les plus proches d'abord
            Plan::Anchor => {
                let units = Units::scan(&node.st);
                let direct = communications_relay(ctx, &node.st, who, &units, false);
                let lines: Vec<usize> = (0..N).filter(|&p| direct.lit[p] && ctx.terr[p] != MOUNTAIN).collect();
                if lines.is_empty() {
                    return None;
                }
                let to_line = |pos: usize| lines.iter().map(|&l| distance(pos, l)).min().unwrap_or(99);
                let mut order: Vec<(usize, usize)> = units
                    .iter()
                    .filter(|&p| (node.st.grid[p] > 0) == (who > 0) && node.st.grid[p].abs() < SIGNAL && !direct.on[p])
                    .map(|p| (to_line(p), p))
                    .collect();
                order.sort();
                for (current, from) in order {
                    if node.n >= MAX_MOVES {
                        break;
                    }
                    if moved(&node, from) {
                        continue;
                    }
                    let comm = communications_of(ctx, &node.st, who, &Units::scan(&node.st));
                    if !comm.on[from] {
                        continue;
                    }
                    reach(ctx, &node.st, from, &mut dests);
                    let mut best: Option<(usize, usize)> = None;
                    for &to in &dests {
                        let to = to as usize;
                        if ctx.enemy_arsenal_at(&node.st, to, who).is_some() {
                            continue;
                        }
                        let dist = to_line(to);
                        if dist < current && best.map_or(true, |b| dist < b.1) && connected(&node.st, &comm, from, to, true) {
                            best = Some((to, dist));
                        }
                    }
                    if let Some((to, _)) = best {
                        self.step(&mut node, from, to, who);
                    }
                }
            }
        }
        if node.n == base.n { None } else { Some(node) }
    }

    /// valeur de `st` pour `who`, qui est au trait, a `depth` tours
    fn negamax(&mut self, st: &State, who: i8, depth: u32, mut alpha: i32, beta: i32, ply: i32, limits: &Limits) -> i32 {
        if depth <= 1 && self.ctx.net.is_some() {
            // feuille jugee par le reseau, au lieu de la reponse construite
            if self.out_of_time() {
                return 0;
            }
            return self.net_value(st, who).unwrap();
        }
        let cands = if depth <= 1 {
            self.generate_limited(st, who, limits.leaf_beam, 1, limits.leaf_moves)
        } else {
            self.generate(st, who, limits.inner_beam, limits.inner_keep)
        };
        if self.aborted {
            return 0;
        }
        if depth <= 1 {
            return terminal_adjust(cands[0].score, ply);
        }
        let mut best = -WIN * 2;
        for cand in &cands {
            let value = if cand.score.abs() >= WIN {
                terminal_adjust(cand.score, ply)
            } else if self.ctx.max_turns > 0 && cand.st.turn >= self.ctx.max_turns {
                0
            } else {
                -self.negamax(&cand.st, -who, depth - 1, -beta, -alpha, ply + 1, limits)
            };
            if self.aborted {
                return 0;
            }
            best = best.max(value);
            alpha = alpha.max(value);
            if alpha >= beta {
                break;
            }
        }
        best
    }

    /// Cherche le meilleur tour de `who` dans `st` (phase de jeu).
    pub fn search(&mut self, st: &State, who: i8, limits: &Limits) -> SearchResult {
        let started = Instant::now();
        self.nodes = 0;
        self.net_evals = 0;
        self.aborted = false;
        self.plans = limits.plans;
        self.deadline = None; // la profondeur 1 va toujours au bout : il faut un coup
        let mut roots = self.generate(st, who, limits.root_beam, limits.root_keep);
        let mut result = SearchResult {
            best: roots[0].mv.clone(),
            score: roots[0].score,
            depth: 1,
            nodes: self.nodes,
            time_ms: 0,
        };
        self.deadline = Some(started + Duration::from_millis(limits.movetime_ms));
        let mut depth = 2;
        while depth <= limits.max_depth && roots.len() > 1 && result.score.abs() < WIN / 2 {
            let mut alpha = -WIN * 2;
            let mut scored: Vec<(i32, usize)> = Vec::with_capacity(roots.len());
            for (index, cand) in roots.iter().enumerate() {
                let value = if cand.score.abs() >= WIN {
                    terminal_adjust(cand.score, 0)
                } else if self.ctx.max_turns > 0 && cand.st.turn >= self.ctx.max_turns {
                    0
                } else {
                    -self.negamax(&cand.st.clone(), -who, depth - 1, -WIN * 2, -alpha, 1, limits)
                };
                if self.aborted {
                    break;
                }
                scored.push((value, index));
                alpha = alpha.max(value);
            }
            if self.aborted {
                // iteration interrompue : on ne retient un coup de cette
                // profondeur que s'il bat le meilleur de la precedente, qui a
                // ete cherche en premier
                if let Some(&(value, index)) = scored.iter().max_by_key(|s| s.0) {
                    if index != 0 && scored.iter().any(|s| s.1 == 0) {
                        result.best = roots[index].mv.clone();
                        result.score = value;
                    }
                }
                break;
            }
            // le meilleur d'abord pour l'iteration suivante ; tri stable
            scored.sort_by(|a, b| b.0.cmp(&a.0));
            let reordered: Vec<Candidate> = scored.iter().map(|&(_, i)| roots[i].clone()).collect();
            roots = reordered;
            result.best = roots[0].mv.clone();
            result.score = scored[0].0;
            result.depth = depth;
            depth += 1;
        }
        result.nodes = self.nodes;
        result.time_ms = started.elapsed().as_millis() as u64;
        result
    }
}

/// une victoire proche vaut mieux qu'une victoire lointaine
fn terminal_adjust(score: i32, ply: i32) -> i32 {
    if score >= WIN {
        score - ply
    } else if score <= -WIN {
        score + ply
    } else {
        score
    }
}

/// Cherche le meilleur tour. Renvoie une erreur en phase de placement.
pub fn best_move(ctx: &Ctx, st: &State, who: i8, limits: &Limits, stop: Option<&AtomicBool>) -> Result<SearchResult, String> {
    if st.phase < 2 {
        return Err("phase de placement : le moteur ne place pas les unites".into());
    }
    let mut searcher = Searcher::new(ctx);
    if let Some(stop) = stop {
        searcher = searcher.with_stop(stop);
    }
    Ok(searcher.search(st, who, limits))
}
