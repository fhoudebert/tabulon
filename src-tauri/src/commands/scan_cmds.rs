// src-tauri/src/commands/scan_cmds.rs
//
// Pilote du moteur de DAMES natif **Scan** (Fabien Letouzey), pendant de
// engine_cmds.rs pour Fairy-Stockfish : meme raison d'etre (la build wasm
// multi-thread ne peut pas rendre de coup dans une webview Tauri), meme
// modele (un processus par recherche, budget fini, repli silencieux sur
// l'IA native quand le binaire est absent).
//
// DEUX DIFFERENCES DE FOND avec Fairy-Stockfish, sources de bugs si on
// transpose betement :
//
// 1. **Scan ne parle pas UCI mais le protocole « Hub 2 »** (protocol.txt de
//    Scan 3.1), et seulement si on le lance avec l'argument `hub` -- sans
//    lui il demarre en mode texte interactif et ne repondra jamais.
//    Sequence : `hub` -> id/param.../wait -> `init` -> `ready`, puis
//    `pos` / `level` / `go think` -> info... -> `done move=32-28`.
//
// 2. **Le format de position differe de celui que jocly envoie.** jocly
//    (src/core/jocly.scan.js) construit le FEN du dialecte fen.cpp,
//    « W:W31-50:B1-20 », alors que Hub veut 51 caracteres : le trait puis
//    une lettre par case (e/w/W/b/B). D'ou fen_to_hub_pos() ci-dessous, la
//    piece maitresse de ce module -- et la seule ou une erreur produirait un
//    coup silencieusement faux plutot qu'une panne visible.
//
// Le binaire attendu est `engine/scan` (`scan.exe` sous Windows). Scan lit
// `scan.ini` et son repertoire `data/` **relativement a son repertoire de
// travail** : on lance donc le processus AVEC LE REPERTOIRE DU BINAIRE comme
// repertoire courant, sinon il ne trouve ni ses poids d'evaluation ni son
// livre et echoue a l'initialisation.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_shell::ShellExt;

use super::engine_cmds::{binary_path, read_until, EngineState};

const SCAN_BIN: &str = "scan";
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30); // init charge les poids
const SEARCH_GRACE: Duration = Duration::from_secs(20);

/// Chemin du binaire Scan, ou None s'il n'est pas installe.
pub fn scan_path() -> Option<PathBuf> {
    binary_path(SCAN_BIN, "TABULON_SCAN")
}

// ─────────────────────────────────────────────────────────────────────────────
// Types d'echange avec le front
// ─────────────────────────────────────────────────────────────────────────────

/// Champs envoyes par jocly.scan.js a son worker (message {type:"Search"}),
/// repris tels quels pour que le pont JS n'ait rien a traduire.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSearchRequest {
    /// FEN du dialecte fen.cpp, prefixe du trait : "W:W31-50:B1-20".
    pub fen: String,
    #[serde(default)]
    pub depth: Option<u32>,
    #[serde(default)]
    pub move_time_ms: Option<u64>,
    #[serde(default)]
    pub book_enabled: Option<bool>,
    /// Variante de regles Scan (normal, killer, bt, frisian, losing).
    #[serde(default)]
    pub variant: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSearchResult {
    /// Notation « naturelle » de Scan ("33-28", "28x19x23"), que
    /// checkersbase-model.js sait deja resoudre sans traduction.
    pub best_move: Option<String>,
    pub last_info: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversion de position (pure, testee)
// ─────────────────────────────────────────────────────────────────────────────

/// Convertit le FEN de jocly ("W:W31-50:B1-20", "B:WK47,49:B6,K12") en
/// position Hub : 1 caractere de trait + 50 caracteres de cases.
///
/// Regles du dialecte : un groupe par camp, prefixe 'W' ou 'B' ; a
/// l'interieur, des cases separees par des virgules, chacune eventuellement
/// prefixee de 'K' pour une dame, et des intervalles « a-b ». Les cases sont
/// numerotees de 1 a 50.
pub(crate) fn fen_to_hub_pos(fen: &str) -> Result<String, String> {
    let fen = fen.trim();
    let mut parts = fen.split(':');
    let turn = parts
        .next()
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| format!("FEN sans trait : {:?}", fen))?;
    let turn = match turn.chars().next().unwrap().to_ascii_uppercase() {
        'W' => 'W',
        'B' => 'B',
        c => return Err(format!("trait inattendu {:?} dans {:?}", c, fen)),
    };

    let mut squares = ['e'; 50];
    for group in parts {
        let group = group.trim();
        if group.is_empty() {
            continue;
        }
        let (side, body) = group.split_at(1);
        let side = match side.chars().next().unwrap().to_ascii_uppercase() {
            'W' => 'w',
            'B' => 'b',
            c => return Err(format!("camp inattendu {:?} dans {:?}", c, fen)),
        };
        for item in body.split(',') {
            let item = item.trim();
            if item.is_empty() {
                continue;
            }
            let (king, num) = match item.strip_prefix(['K', 'k']) {
                Some(rest) => (true, rest),
                None => (false, item),
            };
            let piece = if king {
                side.to_ascii_uppercase()
            } else {
                side
            };
            let (from, to) = match num.split_once('-') {
                Some((a, b)) => (parse_square(a, fen)?, parse_square(b, fen)?),
                None => {
                    let n = parse_square(num, fen)?;
                    (n, n)
                }
            };
            if from > to {
                return Err(format!("intervalle inverse {:?} dans {:?}", item, fen));
            }
            for sq in from..=to {
                squares[sq - 1] = piece;
            }
        }
    }

    let mut out = String::with_capacity(51);
    out.push(turn);
    out.extend(squares.iter());
    Ok(out)
}

fn parse_square(s: &str, fen: &str) -> Result<usize, String> {
    let n: usize = s
        .trim()
        .parse()
        .map_err(|_| format!("case illisible {:?} dans {:?}", s, fen))?;
    if !(1..=50).contains(&n) {
        return Err(format!("case hors plateau {} dans {:?}", n, fen));
    }
    Ok(n)
}

// ─────────────────────────────────────────────────────────────────────────────
// Protocole Hub (pur, teste)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum HubLine {
    /// Fin de la declaration des parametres : le moteur attend `init`.
    Wait,
    /// Initialisation terminee.
    Ready,
    Id(String),
    Done { mv: Option<String> },
    Error(String),
    Info(String),
    Other,
}

/// Classe une ligne Hub. Fonction pure.
pub(crate) fn classify_hub(line: &str) -> HubLine {
    let l = line.trim();
    if l == "wait" || l.starts_with("wait ") {
        return HubLine::Wait;
    }
    if l == "ready" || l.starts_with("ready ") {
        return HubLine::Ready;
    }
    if let Some(rest) = l.strip_prefix("id ") {
        return HubLine::Id(hub_field(rest, "name").unwrap_or_else(|| "Scan".into()));
    }
    if let Some(rest) = l.strip_prefix("error ") {
        return HubLine::Error(hub_field(rest, "message").unwrap_or_else(|| rest.to_string()));
    }
    if l == "done" || l.starts_with("done ") {
        let rest = l.strip_prefix("done").unwrap_or("").trim();
        // « done » sans move est legitime : position terminale.
        return HubLine::Done {
            mv: hub_field(rest, "move").filter(|m| !m.is_empty()),
        };
    }
    if l.starts_with("info ") {
        return HubLine::Info(l.to_string());
    }
    HubLine::Other
}

/// Extrait `nom=valeur` d'une ligne Hub, en tenant compte des guillemets
/// (`pv="32-28 17-22"`, `author="Fabien Letouzey"`). Fonction pure.
pub(crate) fn hub_field(line: &str, name: &str) -> Option<String> {
    let needle = format!("{}=", name);
    let mut rest = line;
    loop {
        let at = rest.find(&needle)?;
        // Le champ doit commencer un mot, sinon "mean-depth=" repondrait
        // pour "depth".
        let starts_word = at == 0
            || rest[..at]
                .chars()
                .next_back()
                .map(|c| c.is_whitespace())
                .unwrap_or(false);
        let after = &rest[at + needle.len()..];
        if starts_word {
            return Some(if let Some(q) = after.strip_prefix('"') {
                q.split('"').next().unwrap_or("").to_string()
            } else {
                after
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_string()
            });
        }
        rest = &rest[at + needle.len()..];
    }
}

/// Commande `level` d'une recherche. `move-time` est en SECONDES (reel).
pub(crate) fn level_command(req: &ScanSearchRequest) -> String {
    match req.move_time_ms {
        Some(ms) if ms > 0 => format!("level move-time={}", (ms as f64) / 1000.0),
        _ => format!("level depth={}", req.depth.unwrap_or(12)),
    }
}

pub(crate) fn search_budget(req: &ScanSearchRequest) -> Duration {
    match req.move_time_ms {
        Some(ms) if ms > 0 => Duration::from_millis(ms) + SEARCH_GRACE,
        _ => SEARCH_GRACE + Duration::from_secs(40),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Commandes Tauri
// ─────────────────────────────────────────────────────────────────────────────

/// Verifie que Scan est installe et repond en Hub. Renvoie son identite.
#[tauri::command]
pub async fn scan_probe(app: AppHandle) -> Result<String, String> {
    let path = scan_path().ok_or_else(|| "moteur Scan introuvable".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "chemin du moteur Scan invalide".to_string())?;

    let (mut rx, mut child) = app
        .shell()
        .command(&path)
        .args(["hub"])
        .current_dir(dir.to_path_buf())
        .spawn()
        .map_err(|e| format!("Scan non demarrable ({}): {}", path.display(), e))?;

    let mut name = String::new();
    child.write(b"hub\n").map_err(|e| e.to_string())?;
    let res = read_until(&mut rx, HANDSHAKE_TIMEOUT, |line| match classify_hub(line) {
        HubLine::Id(n) => {
            name = n;
            None
        }
        HubLine::Error(m) => Some(Err(m)),
        HubLine::Wait => Some(Ok(())),
        _ => None,
    })
    .await;
    let _ = child.kill();
    res?;
    Ok(if name.is_empty() {
        "Scan".to_string()
    } else {
        name
    })
}

#[tauri::command]
pub async fn scan_search(
    app: AppHandle,
    state: State<'_, EngineState>,
    request: ScanSearchRequest,
) -> Result<ScanSearchResult, String> {
    // Conversion AVANT de lancer quoi que ce soit : un FEN illisible doit
    // echouer tout de suite, pas apres 30 s d'initialisation.
    let pos = fen_to_hub_pos(&request.fen)?;

    let path = scan_path().ok_or_else(|| "moteur Scan introuvable".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "chemin du moteur Scan invalide".to_string())?;

    // `hub` en argument : sans lui Scan demarre en mode texte interactif et
    // ne repondra jamais au protocole. current_dir : Scan lit scan.ini et
    // data/ relativement a son repertoire de travail.
    let (mut rx, mut child) = app
        .shell()
        .command(&path)
        .args(["hub"])
        .current_dir(dir.to_path_buf())
        .spawn()
        .map_err(|e| format!("Scan non demarrable ({}): {}", path.display(), e))?;

    child.write(b"hub\n").map_err(|e| e.to_string())?;
    read_until(&mut rx, HANDSHAKE_TIMEOUT, |line| match classify_hub(line) {
        HubLine::Wait => Some(Ok(())),
        HubLine::Error(m) => Some(Err(m)),
        _ => None,
    })
    .await?;

    // Les parametres se posent AVANT `init` : le protocole precise qu'ils
    // conditionnent le chargement des donnees (livre, bitbases).
    for c in init_commands(&request) {
        child
            .write(format!("{}\n", c).as_bytes())
            .map_err(|e| e.to_string())?;
    }
    read_until(&mut rx, HANDSHAKE_TIMEOUT, |line| match classify_hub(line) {
        HubLine::Ready => Some(Ok(())),
        HubLine::Error(m) => Some(Err(m)),
        _ => None,
    })
    .await?;

    for c in [
        "new-game".to_string(),
        format!("pos pos={}", pos),
        level_command(&request),
        "go think".to_string(),
    ] {
        child
            .write(format!("{}\n", c).as_bytes())
            .map_err(|e| e.to_string())?;
    }

    let budget = search_budget(&request);
    state.set(child);

    let mut last_info: Option<String> = None;
    let outcome = read_until(&mut rx, budget, |line| match classify_hub(line) {
        HubLine::Info(i) => {
            last_info = Some(i);
            None
        }
        HubLine::Error(m) => Some(Err(m)),
        HubLine::Done { mv } => Some(Ok(mv)),
        _ => None,
    })
    .await;

    if let Some(c) = state.take() {
        let _ = c.kill();
    }

    Ok(ScanSearchResult {
        best_move: outcome?,
        last_info,
    })
}

/// Parametres poses avant `init`, puis `init` lui-meme.
pub(crate) fn init_commands(req: &ScanSearchRequest) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(v) = req.variant.as_deref().filter(|v| !v.trim().is_empty()) {
        out.push(format!("set-param name=variant value={}", v.trim()));
    }
    if req.book_enabled == Some(false) {
        out.push("set-param name=book value=false".to_string());
    }
    out.push("init".to_string());
    out
}

/// Interrompt la recherche en cours. Comme pour Fairy-Stockfish, tuer le
/// processus suffit : le modele est un processus par recherche.
#[tauri::command]
pub async fn scan_stop(state: State<'_, EngineState>) -> Result<(), String> {
    if let Some(child) = state.take() {
        let _ = child.kill();
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> ScanSearchRequest {
        ScanSearchRequest {
            fen: "W:W31-50:B1-20".into(),
            depth: None,
            move_time_ms: None,
            book_enabled: None,
            variant: None,
        }
    }

    #[test]
    fn position_de_depart() {
        let p = fen_to_hub_pos("W:W31-50:B1-20").unwrap();
        assert_eq!(p.len(), 51, "1 caractere de trait + 50 cases");
        // Exemple litteral de protocol.txt (Scan 3.1), trait inverse :
        // 20 noirs, 10 vides, 20 blancs.
        assert_eq!(&p[..1], "W");
        assert_eq!(&p[1..21], "b".repeat(20));
        assert_eq!(&p[21..31], "e".repeat(10));
        assert_eq!(&p[31..51], "w".repeat(20));
    }

    #[test]
    fn le_trait_est_repris_tel_quel() {
        assert!(fen_to_hub_pos("B:W31-50:B1-20").unwrap().starts_with('B'));
        assert!(fen_to_hub_pos("w:W50:B1").unwrap().starts_with('W'));
    }

    #[test]
    fn dames_et_cases_isolees() {
        // K = dame ; melange de cases isolees, d'intervalles et de dames.
        let p = fen_to_hub_pos("W:WK47,49:B6,K12").unwrap();
        let sq = |n: usize| p.chars().nth(n).unwrap(); // n = numero de case
        assert_eq!(sq(47), 'W', "dame blanche en 47");
        assert_eq!(sq(49), 'w', "pion blanc en 49");
        assert_eq!(sq(6), 'b', "pion noir en 6");
        assert_eq!(sq(12), 'B', "dame noire en 12");
        assert_eq!(sq(1), 'e');
        assert_eq!(p[1..].chars().filter(|c| *c != 'e').count(), 4);
    }

    #[test]
    fn camp_vide_accepte() {
        // Fin de partie : un camp peut n'avoir aucune piece.
        let p = fen_to_hub_pos("B:W:B1").unwrap();
        assert_eq!(p[1..].chars().filter(|c| *c != 'e').count(), 1);
        assert_eq!(p.chars().nth(1).unwrap(), 'b');
    }

    #[test]
    fn refuse_plutot_que_de_jouer_faux() {
        // Une conversion approximative produirait un coup silencieusement
        // faux : mieux vaut echouer bruyamment.
        assert!(fen_to_hub_pos("").is_err());
        assert!(fen_to_hub_pos("X:W1:B2").is_err(), "trait inconnu");
        assert!(fen_to_hub_pos("W:Z1").is_err(), "camp inconnu");
        assert!(fen_to_hub_pos("W:W51").is_err(), "case hors plateau");
        assert!(fen_to_hub_pos("W:W0").is_err(), "case hors plateau");
        assert!(fen_to_hub_pos("W:W1-x").is_err(), "borne illisible");
        assert!(fen_to_hub_pos("W:W10-5").is_err(), "intervalle inverse");
    }

    #[test]
    fn classe_les_lignes_hub() {
        assert_eq!(classify_hub("wait"), HubLine::Wait);
        assert_eq!(classify_hub("ready"), HubLine::Ready);
        assert_eq!(
            classify_hub("done move=32-28 ponder=17-22"),
            HubLine::Done {
                mv: Some("32-28".into())
            }
        );
        assert_eq!(
            classify_hub("done move=28x19x23"),
            HubLine::Done {
                mv: Some("28x19x23".into())
            }
        );
        // Position terminale : « done » sans coup, a distinguer d'une panne.
        assert_eq!(classify_hub("done"), HubLine::Done { mv: None });
        match classify_hub("error message=\"no eval file\"") {
            HubLine::Error(m) => assert_eq!(m, "no eval file"),
            o => panic!("attendu Error, obtenu {:?}", o),
        }
        match classify_hub("id name=Scan version=3.1 author=\"Fabien Letouzey\"") {
            HubLine::Id(n) => assert_eq!(n, "Scan"),
            o => panic!("attendu Id, obtenu {:?}", o),
        }
    }

    #[test]
    fn les_champs_hub_tiennent_compte_des_guillemets_et_des_prefixes() {
        let info = "info depth=21 mean-depth=20.8 score=-0.01 pv=\"32-28 17-22\"";
        // « mean-depth= » ne doit pas repondre pour « depth ».
        assert_eq!(hub_field(info, "depth").as_deref(), Some("21"));
        assert_eq!(hub_field(info, "mean-depth").as_deref(), Some("20.8"));
        assert_eq!(hub_field(info, "pv").as_deref(), Some("32-28 17-22"));
        assert_eq!(hub_field(info, "absent"), None);
    }

    #[test]
    fn niveau_en_secondes() {
        let mut r = req();
        assert_eq!(level_command(&r), "level depth=12");
        r.depth = Some(20);
        assert_eq!(level_command(&r), "level depth=20");
        // Hub attend des SECONDES, jocly fournit des millisecondes.
        r.move_time_ms = Some(1500);
        assert_eq!(level_command(&r), "level move-time=1.5");
        r.move_time_ms = Some(0);
        assert_eq!(level_command(&r), "level depth=20");
    }

    #[test]
    fn parametres_avant_init() {
        let mut r = req();
        assert_eq!(init_commands(&r), vec!["init".to_string()]);

        r.book_enabled = Some(false);
        r.variant = Some("frisian".into());
        let c = init_commands(&r);
        assert_eq!(c.last().unwrap(), "init", "init vient toujours en dernier");
        assert!(c.iter().any(|l| l == "set-param name=variant value=frisian"));
        assert!(c.iter().any(|l| l == "set-param name=book value=false"));

        // book actif = defaut du moteur : ne rien poser.
        let mut r2 = req();
        r2.book_enabled = Some(true);
        assert_eq!(init_commands(&r2), vec!["init".to_string()]);
    }

    #[test]
    fn le_budget_est_toujours_fini() {
        let mut r = req();
        assert!(search_budget(&r) > Duration::from_secs(0));
        r.move_time_ms = Some(2000);
        assert!(search_budget(&r) >= Duration::from_millis(2000));
        assert!(search_budget(&r) < Duration::from_secs(3600));
    }
}
