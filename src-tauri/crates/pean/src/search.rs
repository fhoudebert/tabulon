//! La recherche du Strategos : alpha-bêta (négamax) à approfondissement
//! itératif sur des tours candidats.
//!
//! Un tour de Péan (N ordres puis des combats) a bien trop de variantes pour
//! être énuméré : chaque nœud reçoit les tours candidats des générateurs de
//! jocly2 (plans et variantes bruitées), plus nombreux à la racine. L'arbre
//! est gardé d'une itération à l'autre : on ne génère chaque nœud qu'une fois,
//! et les fils sont triés par le score de l'itération précédente.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::ai::{candidates, evaluate, Rng, WEIGHTS};
use crate::ctx::Ctx;
use crate::rules::{apply, outcome, to_move, Move, State};

pub const WIN: f64 = 10_000.0;

#[derive(Debug, Clone)]
pub struct Limits {
    pub time: Duration,
    /// largeur (tours candidats) par profondeur : racine, puis 1, 2, 3...
    pub widths: Vec<usize>,
    pub max_depth: usize,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits { time: Duration::from_millis(2500), widths: vec![40, 18, 12, 10, 8], max_depth: 6 }
    }
}

#[derive(Debug, Clone)]
pub struct Report {
    pub best: Move,
    /// du point de vue du camp au trait
    pub score: f64,
    pub depth: usize,
    pub nodes: usize,
    pub elapsed: Duration,
    pub root_moves: usize,
}

struct Node {
    st: State,
    who: i8,
    /// score statique, du point de vue de `who`
    stat: f64,
    /// fin de partie, du point de vue de `who`
    term: Option<f64>,
    children: Option<Vec<Child>>,
}

struct Child {
    mv: Move,
    node: Node,
    /// dernier score connu, du point de vue du père
    score: f64,
}

fn seed_of(st: &State) -> i32 {
    let mut h: u32 = 2166136261;
    let mut mix = |x: i32| {
        h ^= x as u32;
        h = h.wrapping_mul(16777619);
    };
    mix(st.played);
    for u in &st.u {
        mix(u.h);
        mix(u.p);
        mix(u.f);
    }
    (h & 0x7fffffff) as i32
}

impl Node {
    fn new(ctx: &Ctx, st: State, mover: i8, ply: usize) -> Node {
        let who = to_move(&st);
        let (w, _) = outcome(ctx, &st, mover);
        let term = match w {
            0 => None,
            2 => Some(0.0),
            // une victoire rapide vaut mieux qu'une lente
            w => Some(if w == who { WIN - ply as f64 } else { -WIN + ply as f64 }),
        };
        let stat = if term.is_some() { 0.0 } else { who as f64 * evaluate(ctx, &st, &WEIGHTS) };
        Node { st, who, stat, term, children: None }
    }
}

pub struct Search<'a> {
    ctx: &'a Ctx,
    limits: Limits,
    start: Instant,
    stop: Option<&'a AtomicBool>,
    pub nodes: usize,
    aborted: bool,
}

impl<'a> Search<'a> {
    fn out_of_time(&mut self) -> bool {
        if self.aborted {
            return true;
        }
        if self.start.elapsed() >= self.limits.time || self.stop.map_or(false, |s| s.load(Ordering::Relaxed)) {
            self.aborted = true;
        }
        self.aborted
    }

    fn width(&self, ply: usize) -> usize {
        *self.limits.widths.get(ply).unwrap_or_else(|| self.limits.widths.last().unwrap())
    }

    fn expand(&mut self, node: &mut Node, ply: usize) {
        if node.children.is_some() {
            return;
        }
        let ctx = self.ctx;
        let mut rng = Rng::new(seed_of(&node.st));
        let moves = candidates(ctx, &node.st, node.who, self.width(ply), &mut rng);
        let mut children = Vec::with_capacity(moves.len());
        for mv in moves {
            let Ok(st) = apply(ctx, &node.st, node.who, &mv) else { continue };
            let child = Node::new(ctx, st, node.who, ply + 1);
            self.nodes += 1;
            let score = -child.term.unwrap_or(child.stat);
            children.push(Child { mv, node: child, score });
        }
        children.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
        node.children = Some(children);
    }

    /// négamax ; None si le temps est écoulé
    fn negamax(&mut self, node: &mut Node, depth: usize, mut alpha: f64, beta: f64, ply: usize) -> Option<f64> {
        if let Some(t) = node.term {
            return Some(t);
        }
        if depth == 0 {
            return Some(node.stat);
        }
        if self.out_of_time() {
            return None;
        }
        self.expand(node, ply);
        let mut children = node.children.take().unwrap();
        if children.is_empty() {
            node.children = Some(children);
            return Some(node.stat);
        }
        let mut best = f64::NEG_INFINITY;
        let mut aborted = false;
        for c in children.iter_mut() {
            match self.negamax(&mut c.node, depth - 1, -beta, -alpha, ply + 1) {
                None => {
                    aborted = true;
                    break;
                }
                Some(v) => {
                    let v = -v;
                    c.score = v;
                    if v > best {
                        best = v;
                    }
                    if v > alpha {
                        alpha = v;
                    }
                    if alpha >= beta {
                        break;
                    }
                }
            }
        }
        // les fils non revus gardent leur score : ordre de la prochaine itération
        children.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
        node.children = Some(children);
        if aborted {
            None
        } else {
            Some(best)
        }
    }
}

/// Le meilleur tour pour le camp au trait.
pub fn search(ctx: &Ctx, st: &State, limits: Limits, stop: Option<&AtomicBool>) -> Option<Report> {
    let start = Instant::now();
    let mut s = Search { ctx, limits: limits.clone(), start, stop, nodes: 0, aborted: false };
    let mover = if st.played > 0 { -to_move(st) } else { to_move(st) };
    let mut root = Node::new(ctx, st.clone(), mover, 0);
    root.term = None;
    s.expand(&mut root, 0);
    let children = root.children.as_ref()?;
    if children.is_empty() {
        return None;
    }
    let mut best = children[0].mv.clone();
    let mut score = children[0].score;
    let mut depth = 1;
    for d in 2..=limits.max_depth {
        if s.out_of_time() {
            break;
        }
        // racine à la main : un tour complètement revu peut remplacer le meilleur
        let mut children = root.children.take().unwrap();
        let mut alpha = f64::NEG_INFINITY;
        let mut iter_best: Option<(usize, f64)> = None;
        for (i, c) in children.iter_mut().enumerate() {
            match s.negamax(&mut c.node, d - 1, f64::NEG_INFINITY, -alpha, 1) {
                None => break,
                Some(v) => {
                    let v = -v;
                    c.score = v;
                    if iter_best.map_or(true, |(_, b)| v > b) {
                        iter_best = Some((i, v));
                    }
                    if v > alpha {
                        alpha = v;
                    }
                }
            }
        }
        let complete = !s.aborted;
        // itération interrompue : seuls les tours revus en entier comptent, et
        // le premier (l'ancien meilleur) l'a été s'il y en a un
        if let Some((i, v)) = iter_best {
            best = children[i].mv.clone();
            score = v;
            if complete {
                depth = d;
            }
        }
        children.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
        root.children = Some(children);
        if !complete {
            break;
        }
        if score.abs() >= WIN - 100.0 {
            break;
        }
    }
    Some(Report { best, score, depth, nodes: s.nodes, elapsed: start.elapsed(), root_moves: root.children.as_ref().map_or(0, |c| c.len()) })
}
