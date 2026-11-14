//! Le contexte d'un scénario, compilé par jocly2 (`PeanRules.exportContext`)
//! et reçu en JSON : le moteur n'interprète jamais les fichiers de scénario.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Terrain {
    pub name: String,
    /// coût d'entrée en demi-points (pied, monté) ; None : infranchissable
    pub cost: Option<[i32; 2]>,
    pub def: f64,
    pub no_charge: bool,
    pub disorder: bool,
    pub blocks_fire: bool,
    pub road: bool,
    pub height: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    pub name: String,
    pub cost: i32,
    pub attack: f64,
    pub cuts_zoc: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UnitType {
    pub key: String,
    pub force: f64,
    /// potentiel de mouvement, en demi-points
    pub mp: i32,
    pub steps: i32,
    pub value: f64,
    pub phalanx: bool,
    pub light: bool,
    pub fire: bool,
    pub mounted: bool,
    pub disengage: bool,
    pub charge: bool,
    pub general: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Objective {
    pub hex: i32,
    pub points: f64,
    pub owner: i8,
    pub only: i8,
    pub immediate: bool,
    pub hold: i32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Options {
    pub orientation: bool,
    pub profondeur: bool,
    pub charge: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CombatResult {
    Neant,
    Echange,
    Recul,
    PerteRecul,
    Elimination,
}

impl CombatResult {
    pub fn name(self) -> &'static str {
        match self {
            CombatResult::Neant => "neant",
            CombatResult::Echange => "echange",
            CombatResult::Recul => "recul",
            CombatResult::PerteRecul => "perte-recul",
            CombatResult::Elimination => "elimination",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Column {
    pub num: f64,
    pub den: f64,
    pub result: CombatResult,
}

/// Le contexte tel qu'il arrive de jocly2.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Export {
    pub cols: i32,
    pub rows: i32,
    pub terr: Vec<usize>,
    pub terrains: Vec<Terrain>,
    pub sides: Vec<Side>,
    pub edge: Vec<u8>,
    pub types: Vec<UnitType>,
    pub home: [String; 2],
    pub objectives: Vec<Objective>,
    pub orders: [i32; 2],
    pub options: Options,
    pub table: Vec<Column>,
    pub rupture: f64,
    pub nulle: f64,
    pub tours: i32,
    pub charge_min: usize,
    pub flank: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    South,
    North,
    East,
    West,
}

/// Le contexte prêt à servir : l'export, plus la géométrie précalculée.
#[derive(Debug, Clone)]
pub struct Ctx {
    pub x: Export,
    pub n: usize,
    pub aq: Vec<i32>,
    pub ar: Vec<i32>,
    /// voisins : nb[h * 6 + d], -1 hors carte ; d = N, NE, SE, S, SO, NO
    pub nb: Vec<i32>,
    /// bord de chaque camp : [camp 1, camp -1]
    pub home: [Edge; 2],
    /// objectif + 1 par hexagone (0 : aucun)
    pub obj_at: Vec<usize>,
}

pub const DQ: [i32; 6] = [0, 1, 1, 0, -1, -1];
pub const DR: [i32; 6] = [-1, -1, 0, 1, 1, 0];

impl Ctx {
    pub fn from_json(text: &str) -> Result<Ctx, String> {
        let x: Export = serde_json::from_str(text).map_err(|e| format!("contexte illisible : {e}"))?;
        Ctx::new(x)
    }

    pub fn from_value(v: &serde_json::Value) -> Result<Ctx, String> {
        let x: Export = serde_json::from_value(v.clone()).map_err(|e| format!("contexte illisible : {e}"))?;
        Ctx::new(x)
    }

    pub fn new(x: Export) -> Result<Ctx, String> {
        let n = (x.cols * x.rows) as usize;
        if x.cols < 4 || x.rows < 4 || x.terr.len() != n || x.edge.len() != n * 6 || x.table.is_empty() {
            return Err("contexte incoherent".into());
        }
        let mut aq = vec![0; n];
        let mut ar = vec![0; n];
        for h in 0..n {
            let c = h as i32 % x.cols;
            let r = h as i32 / x.cols;
            aq[h] = c;
            ar[h] = r - ((c - (c & 1)) >> 1);
        }
        let mut ctx = Ctx { n, aq, ar, nb: vec![-1; n * 6], home: [Edge::South, Edge::North], obj_at: vec![0; n], x };
        for h in 0..n {
            for d in 0..6 {
                ctx.nb[h * 6 + d] = ctx.hex_at(ctx.aq[h] + DQ[d], ctx.ar[h] + DR[d]);
            }
        }
        for (k, name) in ctx.x.home.iter().enumerate() {
            ctx.home[k] = match name.as_str() {
                "sud" => Edge::South,
                "nord" => Edge::North,
                "est" => Edge::East,
                "ouest" => Edge::West,
                other => return Err(format!("bord inconnu : {other}")),
            };
        }
        for (i, o) in ctx.x.objectives.iter().enumerate() {
            if o.hex < 0 || o.hex as usize >= n {
                return Err("objectif hors carte".into());
            }
            ctx.obj_at[o.hex as usize] = i + 1;
        }
        Ok(ctx)
    }

    pub fn hex_at(&self, q: i32, r: i32) -> i32 {
        let c = q;
        if c < 0 || c >= self.x.cols {
            return -1;
        }
        let row = r + ((c - (c & 1)) >> 1);
        if row < 0 || row >= self.x.rows {
            return -1;
        }
        row * self.x.cols + c
    }

    #[inline]
    pub fn nb(&self, h: i32, d: usize) -> i32 {
        self.nb[h as usize * 6 + d]
    }

    #[inline]
    pub fn distance(&self, a: i32, b: i32) -> i32 {
        let dq = self.aq[a as usize] - self.aq[b as usize];
        let dr = self.ar[a as usize] - self.ar[b as usize];
        (dq.abs() + dr.abs() + (dq + dr).abs()) / 2
    }

    /// direction de a vers b, voisins ; -1 sinon (ou hors carte)
    pub fn dir_between(&self, a: i32, b: i32) -> i32 {
        if a < 0 || a as usize >= self.n {
            return -1;
        }
        for d in 0..6 {
            if self.nb(a, d) == b {
                return d as i32;
            }
        }
        -1
    }

    #[inline]
    pub fn terrain(&self, h: i32) -> &Terrain {
        &self.x.terrains[self.x.terr[h as usize]]
    }

    /// côté d'hexagone (indice + 1, 0 : aucun)
    #[inline]
    pub fn edge(&self, h: i32, d: usize) -> u8 {
        self.x.edge[h as usize * 6 + d]
    }

    #[inline]
    pub fn side_index(side: i8) -> usize {
        if side == 1 {
            0
        } else {
            1
        }
    }

    pub fn edge_distance(&self, side: i8, h: i32) -> i32 {
        let c = h % self.x.cols;
        let r = h / self.x.cols;
        match self.home[Ctx::side_index(side)] {
            Edge::South => self.x.rows - 1 - r,
            Edge::North => r,
            Edge::East => self.x.cols - 1 - c,
            Edge::West => c,
        }
    }

    pub fn type_index(&self, key: &str) -> Option<usize> {
        self.x.types.iter().position(|t| t.key == key)
    }
}
