// src-tauri/src/commands/katago_cmds.rs
//
// Pilote du moteur de GO natif **KataGo**, troisieme pendant de
// engine_cmds.rs (Fairy-Stockfish) et scan_cmds.rs (Scan) : meme raison
// d'etre, meme modele de processus, meme repli silencieux sur l'IA native
// quand le binaire est absent.
//
// TROIS DIFFERENCES DE FOND, sources de bugs si on transpose betement :
//
// 1. **KataGo ne peut pas demarrer sans son reseau.** Fairy-Stockfish sans
//    NNUE tourne en evaluation classique -- un reseau manquant y est un
//    detail. KataGo, lui, ne joue pas du tout : `-model` est un argument de
//    lancement, pas une option de recherche. Un reseau absent est donc un
//    echec de `katago_probe`, pas un mode degrade.
//
// 2. **La position n'est pas un FEN mais la suite des coups.** jocly
//    (src/core/jocly.kata.js) envoie `moves: [{loc, col}]` -- c'est ce que
//    demande l'ABI wasm, qui rejoue la partie elle-meme. En GTP cela devient
//    une suite de `play`, et `loc` doit etre traduit en coordonnee GTP.
//    C'est loc_to_gtp/gtp_to_loc ci-dessous, et la seule partie de ce module
//    ou une erreur produirait un coup silencieusement FAUX plutot qu'une
//    panne visible -- d'ou les tests.
//
//    La convention retenue est celle de jocly lui-meme (go-model.js,
//    CoordToString) : colonnes A..T sans I de gauche a droite, lignes
//    numerotees depuis le BAS, `loc = ligne_depuis_le_haut * taille +
//    colonne`. Le pont wasm, lui, passe `loc` tel quel a KataGo sans trancher
//    le sens de l'axe -- il peut se le permettre, les deux conventions ne
//    different que d'une reflexion appliquee a l'aller comme au retour. Ici
//    le texte GTP fixe le sens, donc il faut choisir, et c'est celui que le
//    joueur voit a l'ecran.
//
// 3. **KataGo exige un fichier de configuration.** `katago gtp` refuse de
//    demarrer sans `-config`. On attend donc `katago.cfg` A COTE DU BINAIRE,
//    comme Scan attend son `scan.ini` et son `data/`, et le processus est
//    lance AVEC LE REPERTOIRE DU BINAIRE comme repertoire courant pour que
//    les chemins relatifs de cette config fonctionnent. Absent, on le dit
//    plutot que d'en fabriquer un : une config devinee ferait jouer le moteur
//    avec des reglages que personne n'a choisis.
//
// UN PROCESSUS PAR RECHERCHE, comme les deux autres -- mais c'est ici que le
// compromis merite d'etre repese. Fairy-Stockfish demarre en quelques
// millisecondes ; KataGo doit charger son reseau, ce qui se compte en
// secondes sur un CPU. Si cela se revele penible a l'usage, la voie est un
// processus persistant pilote en GTP (`clear_board` entre deux parties), au
// prix de l'etat partage que les commentaires de engine_cmds.rs mettent en
// garde. A mesurer avant de decider.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_shell::ShellExt;

use super::engine_cmds::{binary_path, eval_file_candidate, read_until, EngineState};

const KATAGO_BIN: &str = "katago";
/// Nom du fichier de configuration attendu a cote du binaire.
const KATAGO_CFG: &str = "katago.cfg";
/// Chargement du reseau compris : nettement plus long qu'une poignee de main UCI.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);
const SEARCH_GRACE: Duration = Duration::from_secs(30);

/// Colonnes GTP : l'alphabet SANS le I, convention universelle du go.
const COLUMNS: &[u8] = b"ABCDEFGHJKLMNOPQRSTUVWXYZ";

/// Regle appliquee quand le front n'en declare aucune.
///
/// C'est celle que `go-model.js` arbitre : comptage par aire, superko
/// POSITIONNEL, suicide interdit -- ce que KataGo appelle `chinese-ogs` et
/// non `chinese`, dont le preset utilise le ko SIMPLE.
const KATAGO_RULES_DEFAULT: &str = "chinese-ogs";

/// Les presets acceptes par `kata-set-rules`.
///
/// Filtre ici plutot que de laisser passer : un nom inconnu ferait repondre
/// `?` au moteur, et comme cette commande-la est TOLERANTE a l'echec (voir
/// `katago_search`) la partie continuerait silencieusement sous la regle du
/// fichier de configuration -- exactement ce que ce module cherche a ne plus
/// laisser au hasard. Une faute de frappe doit donc echouer avant le
/// lancement, comme une taille de goban impossible.
/// Rang de la reponse a `kata-set-rules` dans le dialogue GTP.
///
/// gtp_script la met en tete, et katago_search compte les reponses pour
/// trouver celle du genmove : la boucle a besoin de ce rang pour tolerer un
/// echec sur cette commande-la et sur aucune autre. Les deux moities sont
/// verifiees par les tests de ce module.
const RULES_CMD_POSITION: usize = 1;

const KATAGO_RULESETS: &[&str] = &[
    "tromp-taylor",
    "chinese",
    "chinese-ogs",
    "chinese-kgs",
    "japanese",
    "korean",
    "stone-scoring",
    "aga",
    "bga",
    "new-zealand",
];

/// Chemin du binaire KataGo, ou None s'il n'est pas installe.
pub fn katago_path() -> Option<PathBuf> {
    binary_path(KATAGO_BIN, "TABULON_KATAGO")
}

// ─────────────────────────────────────────────────────────────────────────────
// Types d'echange avec le front
// ─────────────────────────────────────────────────────────────────────────────

/// Un coup de la partie, tel que jocly.kata.js le construit :
/// `loc` = index de l'intersection (-1 pour une passe), `col` = 1 noir, 2 blanc.
#[derive(Debug, Clone, Deserialize)]
pub struct KataMove {
    pub loc: i32,
    pub col: u8,
}

/// Champs envoyes par jocly.kata.js a son worker (message {type:"Search"}),
/// plus ce que le shim retient du message Init (taille du goban, reseau) :
/// KataGo a besoin des deux au LANCEMENT, la ou Fairy-Stockfish resout son
/// NNUE au moment de la recherche.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KataSearchRequest {
    #[serde(default)]
    pub moves: Vec<KataMove>,
    /// Trait : 1 noir, 2 blanc.
    pub to_play: u8,
    pub komi: f64,
    pub board_size: u32,
    #[serde(default)]
    pub visits: Option<u32>,
    #[serde(default)]
    pub move_time_ms: Option<u64>,
    /// Reseau, tel que declare par le niveau du jeu (ex. "katago-nnetwork.bin.gz").
    /// Chemin RELATIF AU BINAIRE, comme l'`evalFile` de Fairy-Stockfish.
    #[serde(default)]
    pub net: Option<String>,
    /// Les regles sous lesquelles le JEU arbitre, publiees par go-model.js et
    /// transportees par jocly.kata.js. Absentes -- vieux dist, ou hote qui ne
    /// les relaie pas -- on retombe sur KATAGO_RULES_DEFAULT plutot que sur le
    /// fichier de configuration : mieux vaut une regle connue et fausse qu'une
    /// regle inconnue.
    #[serde(default)]
    pub rules: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KataSearchResult {
    /// Index de l'intersection choisie, -1 pour une passe. jocly le retrouve
    /// dans sa propre liste de coups legaux.
    pub best_move: i32,
    /// -1 signifie aussi bien « passe » que « abandon » cote GTP ; ce champ
    /// dit lequel, pour que le front puisse le rapporter sans deviner.
    pub resigned: bool,
    pub last_info: Option<String>,
    /// Reseau effectivement passe au moteur. Les log::info! de ce module
    /// partent dans la sortie de l'application, PAS dans la console de la
    /// webview : c'est ce champ qui permet au front de dire au joueur ce qui
    /// a ete charge.
    pub net_used: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Traduction des coordonnees (pure, donc testable)
// ─────────────────────────────────────────────────────────────────────────────

/// `loc` (index d'intersection de jocly) -> coordonnee GTP ("D4", "pass").
/// Renvoie None si l'index sort du goban.
pub(crate) fn loc_to_gtp(loc: i32, size: u32) -> Option<String> {
    if loc < 0 {
        return Some("pass".to_string());
    }
    let size = size as i32;
    if size <= 0 || loc >= size * size {
        return None;
    }
    let row = loc / size; // 0 = rangee du HAUT, comme dans go-model.js
    let col = loc % size;
    let letter = *COLUMNS.get(col as usize)? as char;
    Some(format!("{}{}", letter, size - row))
}

/// L'inverse. "pass" et "resign" donnent -1 ; c'est a l'appelant de les
/// distinguer s'il en a besoin (voir KataSearchResult::resigned).
pub(crate) fn gtp_to_loc(text: &str, size: u32) -> Option<i32> {
    let t = text.trim();
    if t.eq_ignore_ascii_case("pass") || t.eq_ignore_ascii_case("resign") {
        return Some(-1);
    }
    let mut chars = t.chars();
    let letter = chars.next()?.to_ascii_uppercase();
    let col = COLUMNS.iter().position(|&c| c as char == letter)? as i32;
    let number: i32 = chars.as_str().trim().parse().ok()?;
    let size = size as i32;
    if col >= size || number < 1 || number > size {
        return None;
    }
    let row = size - number;
    Some(row * size + col)
}

/// La suite de commandes GTP qui met le moteur dans la position voulue puis
/// lui demande un coup.
///
/// `clear_board` avant tout : le modele est un processus par recherche, mais
/// le dire explicitement coute une ligne et rend la sequence lisible seule.
pub(crate) fn gtp_script(req: &KataSearchRequest) -> Result<Vec<String>, String> {
    let size = req.board_size;
    if size == 0 || size as usize > COLUMNS.len() {
        return Err(format!("taille de goban non geree : {}", size));
    }
    let rules = req.rules.as_deref().unwrap_or(KATAGO_RULES_DEFAULT);
    if !KATAGO_RULESETS.contains(&rules) {
        return Err(format!("regles KataGo inconnues : {}", rules));
    }
    /*
     * `kata-set-rules` D'ABORD, avant que le moindre coup ne soit rejoue : la
     * legalite depend de la regle. Le suicide multi-pierres est legal en
     * tromp-taylor et interdit ici, donc une partie rejouee sous la mauvaise
     * regle peut se voir refuser un `play` parfaitement valide.
     *
     * Sans cette ligne le moteur jouait sous la regle de son katago.cfg, que
     * Tabulon ne fournit pas et ne lit pas : le gtp_example.cfg de KataGo
     * porte `rules = tromp-taylor`. Le moteur pouvait donc proposer un coup
     * que jocly refuse -- cas deja prevu, et journalise, par jocly.kata.js.
     */
    let mut out = vec![
        // Position fixee par RULES_CMD_POSITION, dont depend la tolerance de
        // la boucle de lecture.
        format!("kata-set-rules {}", rules),
        format!("boardsize {}", size),
        "clear_board".to_string(),
        format!("komi {}", req.komi),
    ];
    for m in &req.moves {
        let colour = match m.col {
            1 => "b",
            2 => "w",
            other => return Err(format!("couleur inconnue : {}", other)),
        };
        let at = loc_to_gtp(m.loc, size)
            .ok_or_else(|| format!("coup hors du goban : {}", m.loc))?;
        out.push(format!("play {} {}", colour, at));
    }
    let to_play = match req.to_play {
        1 => "b",
        2 => "w",
        other => return Err(format!("trait inconnu : {}", other)),
    };
    out.push(format!("genmove {}", to_play));
    Ok(out)
}

/// Les surcharges de config passees en ligne de commande. Le budget vient du
/// niveau choisi par le joueur, pas du fichier : c'est ce qui fait la
/// difference entre « Facile » et « Fort » sans toucher a katago.cfg.
pub(crate) fn override_config(req: &KataSearchRequest) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(v) = req.visits.filter(|v| *v > 0) {
        parts.push(format!("maxVisits={}", v));
    }
    if let Some(ms) = req.move_time_ms.filter(|ms| *ms > 0) {
        parts.push(format!("maxTime={}", ms as f64 / 1000.0));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(","))
    }
}

/// Une reponse GTP : `= <valeur>` en cas de succes, `? <message>` en cas
/// d'erreur, le reste etant du bruit (lignes de log du moteur).
#[derive(Debug, PartialEq)]
pub(crate) enum GtpLine {
    Ok(String),
    Error(String),
    Noise,
}

pub(crate) fn classify_gtp(line: &str) -> GtpLine {
    let t = line.trim();
    if let Some(rest) = t.strip_prefix('=') {
        GtpLine::Ok(rest.trim_start_matches(|c: char| c.is_ascii_digit()).trim().to_string())
    } else if let Some(rest) = t.strip_prefix('?') {
        GtpLine::Error(rest.trim_start_matches(|c: char| c.is_ascii_digit()).trim().to_string())
    } else {
        GtpLine::Noise
    }
}

fn search_budget(req: &KataSearchRequest) -> Duration {
    match req.move_time_ms {
        Some(ms) if ms > 0 => Duration::from_millis(ms) + SEARCH_GRACE,
        _ => SEARCH_GRACE + Duration::from_secs(30),
    }
}

/// Le reseau et la config, resolus a cote du binaire. Les deux sont
/// obligatoires : sans reseau KataGo ne demarre pas, sans config il refuse.
fn resolve_assets(net: Option<&str>) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let path = katago_path().ok_or_else(|| "moteur KataGo introuvable".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "chemin du moteur KataGo invalide".to_string())?
        .to_path_buf();

    let net_name = net
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "aucun reseau declare par le niveau".to_string())?;
    let model = eval_file_candidate(&dir, net_name)
        .ok_or_else(|| format!("nom de reseau refuse : {}", net_name))?;
    if !model.is_file() {
        return Err(format!(
            "reseau KataGo introuvable a cote du binaire : {}",
            model.display()
        ));
    }

    let cfg = dir.join(KATAGO_CFG);
    if !cfg.is_file() {
        return Err(format!(
            "configuration KataGo introuvable : {} (KataGo refuse de demarrer sans -config)",
            cfg.display()
        ));
    }
    Ok((path, model, cfg))
}

// ─────────────────────────────────────────────────────────────────────────────
// Commandes Tauri
// ─────────────────────────────────────────────────────────────────────────────

/// Verifie que KataGo est installe, que son reseau et sa config sont a cote
/// du binaire, et qu'il repond en GTP. Renvoie son identite.
///
/// Le reseau est charge ici pour de vrai : c'est long, mais c'est le seul
/// moyen de distinguer « installe » de « installe et fonctionnel », et le
/// joueur a besoin de le savoir avant sa premiere partie, pas au premier coup.
#[tauri::command]
pub async fn katago_probe(app: AppHandle, net: Option<String>) -> Result<String, String> {
    let (path, model, cfg) = resolve_assets(net.as_deref())?;
    let dir = path.parent().unwrap().to_path_buf();

    let (mut rx, mut child) = app
        .shell()
        .command(&path)
        .args([
            "gtp",
            "-model",
            &model.to_string_lossy(),
            "-config",
            &cfg.to_string_lossy(),
        ])
        .current_dir(dir)
        .spawn()
        .map_err(|e| format!("KataGo non demarrable ({}): {}", path.display(), e))?;

    child.write(b"name\n").map_err(|e| e.to_string())?;
    let res = read_until(&mut rx, HANDSHAKE_TIMEOUT, |line| match classify_gtp(line) {
        GtpLine::Ok(v) => Some(Ok(v)),
        GtpLine::Error(m) => Some(Err(m)),
        GtpLine::Noise => None,
    })
    .await;
    let _ = child.kill();

    let name = res?;
    log::info!(
        "KataGo pret : {} (reseau {})",
        if name.is_empty() { "KataGo" } else { &name },
        model.display()
    );
    Ok(if name.is_empty() {
        "KataGo".to_string()
    } else {
        name
    })
}

#[tauri::command]
pub async fn katago_search(
    app: AppHandle,
    state: State<'_, EngineState>,
    request: KataSearchRequest,
) -> Result<KataSearchResult, String> {
    // Traduction AVANT de lancer quoi que ce soit : une position illisible
    // doit echouer tout de suite, pas apres le chargement du reseau.
    let script = gtp_script(&request)?;
    let (path, model, cfg) = resolve_assets(request.net.as_deref())?;
    let dir = path.parent().unwrap().to_path_buf();

    let mut args: Vec<String> = vec![
        "gtp".into(),
        "-model".into(),
        model.to_string_lossy().into_owned(),
        "-config".into(),
        cfg.to_string_lossy().into_owned(),
    ];
    if let Some(over) = override_config(&request) {
        args.push("-override-config".into());
        args.push(over);
    }

    let (mut rx, mut child) = app
        .shell()
        .command(&path)
        .args(args)
        .current_dir(dir)
        .spawn()
        .map_err(|e| format!("KataGo non demarrable ({}): {}", path.display(), e))?;

    // Toutes les commandes sauf la derniere sont des accuses de reception ;
    // seule `genmove` rend un coup. On les envoie d'affilee et on ne lit que
    // les reponses, GTP les rendant dans l'ordre.
    let genmove = script.len();
    for c in &script {
        child
            .write(format!("{}\n", c).as_bytes())
            .map_err(|e| e.to_string())?;
    }

    state.set(child);

    let budget = search_budget(&request) + HANDSHAKE_TIMEOUT;
    let mut seen = 0usize;
    let mut last_info: Option<String> = None;
    let outcome = read_until(&mut rx, budget, |line| {
        match classify_gtp(line) {
            GtpLine::Noise => {
                let t = line.trim();
                if !t.is_empty() {
                    last_info = Some(t.to_string());
                }
                None
            }
            GtpLine::Error(m) => {
                seen += 1;
                /*
                 * Un echec sur kata-set-rules N'ARRETE PAS la recherche.
                 *
                 * La commande est une extension GTP de KataGo : un binaire
                 * ancien repond `? unknown command`. Traiter cela comme une
                 * panne rendrait le go injouable pour qui a un vieux moteur,
                 * alors que le moteur, lui, va tres bien -- et le bandeau
                 * afficherait « le moteur n'a pas pu demarrer », ce qui serait
                 * faux. On joue donc sous la regle du katago.cfg, en le
                 * disant : last_info remonte jusqu'au front.
                 *
                 * Toute autre erreur reste fatale : un `play` refuse ou un
                 * genmove en echec veut dire que la position ou le moteur ne
                 * sont pas ce qu'on croit.
                 */
                if seen == RULES_CMD_POSITION {
                    log::warn!("kata-set-rules refuse ({}) : le moteur joue sous les regles de {}", m, KATAGO_CFG);
                    last_info = Some(format!("kata-set-rules refuse : {}", m));
                    None
                } else {
                    Some(Err(m))
                }
            }
            GtpLine::Ok(v) => {
                seen += 1;
                // La reponse qui compte est celle du genmove, c'est-a-dire la
                // derniere : les precedentes accusent boardsize, komi et les
                // coups rejoues.
                if seen == genmove {
                    Some(Ok(v))
                } else {
                    None
                }
            }
        }
    })
    .await;

    if let Some(c) = state.take() {
        let _ = c.kill();
    }

    let answer = outcome?;
    let resigned = answer.trim().eq_ignore_ascii_case("resign");
    let best_move = gtp_to_loc(&answer, request.board_size)
        .ok_or_else(|| format!("reponse GTP incomprise : {}", answer))?;

    Ok(KataSearchResult {
        best_move,
        resigned,
        last_info,
        net_used: Some(model.to_string_lossy().into_owned()),
    })
}

/// Interrompt la recherche en cours. Comme pour les deux autres moteurs,
/// tuer le processus suffit : le modele est un processus par recherche.
#[tauri::command]
pub async fn katago_stop(state: State<'_, EngineState>) -> Result<(), String> {
    if let Some(child) = state.take() {
        let _ = child.kill();
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn req(size: u32, moves: Vec<(i32, u8)>, to_play: u8) -> KataSearchRequest {
        KataSearchRequest {
            moves: moves.into_iter().map(|(loc, col)| KataMove { loc, col }).collect(),
            to_play,
            komi: 7.5,
            board_size: size,
            visits: None,
            move_time_ms: None,
            net: None,
            rules: None,
        }
    }

    // La convention doit etre celle que le joueur voit : go-model.js nomme
    // l'intersection 0 d'un goban 9x9 « A9 », et la derniere « J1 » -- J,
    // parce que le go saute le I.
    #[test]
    fn coordinates_match_what_jocly_displays() {
        assert_eq!(loc_to_gtp(0, 9).unwrap(), "A9");
        assert_eq!(loc_to_gtp(8, 9).unwrap(), "J9");
        assert_eq!(loc_to_gtp(72, 9).unwrap(), "A1");
        assert_eq!(loc_to_gtp(80, 9).unwrap(), "J1");
        assert_eq!(loc_to_gtp(40, 9).unwrap(), "E5");
        assert_eq!(loc_to_gtp(-1, 9).unwrap(), "pass");
        assert_eq!(loc_to_gtp(81, 9), None);
    }

    #[test]
    fn coordinates_round_trip() {
        for size in [9u32, 13, 19] {
            for loc in 0..(size * size) as i32 {
                let gtp = loc_to_gtp(loc, size).unwrap();
                assert_eq!(gtp_to_loc(&gtp, size), Some(loc), "{} sur {}", gtp, size);
            }
        }
    }

    #[test]
    fn pass_and_resign_are_both_no_move() {
        assert_eq!(gtp_to_loc("pass", 19), Some(-1));
        assert_eq!(gtp_to_loc("PASS", 19), Some(-1));
        assert_eq!(gtp_to_loc("resign", 19), Some(-1));
        assert_eq!(gtp_to_loc("I5", 19), None); // le I n'existe pas
        assert_eq!(gtp_to_loc("A20", 19), None);
        assert_eq!(gtp_to_loc("", 19), None);
    }

    #[test]
    fn script_replays_the_game_then_asks() {
        let s = gtp_script(&req(9, vec![(40, 1), (-1, 2), (0, 1)], 2)).unwrap();
        assert_eq!(
            s,
            vec![
                "kata-set-rules chinese-ogs",
                "boardsize 9",
                "clear_board",
                "komi 7.5",
                "play b E5",
                "play w pass",
                "play b A9",
                "genmove w",
            ]
        );
    }

    // Les regles d'abord, et AVANT le moindre `play` : la legalite en depend.
    // Le suicide multi-pierres est legal en tromp-taylor et interdit sous la
    // regle que jocly arbitre, donc une partie rejouee sous la mauvaise regle
    // peut se voir refuser un coup parfaitement valide.
    #[test]
    fn rules_are_set_before_any_move() {
        let s = gtp_script(&req(9, vec![(40, 1)], 2)).unwrap();
        assert_eq!(s[0], "kata-set-rules chinese-ogs");
        assert_eq!(
            RULES_CMD_POSITION, 1,
            "la boucle de lecture traite cette reponse a part : voir katago_search"
        );
    }

    // Sans declaration du front on ne retombe pas sur le katago.cfg -- que
    // Tabulon ne fournit pas et dont le modele livre par KataGo porte
    // tromp-taylor -- mais sur la regle que go-model.js arbitre.
    #[test]
    fn a_silent_front_still_gets_a_known_ruleset() {
        let s = gtp_script(&req(9, vec![], 1)).unwrap();
        assert_eq!(s[0], format!("kata-set-rules {}", KATAGO_RULES_DEFAULT));
        assert_eq!(KATAGO_RULES_DEFAULT, "chinese-ogs");
    }

    #[test]
    fn a_declared_ruleset_is_passed_through() {
        let mut r = req(9, vec![], 1);
        r.rules = Some("japanese".to_string());
        assert_eq!(gtp_script(&r).unwrap()[0], "kata-set-rules japanese");
    }

    // Un nom inconnu echoue AVANT le lancement. Laisse passer, il ferait
    // repondre `?` au moteur -- et comme cette reponse-la est toleree, la
    // partie continuerait sous la regle du fichier de configuration, sans que
    // personne ne l'apprenne.
    #[test]
    fn an_unknown_ruleset_is_refused_up_front() {
        let mut r = req(9, vec![], 1);
        r.rules = Some("chinoise".to_string());
        assert!(gtp_script(&r).is_err());
    }

    // Une passe est un coup de la suite, pas une absence de coup : la sauter
    // decalerait toutes les couleurs suivantes.
    #[test]
    fn a_pass_keeps_its_place() {
        let s = gtp_script(&req(9, vec![(-1, 1)], 2)).unwrap();
        assert!(s.contains(&"play b pass".to_string()));
    }

    #[test]
    fn bad_input_is_refused_rather_than_guessed() {
        assert!(gtp_script(&req(9, vec![(0, 3)], 1)).is_err()); // couleur inconnue
        assert!(gtp_script(&req(9, vec![(999, 1)], 1)).is_err()); // hors goban
        assert!(gtp_script(&req(0, vec![], 1)).is_err()); // taille absurde
        assert!(gtp_script(&req(9, vec![], 7)).is_err()); // trait inconnu
    }

    #[test]
    fn budget_comes_from_the_level() {
        let mut r = req(19, vec![], 1);
        assert_eq!(override_config(&r), None);
        r.visits = Some(400);
        assert_eq!(override_config(&r).unwrap(), "maxVisits=400");
        r.move_time_ms = Some(2500);
        assert_eq!(override_config(&r).unwrap(), "maxVisits=400,maxTime=2.5");
    }

    #[test]
    fn gtp_answers_are_classified() {
        assert_eq!(classify_gtp("= D4"), GtpLine::Ok("D4".into()));
        assert_eq!(classify_gtp("=3 pass"), GtpLine::Ok("pass".into()));
        assert_eq!(classify_gtp("? unknown command"), GtpLine::Error("unknown command".into()));
        assert_eq!(classify_gtp("KataGo v1.13 starting"), GtpLine::Noise);
        assert_eq!(classify_gtp(""), GtpLine::Noise);
    }

    // Le nom du reseau vient de la config du jeu, donc potentiellement d'une
    // extension tierce : il ne doit jamais designer un fichier hors du
    // repertoire du moteur.
    #[test]
    fn a_network_name_cannot_escape_the_engine_directory() {
        let dir = std::path::Path::new("/opt/tabulon/engine");
        assert!(eval_file_candidate(dir, "katago-nnetwork.bin.gz").is_some());
        assert!(eval_file_candidate(dir, "/etc/passwd").is_none());
        assert!(eval_file_candidate(dir, "../../secret").is_none());
    }
}
