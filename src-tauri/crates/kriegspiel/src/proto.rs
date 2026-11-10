//! Format texte des positions et des coups : celui de l'executable et des
//! fichiers du test differentiel.
//!
//! Position : `<trait N|S> <phase> <coups> <arsenaux> <retraite|-> <grille>`
//!   - arsenaux : 4 chiffres 0/1, dans l'ordre D8 B15 T3 T23 ;
//!   - grille : les 500 cases, ligne A d'abord ; `ICAHTE` pour le Nord
//!     (H : artillerie a cheval), `icahte` pour le Sud ; un nombre compte des
//!     cases vides, comme dans une FEN (`.` est accepte pour une case vide).
//!
//! Coup : `pass`, ou des mots separes par des espaces, dans l'ordre du tour :
//!   `r:137-112` retraite, `137-112` deplacement, `x212` attaque,
//!   `d453` arsenal detruit ; placement : `p:1@12,1@13,...` (type@case).

use crate::rules::*;

const NORTH_CHARS: &[u8; 6] = b"ICAHTE";

pub fn format_position(st: &State, who: i8) -> String {
    let mut out = String::with_capacity(N + 24);
    out.push(if who > 0 { 'N' } else { 'S' });
    out.push_str(&format!(" {} {} ", st.phase, st.turn));
    for a in st.ars {
        out.push(if a { '1' } else { '0' });
    }
    if st.retreat >= 0 {
        out.push_str(&format!(" {} ", st.retreat));
    } else {
        out.push_str(" - ");
    }
    let mut empty = 0;
    for &v in st.grid.iter() {
        if v == 0 {
            empty += 1;
            continue;
        }
        if empty > 0 {
            out.push_str(&empty.to_string());
            empty = 0;
        }
        out.push(if v > 0 {
            NORTH_CHARS[(v - 1) as usize] as char
        } else {
            (NORTH_CHARS[(-v - 1) as usize] as char).to_ascii_lowercase()
        });
    }
    if empty > 0 {
        out.push_str(&empty.to_string());
    }
    out
}

pub fn parse_position(text: &str) -> Result<(State, i8), String> {
    let fields: Vec<&str> = text.split_whitespace().collect();
    if fields.len() != 6 {
        return Err(format!("position : 6 champs attendus, {} lus", fields.len()));
    }
    let who = match fields[0] {
        "N" => NORTH,
        "S" => SOUTH,
        other => return Err(format!("trait inconnu : {other}")),
    };
    let mut st = State::new();
    st.phase = fields[1].parse().map_err(|_| "phase illisible".to_string())?;
    if st.phase > 2 {
        return Err("phase hors bornes".into());
    }
    st.turn = fields[2].parse().map_err(|_| "compteur de coups illisible".to_string())?;
    let ars = fields[3].as_bytes();
    if ars.len() != 4 || ars.iter().any(|&c| c != b'0' && c != b'1') {
        return Err("arsenaux : 4 chiffres 0/1 attendus".into());
    }
    for i in 0..4 {
        st.ars[i] = ars[i] == b'1';
    }
    st.retreat = if fields[4] == "-" {
        -1
    } else {
        let pos: usize = fields[4].parse().map_err(|_| "retraite illisible".to_string())?;
        if pos >= N {
            return Err("retraite hors plateau".into());
        }
        pos as i16
    };
    let (mut pos, mut run) = (0usize, 0usize);
    for &c in fields[5].as_bytes() {
        if c.is_ascii_digit() {
            run = run * 10 + (c - b'0') as usize;
            if run > N {
                return Err("grille : trop de cases".into());
            }
            continue;
        }
        pos += run;
        run = 0;
        let v = if c == b'.' {
            0
        } else if let Some(i) = NORTH_CHARS.iter().position(|&x| x == c) {
            i as i8 + 1
        } else if let Some(i) = NORTH_CHARS.iter().position(|&x| x.to_ascii_lowercase() == c) {
            -(i as i8 + 1)
        } else {
            return Err(format!("grille : caractere inconnu `{}`", c as char));
        };
        if pos >= N {
            return Err("grille : trop de cases".into());
        }
        st.grid[pos] = v;
        pos += 1;
    }
    pos += run;
    if pos != N {
        return Err(format!("grille : {N} cases attendues, {pos} lues"));
    }
    Ok((st, who))
}

pub fn format_move(mv: &Move) -> String {
    if let Some(p) = &mv.p {
        let items: Vec<String> = p.iter().map(|(t, pos)| format!("{t}@{pos}")).collect();
        return format!("p:{}", items.join(","));
    }
    let mut parts = Vec::new();
    if let Some((a, b)) = mv.r {
        parts.push(format!("r:{a}-{b}"));
    }
    for (a, b) in &mv.m {
        parts.push(format!("{a}-{b}"));
    }
    if let Some(t) = mv.a {
        parts.push(format!("x{t}"));
    }
    if let Some(d) = mv.d {
        parts.push(format!("d{d}"));
    }
    if parts.is_empty() { "pass".into() } else { parts.join(" ") }
}

fn parse_step(text: &str) -> Result<(u16, u16), String> {
    let (a, b) = text.split_once('-').ok_or_else(|| format!("deplacement illisible : {text}"))?;
    let a: u16 = a.parse().map_err(|_| format!("case illisible : {text}"))?;
    let b: u16 = b.parse().map_err(|_| format!("case illisible : {text}"))?;
    Ok((a, b))
}

pub fn parse_move(text: &str) -> Result<Move, String> {
    let mut mv = Move::default();
    let text = text.trim();
    if text == "pass" || text.is_empty() {
        return Ok(mv);
    }
    if let Some(list) = text.strip_prefix("p:") {
        let mut p = Vec::new();
        for item in list.split(',') {
            let (t, pos) = item.split_once('@').ok_or_else(|| format!("placement illisible : {item}"))?;
            p.push((
                t.parse().map_err(|_| format!("type illisible : {item}"))?,
                pos.parse().map_err(|_| format!("case illisible : {item}"))?,
            ));
        }
        mv.p = Some(p);
        return Ok(mv);
    }
    for word in text.split_whitespace() {
        if let Some(step) = word.strip_prefix("r:") {
            mv.r = Some(parse_step(step)?);
        } else if let Some(t) = word.strip_prefix('x') {
            mv.a = Some(t.parse().map_err(|_| format!("cible illisible : {word}"))?);
        } else if let Some(d) = word.strip_prefix('d') {
            mv.d = Some(d.parse().map_err(|_| format!("arsenal illisible : {word}"))?);
        } else {
            mv.m.push(parse_step(word)?);
        }
    }
    Ok(mv)
}

/// notation lisible, celle de `Move.ToString` dans jocly2 : `r:E5-E6 F3-G4 xE7`
pub fn move_notation(mv: &Move) -> String {
    if mv.p.is_some() {
        return format_move(mv);
    }
    let mut parts = Vec::new();
    let mut flagged = false;
    let mut step = |(a, b): (u16, u16)| {
        let mut text = format!("{}-{}", pos_name(a as usize), pos_name(b as usize));
        if !flagged && mv.d == Some(b) {
            flagged = true;
            text.push('!');
        }
        text
    };
    if let Some(r) = mv.r {
        parts.push(format!("r:{}", step(r)));
    }
    for &s in &mv.m {
        parts.push(step(s));
    }
    if let Some(t) = mv.a {
        parts.push(format!("x{}", pos_name(t as usize)));
    }
    if parts.is_empty() { "-".into() } else { parts.join(" ") }
}
