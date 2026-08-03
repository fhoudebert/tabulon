// src-tauri/src/commands/engine_cmds.rs
//
// Pilote du moteur Fairy-Stockfish NATIF, lance comme processus fils et
// pilote en UCI sur stdin/stdout.
//
// POURQUOI (voir DEVELOPMENT.md § Native engine) : la build wasm embarquee
// dans jocly est MULTI-THREAD (pthreads Emscripten). Dans une webview Tauri,
// la requete du worker pthread `stockfish.worker.js` reste indefiniment en
// attente -- mesure : onglet Reseau, "pending" sans statut, sous dist interne
// ET externe, donc y compris via le protocole INTEGRE. Resultat : "engine
// ready" puis silence, aucune ligne UCI, aucun bestmove, interface figee.
// Un binaire natif n'a ni worker, ni wasm, ni protocole custom a traverser :
// il supprime la cause au lieu de la contourner, et il est plus rapide.
//
// POURQUOI PAS `externalBin` (le vrai "sidecar" Tauri) : declarer le binaire
// dans tauri.conf.json le rend OBLIGATOIRE A LA COMPILATION -- verifie ici,
// tauri-build echoue avec "resource path binaries/fairy-stockfish-<triplet>
// doesn't exist". Toute la compilation de Tabulon dependrait alors de la
// presence d'un binaire par plateforme, y compris pour qui ne veut pas
// d'Expert. On resout donc le binaire A L'EXECUTION, sur le meme modele que
// le dist externe (dist_override::external_dist) : c'est la convention deja
// en place dans ce projet. Passer a un vrai bundling reste possible plus tard
// sans toucher a ce module.
//
// MODELE DE PROCESSUS : un processus par recherche. C'est volontaire --
// l'etat d'un moteur persistant (variante courante, options, position) est
// une source classique de bugs difficiles, alors qu'un `go` de quelques
// centaines de millisecondes rend le cout du demarrage negligeable pour un
// jeu de plateau. Le handle du processus courant est conserve uniquement
// pour pouvoir l'interrompre (engine_stop).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Nom de base du binaire cherche a l'execution.
const ENGINE_BIN: &str = "fairy-stockfish";

/// Delai maximal d'une poignee de main UCI (`uci` -> `uciok`).
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Marge ajoutee au budget de recherche avant d'abandonner. Sans plafond,
/// un moteur muet figerait l'appel -- exactement le defaut de la voie wasm
/// que ce module remplace.
const SEARCH_GRACE: Duration = Duration::from_secs(20);

// ─────────────────────────────────────────────────────────────────────────────
// Localisation du binaire
// ─────────────────────────────────────────────────────────────────────────────

/// Nom de fichier attendu selon la plateforme.
fn engine_file_name() -> String {
    if cfg!(target_os = "windows") {
        format!("{}.exe", ENGINE_BIN)
    } else {
        ENGINE_BIN.to_string()
    }
}

/// Cherche le binaire du moteur, dans l'ordre :
///   1. `TABULON_ENGINE` (chemin complet) — echappatoire de test et moyen
///      d'utiliser une build maison sans reinstaller ;
///   2. `engine/<nom>` puis `<nom>` a cote de l'executable — meme logique de
///      bases que dist_override::external_dist (AppImage via $APPIMAGE,
///      bundle .app de macOS), pour que « poser le moteur a cote de
///      l'application » marche partout de la meme facon ;
///   3. rien : le moteur est absent, et l'appelant se rabat sur l'IA native.
///
/// Volontairement PAS de recherche dans le PATH : lancer un binaire
/// arbitraire trouve dans l'environnement serait une surprise desagreable.
pub fn engine_path() -> Option<PathBuf> {
    let name = engine_file_name();

    if let Ok(p) = std::env::var("TABULON_ENGINE") {
        if !p.is_empty() {
            let p = PathBuf::from(p);
            if p.is_file() {
                return Some(p);
            }
            log::warn!("TABULON_ENGINE ne designe pas un fichier : {}", p.display());
            return None;
        }
    }

    let mut bases: Vec<PathBuf> = Vec::new();
    if let Ok(appimage) = std::env::var("APPIMAGE") {
        if let Some(dir) = Path::new(&appimage).parent() {
            bases.push(dir.to_path_buf());
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            bases.push(dir.to_path_buf());
            bases.push(dir.join(".."));
            bases.push(dir.join("..").join("..").join(".."));
        }
    }

    for base in bases {
        for cand in [base.join("engine").join(&name), base.join(&name)] {
            if cand.is_file() {
                log::info!("moteur natif : {}", cand.display());
                return Some(cand);
            }
        }
    }
    log::info!("aucun moteur natif trouve — le niveau Expert se rabattra sur l'IA native");
    None
}

// ─────────────────────────────────────────────────────────────────────────────
// Etat
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct EngineState {
    /// Processus de la recherche en cours, s'il y en a une.
    current: Mutex<Option<CommandChild>>,
}

impl EngineState {
    fn set(&self, child: CommandChild) {
        if let Ok(mut slot) = self.current.lock() {
            // Une recherche deja en vol est remplacee : on tue l'ancienne
            // plutot que de laisser un processus orphelin consommer un cœur.
            if let Some(old) = slot.take() {
                let _ = old.kill();
            }
            *slot = Some(child);
        }
    }

    fn take(&self) -> Option<CommandChild> {
        self.current.lock().ok().and_then(|mut s| s.take())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Types d'echange avec le front
// ─────────────────────────────────────────────────────────────────────────────

/// Requete de recherche. Les champs reprennent exactement ceux que
/// jocly.fairy.js envoie deja a son worker wasm (message {type:"Search"}),
/// pour que le shim JS n'ait rien a traduire.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub variant: String,
    pub fen: String,
    #[serde(default)]
    pub depth: Option<u32>,
    #[serde(default)]
    pub move_time_ms: Option<u64>,
    #[serde(default)]
    pub skill_level: Option<i32>,
    #[serde(default)]
    pub chess960: Option<bool>,
    #[serde(default)]
    pub custom_variant_ini: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub best_move_uci: String,
    pub ponder_uci: Option<String>,
    pub last_info: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Logique UCI pure (testable sans processus ni webview)
// ─────────────────────────────────────────────────────────────────────────────

/// Chemin virtuel ou est ecrite une definition de variante personnalisee.
/// Le binaire natif a un vrai systeme de fichiers : on ecrit dans un fichier
/// temporaire, dont le chemin est passe ici.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum UciLine {
    UciOk,
    ReadyOk,
    BestMove {
        mv: String,
        ponder: Option<String>,
    },
    /// `info string ERROR: ...` — Stockfish signale ainsi un echec fatal
    /// (typiquement un reseau NNUE invalide) et s'arrete ensuite : aucun
    /// bestmove ne viendra jamais. Detecte pour echouer proprement au lieu
    /// d'attendre indefiniment.
    Fatal(String),
    Info(String),
    Other,
}

/// Classe une ligne recue du moteur. Fonction pure.
pub(crate) fn classify(line: &str) -> UciLine {
    let l = line.trim();
    if l == "uciok" {
        return UciLine::UciOk;
    }
    if l == "readyok" {
        return UciLine::ReadyOk;
    }
    if let Some(rest) = l.strip_prefix("bestmove ") {
        let mut it = rest.split_whitespace();
        let mv = it.next().unwrap_or("").to_string();
        let mut ponder = None;
        // forme complete : "bestmove e2e4 ponder e7e5"
        if it.next() == Some("ponder") {
            ponder = it.next().map(|s| s.to_string());
        }
        return UciLine::BestMove { mv, ponder };
    }
    if l.starts_with("info string ERROR:") {
        return UciLine::Fatal(l.to_string());
    }
    if l.starts_with("info ") {
        return UciLine::Info(l.to_string());
    }
    UciLine::Other
}

/// Construit la sequence de commandes UCI d'une recherche, dans l'ordre
/// impose par le moteur : VariantPath AVANT UCI_Variant (c'est au moment de
/// `setoption name UCI_Variant` que la variante est resolue contre la liste
/// des variantes connues + chargees). Fonction pure.
pub(crate) fn search_commands(req: &SearchRequest, variant_path: Option<&str>) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(p) = variant_path {
        out.push(format!("setoption name VariantPath value {}", p));
    }
    out.push(format!("setoption name UCI_Variant value {}", req.variant));
    if let Some(s) = req.skill_level {
        out.push(format!("setoption name Skill Level value {}", s));
    }
    if req.chess960.unwrap_or(false) {
        out.push("setoption name UCI_Chess960 value true".to_string());
    }
    out.push("isready".to_string());
    out.push(format!("position fen {}", req.fen));
    match req.move_time_ms {
        Some(ms) if ms > 0 => out.push(format!("go movetime {}", ms)),
        _ => out.push(format!("go depth {}", req.depth.unwrap_or(12))),
    }
    out
}

/// Budget total accorde a une recherche avant abandon.
pub(crate) fn search_budget(req: &SearchRequest) -> Duration {
    match req.move_time_ms {
        Some(ms) if ms > 0 => Duration::from_millis(ms) + SEARCH_GRACE,
        // `go depth N` n'a pas de duree bornee par construction : on accorde
        // une enveloppe large mais FINIE, pour ne jamais figer l'interface.
        _ => SEARCH_GRACE + Duration::from_secs(40),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Commandes Tauri
// ─────────────────────────────────────────────────────────────────────────────

/// Lit les lignes du moteur jusqu'a ce que `f` renvoie Some, ou expiration.
async fn read_until<T, F>(
    rx: &mut tauri::async_runtime::Receiver<CommandEvent>,
    timeout: Duration,
    mut f: F,
) -> Result<T, String>
where
    F: FnMut(&str) -> Option<Result<T, String>>,
{
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err("engine timed out".into());
        }
        let ev = match tokio::time::timeout(remaining, rx.recv()).await {
            Err(_) => return Err("engine timed out".into()),
            Ok(None) => return Err("engine exited unexpectedly".into()),
            Ok(Some(ev)) => ev,
        };
        let text = match ev {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                String::from_utf8_lossy(&bytes).to_string()
            }
            CommandEvent::Terminated(_) => return Err("engine exited unexpectedly".into()),
            _ => continue,
        };
        for line in text.lines() {
            if let Some(res) = f(line) {
                return res;
            }
        }
    }
}

/// Verifie que le moteur natif est present et repond en UCI. Utilise par le front
/// pour decider s'il peut proposer le niveau Expert ; en cas d'echec, jocly
/// se rabat sur son IA native (et Tabulon affiche le bandeau d'avertissement).
#[tauri::command]
pub async fn engine_probe(app: AppHandle) -> Result<String, String> {
    let path = engine_path().ok_or_else(|| "moteur natif introuvable".to_string())?;
    let (mut rx, mut child) = app
        .shell()
        .command(&path)
        .spawn()
        .map_err(|e| format!("moteur non demarrable ({}): {}", path.display(), e))?;

    let mut name = String::new();
    child.write(b"uci\n").map_err(|e| e.to_string())?;
    let res = read_until(&mut rx, HANDSHAKE_TIMEOUT, |line| {
        if let Some(rest) = line.trim().strip_prefix("id name ") {
            name = rest.to_string();
        }
        match classify(line) {
            UciLine::UciOk => Some(Ok(())),
            _ => None,
        }
    })
    .await;
    let _ = child.kill();
    res?;
    Ok(if name.is_empty() {
        "Fairy-Stockfish".to_string()
    } else {
        name
    })
}

#[tauri::command]
pub async fn engine_search(
    app: AppHandle,
    state: State<'_, EngineState>,
    request: SearchRequest,
) -> Result<SearchResult, String> {
    // Variante personnalisee : le binaire natif lit un vrai fichier.
    let mut variant_file: Option<std::path::PathBuf> = None;
    if let Some(ini) = req_ini(&request) {
        let mut p = std::env::temp_dir();
        p.push(format!("tabulon-variant-{}.ini", std::process::id()));
        std::fs::write(&p, ini).map_err(|e| format!("ecriture variante: {}", e))?;
        variant_file = Some(p);
    }

    let path = engine_path().ok_or_else(|| "moteur natif introuvable".to_string())?;
    let (mut rx, mut child) = app
        .shell()
        .command(&path)
        .spawn()
        .map_err(|e| format!("moteur non demarrable ({}): {}", path.display(), e))?;

    child.write(b"uci\n").map_err(|e| e.to_string())?;
    read_until(&mut rx, HANDSHAKE_TIMEOUT, |line| match classify(line) {
        UciLine::UciOk => Some(Ok(())),
        _ => None,
    })
    .await?;

    let path_str = variant_file.as_ref().map(|p| p.to_string_lossy().to_string());
    for c in search_commands(&request, path_str.as_deref()) {
        child
            .write(format!("{}\n", c).as_bytes())
            .map_err(|e| e.to_string())?;
    }

    let budget = search_budget(&request);
    // Le handle est publie APRES l'envoi du `go` : engine_stop ne peut pas
    // tuer un processus qui n'a pas encore recu son ordre de recherche.
    state.set(child);

    let mut last_info: Option<String> = None;
    let outcome = read_until(&mut rx, budget, |line| match classify(line) {
        UciLine::Info(i) => {
            last_info = Some(i);
            None
        }
        UciLine::Fatal(msg) => Some(Err(format!(
            "le moteur a rejete sa configuration et s'est arrete: {}",
            msg
        ))),
        UciLine::BestMove { mv, ponder } => Some(Ok((mv, ponder))),
        _ => None,
    })
    .await;

    if let Some(c) = state.take() {
        let _ = c.kill();
    }
    if let Some(p) = variant_file {
        let _ = std::fs::remove_file(p);
    }

    let (best_move_uci, ponder_uci) = outcome?;
    Ok(SearchResult {
        best_move_uci,
        ponder_uci,
        last_info,
    })
}

fn req_ini(req: &SearchRequest) -> Option<&str> {
    req.custom_variant_ini
        .as_deref()
        .filter(|s| !s.trim().is_empty())
}

/// Interrompt la recherche en cours, s'il y en a une. Tuer le processus est
/// suffisant et plus sur qu'un `stop` UCI : le modele est un processus par
/// recherche, il n'y a donc aucun etat a preserver.
#[tauri::command]
pub async fn engine_stop(state: State<'_, EngineState>) -> Result<(), String> {
    if let Some(child) = state.take() {
        let _ = child.kill();
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> SearchRequest {
        SearchRequest {
            variant: "chess".into(),
            fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".into(),
            depth: None,
            move_time_ms: None,
            skill_level: None,
            chess960: None,
            custom_variant_ini: None,
        }
    }

    #[test]
    fn classifie_les_lignes_uci() {
        assert_eq!(classify("uciok"), UciLine::UciOk);
        assert_eq!(classify(" readyok "), UciLine::ReadyOk);
        assert_eq!(
            classify("bestmove e2e4 ponder e7e5"),
            UciLine::BestMove {
                mv: "e2e4".into(),
                ponder: Some("e7e5".into())
            }
        );
        assert_eq!(
            classify("bestmove e7e8q"),
            UciLine::BestMove {
                mv: "e7e8q".into(),
                ponder: None
            }
        );
        // Position terminale : le moteur repond "(none)", jocly sait le lire.
        assert_eq!(
            classify("bestmove (none)"),
            UciLine::BestMove {
                mv: "(none)".into(),
                ponder: None
            }
        );
    }

    #[test]
    fn detecte_l_erreur_fatale_avant_toute_ligne_info() {
        // Doit primer sur la branche "info ", sinon un NNUE invalide serait
        // pris pour une ligne d'analyse et la recherche attendrait pour rien.
        match classify("info string ERROR: NNUE evaluation used, but the network file is missing") {
            UciLine::Fatal(_) => {}
            other => panic!("attendu Fatal, obtenu {:?}", other),
        }
        match classify("info depth 12 score cp 31 pv e2e4") {
            UciLine::Info(_) => {}
            other => panic!("attendu Info, obtenu {:?}", other),
        }
    }

    #[test]
    fn go_depth_par_defaut_quand_aucun_budget() {
        let c = search_commands(&req(), None);
        assert_eq!(c.last().unwrap(), "go depth 12");
        assert!(c.iter().any(|l| l == "setoption name UCI_Variant value chess"));
        assert!(c.iter().any(|l| l == "isready"));
        assert!(!c.iter().any(|l| l.contains("VariantPath")));
    }

    #[test]
    fn movetime_prime_sur_depth() {
        let mut r = req();
        r.depth = Some(20);
        r.move_time_ms = Some(1500);
        assert_eq!(search_commands(&r, None).last().unwrap(), "go movetime 1500");
    }

    #[test]
    fn movetime_nul_retombe_sur_depth() {
        let mut r = req();
        r.depth = Some(8);
        r.move_time_ms = Some(0);
        assert_eq!(search_commands(&r, None).last().unwrap(), "go depth 8");
    }

    #[test]
    fn variant_path_precede_uci_variant() {
        let c = search_commands(&req(), Some("/tmp/v.ini"));
        let ip = c.iter().position(|l| l.contains("VariantPath")).unwrap();
        let iv = c.iter().position(|l| l.contains("UCI_Variant")).unwrap();
        assert!(ip < iv, "VariantPath doit preceder UCI_Variant");
    }

    #[test]
    fn options_facultatives_absentes_par_defaut() {
        let c = search_commands(&req(), None);
        assert!(!c.iter().any(|l| l.contains("Skill Level")));
        assert!(!c.iter().any(|l| l.contains("UCI_Chess960")));

        let mut r = req();
        r.skill_level = Some(7);
        r.chess960 = Some(true);
        let c = search_commands(&r, None);
        assert!(c.iter().any(|l| l == "setoption name Skill Level value 7"));
        assert!(c.iter().any(|l| l == "setoption name UCI_Chess960 value true"));
    }

    #[test]
    fn le_budget_est_toujours_fini() {
        // Garantie centrale de ce module : aucune recherche ne peut figer
        // l'interface, contrairement a la voie wasm qu'il remplace.
        let mut r = req();
        assert!(search_budget(&r) > Duration::from_secs(0));
        r.move_time_ms = Some(2000);
        assert!(search_budget(&r) >= Duration::from_millis(2000));
        assert!(search_budget(&r) < Duration::from_secs(3600));
    }
}
