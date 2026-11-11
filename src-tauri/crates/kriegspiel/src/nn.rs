//! Reseau de valeur : codage de la position et passe avant.
//!
//! Un petit reseau convolutif residuel lit la position sous forme de plans
//! 25 x 20 et rend une valeur dans [-1, 1], du point de vue du camp au trait.
//! Il est entraine hors du moteur (tools/train/, PyTorch) a partir des parties
//! d'auto-jeu ecrites par `kriegspiel-lab selfplay --planes`, puis exporte dans
//! le format binaire lu ici. Aucune dependance : la passe avant est ecrite a
//! la main, avec une version AVX2/FMA choisie a l'execution quand le processeur
//! la connait.
//!
//! ## Les plans d'entree ([`PLANES`] plans de 20 lignes sur 25 colonnes)
//!
//! | plans | contenu |
//! |---|---|
//! | 0-5   | unites du Nord : I, C, A, AC, T, E |
//! | 6-11  | unites du Sud, meme ordre |
//! | 12    | montagnes |
//! | 13    | cols |
//! | 14    | forteresses |
//! | 15    | cases d'arsenal (debout ou non) |
//! | 16-17 | arsenaux debout, Nord puis Sud |
//! | 18-19 | cases sur une ligne de communication, Nord puis Sud |
//! | 20-21 | unites en communication, Nord puis Sud |
//! | 22-23 | cases sur une ligne sans les transmissions (ce qui resterait si elles tombaient), Nord puis Sud |
//! | 24    | unite qui doit faire retraite |
//! | 25    | plan constant : 1 si le Nord est au trait |
//! | 26    | plan constant : avancement de la partie, coups joues / 300 (borne a 1) |
//!
//! Les plans 0 a 25 valent 0 ou 1 ; seul le 26 est fractionnaire. Les
//! communications sont donnees au reseau pour qu'il n'ait pas a reapprendre
//! la regle, et les lignes « sans transmissions » parce que la defaite par
//! isolement est le danger que le moteur voyait trop tard.
//!
//! ## Le fichier du reseau
//!
//! Petit-boutiste. En-tete : `KSNN`, puis sept `u32` : version (1), plans
//! d'entree, canaux, blocs residuels, canaux de la tete de valeur, neurones de
//! la couche cachee, et 0 (reserve). Puis les `f32`, couche par couche, la
//! normalisation par lots deja replie dans les poids et les biais :
//! - tronc : conv 3x3 (canaux x plans x 3 x 3), biais (canaux) ;
//! - chaque bloc : conv 3x3 + biais, conv 3x3 + biais ;
//! - tete : conv 1x1 (tete x canaux) + biais (tete), dense (cachee x tete*500)
//!   + biais (cachee), dense (1 x cachee) + biais (1).
//!
//! Le tout est relu en fin de fichier par une somme de controle : le nombre de
//! `f32` attendus doit etre exactement celui du fichier.

use crate::rules::*;

pub const PLANES: usize = 27;
/// plans binaires, ceux que `selfplay --planes` ecrit bit a bit
pub const BINARY_PLANES: usize = 26;
const ROWS: usize = H;
const COLS: usize = W;
// plans avec une bordure d'une case : la convolution 3x3 n'a pas a tester les bords
const PR: usize = ROWS + 2;
const PC: usize = COLS + 2;
const PN: usize = PR * PC;

/// Les plans d'entree de la position `st`, `who` au trait, dans l'ordre
/// documente en tete du module. `out` recoit PLANES * N valeurs.
pub fn encode(ctx: &Ctx, st: &State, who: i8, out: &mut [f32]) {
    assert!(out.len() >= PLANES * N);
    out[..PLANES * N].iter_mut().for_each(|v| *v = 0.0);
    let units = Units::scan(st);
    let comm = [communications_of(ctx, st, NORTH, &units), communications_of(ctx, st, SOUTH, &units)];
    let direct = [
        communications_relay(ctx, st, NORTH, &units, false),
        communications_relay(ctx, st, SOUTH, &units, false),
    ];
    let mut set = |plane: usize, pos: usize, v: f32| out[plane * N + pos] = v;
    for pos in units.iter() {
        let v = st.grid[pos];
        let t = v.unsigned_abs() as usize; // 1..6
        let side = if v > 0 { 0 } else { 1 };
        set(side * 6 + t - 1, pos, 1.0);
        if comm[side].on[pos] {
            set(20 + side, pos, 1.0);
        }
    }
    for pos in 0..N {
        match ctx.terr[pos] {
            MOUNTAIN => set(12, pos, 1.0),
            PASS => set(13, pos, 1.0),
            FORT => set(14, pos, 1.0),
            _ => {}
        }
        for side in 0..2 {
            if comm[side].lit[pos] {
                set(18 + side, pos, 1.0);
            }
            if direct[side].lit[pos] {
                set(22 + side, pos, 1.0);
            }
        }
    }
    for i in 0..4 {
        set(15, ctx.ars_pos[i], 1.0);
        if st.ars[i] {
            set(if ctx.ars_side[i] > 0 { 16 } else { 17 }, ctx.ars_pos[i], 1.0);
        }
    }
    if st.retreat >= 0 && st.grid[st.retreat as usize] != 0 {
        set(24, st.retreat as usize, 1.0);
    }
    let progress = (st.turn as f32 / 300.0).min(1.0);
    for pos in 0..N {
        if who > 0 {
            set(25, pos, 1.0);
        }
        set(26, pos, progress);
    }
}

/// Les plans binaires de `planes` (sortie de [`encode`]) tasses bit a bit,
/// plan par plan, case par case, bit de poids faible d'abord : BINARY_PLANES
/// * N / 8 octets. Le format d'echantillon de `selfplay --planes` s'en sert.
pub fn pack_binary(planes: &[f32], out: &mut Vec<u8>) {
    let bits = BINARY_PLANES * N;
    let start = out.len();
    out.resize(start + bits.div_ceil(8), 0);
    for i in 0..bits {
        if planes[i] != 0.0 {
            out[start + i / 8] |= 1 << (i % 8);
        }
    }
}

pub struct Net {
    pub planes: usize,
    pub channels: usize,
    pub blocks: usize,
    pub head: usize,
    pub hidden: usize,
    stem_w: Vec<f32>,
    stem_b: Vec<f32>,
    /// par bloc : (w1, b1, w2, b2)
    block: Vec<(Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>)>,
    head_w: Vec<f32>,
    head_b: Vec<f32>,
    fc1_w: Vec<f32>,
    fc1_b: Vec<f32>,
    fc2_w: Vec<f32>,
    fc2_b: f32,
}

/// Memoire de travail d'une passe avant, a garder d'un appel a l'autre.
pub struct Scratch {
    input: Vec<f32>,
    a: Vec<f32>,
    b: Vec<f32>,
    c: Vec<f32>,
    head: Vec<f32>,
    hidden: Vec<f32>,
}

impl Net {
    /// Un reseau aux poids tires au hasard (graine fixe) : pour les mesures de
    /// vitesse et les tests, jamais pour jouer.
    pub fn random(channels: usize, blocks: usize, head: usize, hidden: usize, seed: u64) -> Net {
        let mut x = seed | 1;
        let mut rnd = move |n: usize, scale: f32| -> Vec<f32> {
            (0..n)
                .map(|_| {
                    x ^= x >> 12;
                    x ^= x << 25;
                    x ^= x >> 27;
                    let u = (x.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 40) as f32 / (1u64 << 24) as f32;
                    (u * 2.0 - 1.0) * scale
                })
                .collect()
        };
        let conv_scale = |fan_in: usize| (2.0 / fan_in as f32).sqrt();
        Net {
            planes: PLANES,
            channels,
            blocks,
            head,
            hidden,
            stem_w: rnd(channels * PLANES * 9, conv_scale(PLANES * 9)),
            stem_b: rnd(channels, 0.01),
            block: (0..blocks)
                .map(|_| {
                    (
                        rnd(channels * channels * 9, conv_scale(channels * 9) * 0.5),
                        rnd(channels, 0.01),
                        rnd(channels * channels * 9, conv_scale(channels * 9) * 0.5),
                        rnd(channels, 0.01),
                    )
                })
                .collect(),
            head_w: rnd(head * channels, conv_scale(channels)),
            head_b: rnd(head, 0.01),
            fc1_w: rnd(hidden * head * N, conv_scale(head * N)),
            fc1_b: rnd(hidden, 0.01),
            fc2_w: rnd(hidden, conv_scale(hidden)),
            fc2_b: 0.0,
        }
    }

    /// Lit un reseau au format decrit en tete du module.
    pub fn parse(bytes: &[u8]) -> Result<Net, String> {
        if bytes.len() < 32 || &bytes[..4] != b"KSNN" {
            return Err("pas un fichier de reseau KSNN".into());
        }
        let word = |i: usize| u32::from_le_bytes(bytes[4 + i * 4..8 + i * 4].try_into().unwrap()) as usize;
        let (version, planes, channels, blocks, head, hidden) = (word(0), word(1), word(2), word(3), word(4), word(5));
        if version != 1 {
            return Err(format!("version de reseau {version} inconnue (attendu : 1)"));
        }
        if planes != PLANES {
            return Err(format!("le reseau lit {planes} plans, le moteur en fournit {PLANES}"));
        }
        if channels == 0 || channels > 512 || blocks > 64 || head == 0 || head > 64 || hidden == 0 || hidden > 4096 {
            return Err("dimensions de reseau invraisemblables".into());
        }
        let floats = &bytes[32..];
        if floats.len() % 4 != 0 {
            return Err("taille de fichier incorrecte".into());
        }
        let mut values = floats.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap()));
        let expected = channels * planes * 9 + channels
            + blocks * 2 * (channels * channels * 9 + channels)
            + head * channels + head
            + hidden * head * N + hidden
            + hidden + 1;
        if floats.len() / 4 != expected {
            return Err(format!("{} valeurs dans le fichier, {expected} attendues", floats.len() / 4));
        }
        let mut take = |n: usize| -> Vec<f32> { (&mut values).take(n).collect() };
        let stem_w = take(channels * planes * 9);
        let stem_b = take(channels);
        let mut block = Vec::with_capacity(blocks);
        for _ in 0..blocks {
            let w1 = take(channels * channels * 9);
            let b1 = take(channels);
            let w2 = take(channels * channels * 9);
            let b2 = take(channels);
            block.push((w1, b1, w2, b2));
        }
        let head_w = take(head * channels);
        let head_b = take(head);
        let fc1_w = take(hidden * head * N);
        let fc1_b = take(hidden);
        let fc2_w = take(hidden);
        let fc2_b = take(1)[0];
        let net = Net { planes, channels, blocks, head, hidden, stem_w, stem_b, block, head_w, head_b, fc1_w, fc1_b, fc2_w, fc2_b };
        if !net.all_finite() {
            return Err("le reseau contient des valeurs non finies".into());
        }
        Ok(net)
    }

    pub fn load(path: &str) -> Result<Net, String> {
        let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
        Net::parse(&bytes).map_err(|e| format!("{path}: {e}"))
    }

    /// Ecrit le reseau au format lu par [`Net::parse`] (tests, reseaux tires au hasard).
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = b"KSNN".to_vec();
        for v in [1, self.planes, self.channels, self.blocks, self.head, self.hidden, 0] {
            out.extend_from_slice(&(v as u32).to_le_bytes());
        }
        let mut put = |xs: &[f32]| xs.iter().for_each(|v| out.extend_from_slice(&v.to_le_bytes()));
        put(&self.stem_w);
        put(&self.stem_b);
        for (w1, b1, w2, b2) in &self.block {
            put(w1);
            put(b1);
            put(w2);
            put(b2);
        }
        put(&self.head_w);
        put(&self.head_b);
        put(&self.fc1_w);
        put(&self.fc1_b);
        put(&self.fc2_w);
        put(&[self.fc2_b]);
        out
    }

    fn all_finite(&self) -> bool {
        let ok = |xs: &[f32]| xs.iter().all(|v| v.is_finite());
        ok(&self.stem_w) && ok(&self.stem_b) && ok(&self.head_w) && ok(&self.head_b) && ok(&self.fc1_w)
            && ok(&self.fc1_b) && ok(&self.fc2_w) && self.fc2_b.is_finite()
            && self.block.iter().all(|(a, b, c, d)| ok(a) && ok(b) && ok(c) && ok(d))
    }

    /// nombre de parametres
    pub fn parameters(&self) -> usize {
        self.stem_w.len() + self.stem_b.len()
            + self.block.iter().map(|(a, b, c, d)| a.len() + b.len() + c.len() + d.len()).sum::<usize>()
            + self.head_w.len() + self.head_b.len() + self.fc1_w.len() + self.fc1_b.len() + self.fc2_w.len() + 1
    }

    pub fn scratch(&self) -> Scratch {
        let c = self.channels.max(PLANES);
        Scratch {
            input: vec![0.0; PLANES * N],
            a: vec![0.0; c * PN],
            b: vec![0.0; c * PN],
            c: vec![0.0; c * PN],
            head: vec![0.0; self.head * N],
            hidden: vec![0.0; self.hidden],
        }
    }

    /// Valeur de la position pour `who`, au trait, dans [-1, 1].
    pub fn value(&self, ctx: &Ctx, st: &State, who: i8, s: &mut Scratch) -> f32 {
        let mut input = std::mem::take(&mut s.input);
        encode(ctx, st, who, &mut input);
        let v = self.forward(&input, s);
        s.input = input;
        v
    }

    /// Passe avant sur des plans deja codes (PLANES * N valeurs).
    pub fn forward(&self, planes: &[f32], s: &mut Scratch) -> f32 {
        let c = self.channels;
        // plans d'entree dans des plans bordes
        pad_into(planes, PLANES, &mut s.a);
        conv3x3(&s.a, PLANES, &self.stem_w, &self.stem_b, c, &mut s.b, None);
        // s.b : sortie courante (bordee, bordure a 0)
        for (w1, b1, w2, b2) in &self.block {
            conv3x3(&s.b, c, w1, b1, c, &mut s.c, None);
            // deuxieme convolution, plus le raccourci, puis ReLU
            conv3x3(&s.c, c, w2, b2, c, &mut s.a, Some(&s.b));
            std::mem::swap(&mut s.a, &mut s.b);
        }
        // tete : conv 1x1, ReLU
        for h in 0..self.head {
            let out = &mut s.head[h * N..(h + 1) * N];
            out.iter_mut().for_each(|v| *v = self.head_b[h]);
            for ci in 0..c {
                let w = self.head_w[h * c + ci];
                let plane = &s.b[ci * PN..(ci + 1) * PN];
                for y in 0..ROWS {
                    let src = &plane[(y + 1) * PC + 1..(y + 1) * PC + 1 + COLS];
                    let dst = &mut out[y * COLS..(y + 1) * COLS];
                    for x in 0..COLS {
                        dst[x] += w * src[x];
                    }
                }
            }
            out.iter_mut().for_each(|v| *v = v.max(0.0));
        }
        let flat = self.head * N;
        for k in 0..self.hidden {
            let row = &self.fc1_w[k * flat..(k + 1) * flat];
            s.hidden[k] = (dot(row, &s.head) + self.fc1_b[k]).max(0.0);
        }
        (dot(&self.fc2_w, &s.hidden) + self.fc2_b).tanh()
    }
}

/// `n` plans de N valeurs vers des plans bordes de PN valeurs (bordure a 0)
fn pad_into(src: &[f32], n: usize, dst: &mut [f32]) {
    for p in 0..n {
        let d = &mut dst[p * PN..(p + 1) * PN];
        d.iter_mut().for_each(|v| *v = 0.0);
        for y in 0..ROWS {
            d[(y + 1) * PC + 1..(y + 1) * PC + 1 + COLS].copy_from_slice(&src[p * N + y * COLS..p * N + (y + 1) * COLS]);
        }
    }
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    #[cfg(target_arch = "x86_64")]
    {
        if std::arch::is_x86_feature_detected!("avx2") && std::arch::is_x86_feature_detected!("fma") {
            // SAFETY : les jeux d'instructions viennent d'etre detectes
            return unsafe { dot_avx2(a, b) };
        }
    }
    dot_generic(a, b)
}

#[inline(always)]
fn dot_generic(a: &[f32], b: &[f32]) -> f32 {
    // huit accumulateurs : le compilateur en fait des registres vectoriels
    let mut acc = [0f32; 8];
    let chunks = a.len() / 8;
    for i in 0..chunks {
        for k in 0..8 {
            acc[k] += a[i * 8 + k] * b[i * 8 + k];
        }
    }
    let mut total: f32 = acc.iter().sum();
    for i in chunks * 8..a.len() {
        total += a[i] * b[i];
    }
    total
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2,fma")]
unsafe fn dot_avx2(a: &[f32], b: &[f32]) -> f32 {
    dot_generic(a, b)
}

/// Convolution 3x3, bordure 1, sur des plans bordes ; ReLU en sortie, apres
/// ajout de `residual` s'il y en a un. La bordure de `out` est laissee a 0.
fn conv3x3(input: &[f32], cin: usize, w: &[f32], b: &[f32], cout: usize, out: &mut [f32], residual: Option<&[f32]>) {
    #[cfg(target_arch = "x86_64")]
    {
        if std::arch::is_x86_feature_detected!("avx2") && std::arch::is_x86_feature_detected!("fma") {
            // SAFETY : les jeux d'instructions viennent d'etre detectes
            unsafe { conv3x3_avx2(input, cin, w, b, cout, out, residual) };
            return;
        }
    }
    conv3x3_generic(input, cin, w, b, cout, out, residual)
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2,fma")]
unsafe fn conv3x3_avx2(input: &[f32], cin: usize, w: &[f32], b: &[f32], cout: usize, out: &mut [f32], residual: Option<&[f32]>) {
    conv3x3_generic(input, cin, w, b, cout, out, residual)
}

/// Quatre canaux de sortie a la fois : chaque ligne d'entree lue sert quatre
/// fois. La boucle interieure (27 colonnes bordees, dont 25 utiles) se
/// vectorise ; on calcule toute la largeur bordee puis on remet la bordure a 0,
/// ce qui evite les restes de boucle.
#[inline(always)]
fn conv3x3_generic(input: &[f32], cin: usize, w: &[f32], b: &[f32], cout: usize, out: &mut [f32], residual: Option<&[f32]>) {
    // lignes interieures 1..=ROWS ; dans chaque ligne, les colonnes 1..=COLS
    // utiles, calculees sur la plage 1..PC-1 (une colonne d'avance de chaque
    // cote suffit : x-1 >= 0 et x+1 <= PC-1)
    const SPAN: usize = PC - 2; // = COLS
    let mut co = 0;
    while co < cout {
        let group = (cout - co).min(4);
        let mut acc = [[0f32; ROWS * SPAN]; 4];
        for g in 0..group {
            acc[g].iter_mut().for_each(|v| *v = b[co + g]);
        }
        for ci in 0..cin {
            let plane = &input[ci * PN..(ci + 1) * PN];
            for ky in 0..3 {
                for kx in 0..3 {
                    let mut wk = [0f32; 4];
                    for g in 0..group {
                        wk[g] = w[((co + g) * cin + ci) * 9 + ky * 3 + kx];
                    }
                    for y in 0..ROWS {
                        // case (y, x) de la sortie <- case bordee (y + ky, x + kx)
                        let src = &plane[(y + ky) * PC + kx..(y + ky) * PC + kx + SPAN];
                        let base = y * SPAN;
                        if group == 4 {
                            let (a0, rest) = acc.split_at_mut(1);
                            let (a1, rest) = rest.split_at_mut(1);
                            let (a2, a3) = rest.split_at_mut(1);
                            let (d0, d1, d2, d3) = (&mut a0[0][base..base + SPAN], &mut a1[0][base..base + SPAN], &mut a2[0][base..base + SPAN], &mut a3[0][base..base + SPAN]);
                            for x in 0..SPAN {
                                let v = src[x];
                                d0[x] += wk[0] * v;
                                d1[x] += wk[1] * v;
                                d2[x] += wk[2] * v;
                                d3[x] += wk[3] * v;
                            }
                        } else {
                            for g in 0..group {
                                let d = &mut acc[g][base..base + SPAN];
                                for x in 0..SPAN {
                                    d[x] += wk[g] * src[x];
                                }
                            }
                        }
                    }
                }
            }
        }
        for g in 0..group {
            let o = &mut out[(co + g) * PN..(co + g + 1) * PN];
            o.iter_mut().for_each(|v| *v = 0.0);
            for y in 0..ROWS {
                for x in 0..SPAN {
                    let i = (y + 1) * PC + x + 1;
                    let mut v = acc[g][y * SPAN + x];
                    if let Some(r) = residual {
                        v += r[(co + g) * PN + i];
                    }
                    o[i] = v.max(0.0);
                }
            }
        }
        co += group;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// convolution de reference, sans plans bordes
    fn conv_ref(input: &[f32], cin: usize, w: &[f32], b: &[f32], cout: usize) -> Vec<f32> {
        let mut out = vec![0f32; cout * N];
        for co in 0..cout {
            for y in 0..ROWS as i32 {
                for x in 0..COLS as i32 {
                    let mut v = b[co];
                    for ci in 0..cin {
                        for ky in -1..=1 {
                            for kx in -1..=1 {
                                let (yy, xx) = (y + ky, x + kx);
                                if yy < 0 || xx < 0 || yy >= ROWS as i32 || xx >= COLS as i32 {
                                    continue;
                                }
                                v += w[((co * cin + ci) * 3 + (ky + 1) as usize) * 3 + (kx + 1) as usize]
                                    * input[ci * N + (yy as usize) * COLS + xx as usize];
                            }
                        }
                    }
                    out[co * N + y as usize * COLS + x as usize] = v.max(0.0);
                }
            }
        }
        out
    }

    #[test]
    fn convolution_matches_reference() {
        let net = Net::random(6, 0, 1, 1, 7);
        let mut x = 3u64;
        let input: Vec<f32> = (0..PLANES * N)
            .map(|_| {
                x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                ((x >> 33) % 100) as f32 / 50.0 - 1.0
            })
            .collect();
        let mut padded = vec![0f32; PLANES * PN];
        pad_into(&input, PLANES, &mut padded);
        let mut out = vec![0f32; 6 * PN];
        conv3x3(&padded, PLANES, &net.stem_w, &net.stem_b, 6, &mut out, None);
        let expected = conv_ref(&input, PLANES, &net.stem_w, &net.stem_b, 6);
        for co in 0..6 {
            for y in 0..ROWS {
                for x in 0..COLS {
                    let (a, e) = (out[co * PN + (y + 1) * PC + x + 1], expected[co * N + y * COLS + x]);
                    assert!((a - e).abs() < 1e-4, "canal {co} case {y},{x} : {a} au lieu de {e}");
                }
            }
        }
    }

    #[test]
    fn file_round_trip() {
        let net = Net::random(8, 2, 2, 16, 11);
        let back = Net::parse(&net.to_bytes()).unwrap();
        let ctx = Ctx::default();
        let st = State::new();
        let (mut s1, mut s2) = (net.scratch(), back.scratch());
        let (a, b) = (net.value(&ctx, &st, NORTH, &mut s1), back.value(&ctx, &st, NORTH, &mut s2));
        assert_eq!(a, b);
        assert!((-1.0..=1.0).contains(&a));
        let mut bad = net.to_bytes();
        bad.pop();
        assert!(Net::parse(&bad).is_err());
    }
}
