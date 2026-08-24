// src-tauri/src/commands/fs_cmds.rs
//
// Accès aux fichiers locaux depuis les renderers WebView.
//
// Contexte : info.js chargeait les fichiers HTML de règles (rules.html,
// description.html, credits.html) via XMLHttpRequest vers file://.
// Tauri bloque les requêtes file:// depuis la WebView par conception.
//
// Solution : la commande read_text_file lit le fichier côté Rust et
// retourne son contenu en String. info.js l'appelle via tRpc.call().
//
// Sécurité : les chemins autorisés sont limités aux répertoires déclarés
// dans tauri.conf.json sous plugins.fs.scope.allow.
// En pratique, les fichiers de règles Jocly sont dans l'AppDir (assets
// bundlés) ou dans les répertoires de l'utilisateur ($DOCUMENT, $HOME).

use std::fs;
use std::path::Path;

/// Lit un fichier texte (UTF-8) et retourne son contenu.
///
/// Utilisé par :
///   - info.js     : charge rules.html / description.html / credits.html
///                   depuis config.view.fullPath (répertoire asset Jocly)
///
/// Le chemin est validé : il doit être absolu et pointer vers un fichier
/// existant. Le scope de tauri-plugin-fs applique en plus une whitelist
/// de répertoires autorisés (définie dans tauri.conf.json).
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let p = Path::new(&path);

    // Refuser les chemins relatifs (évite les traversals naïfs)
    if !p.is_absolute() {
        return Err(format!("read_text_file: path must be absolute, got '{path}'"));
    }

    fs::read_to_string(p)
        .map_err(|e| format!("read_text_file: cannot read '{path}': {e}"))
}

/// Parse un fichier PJN/PGN/PDN et retourne la liste des parties.
/// Utilisé par jb-controller.js::openBook() car PJNParser.js n'est
/// pas disponible dans la fenêtre hub (pas de <script> tag Jocly).
///
/// Format PJN = PGN étendu Jocly. On lit les tags et on découpe les parties.
/// Le parsing fin (coups) est fait par PJNParser.js dans book-history.html.
#[tauri::command]
pub fn parse_pjn(data: String) -> Result<Vec<serde_json::Value>, String> {
    let mut matches = Vec::new();
    let mut offset  = 0usize;

    // Les PGN du monde réel sont souvent en fins de ligne Windows (\r\n) et
    // séparent parfois les parties par plusieurs lignes vides : sans cette
    // normalisation, split("\n\n") ne trouve aucun bloc et le parsing
    // retourne une liste vide ("Loading..." éternel dans la fenêtre book).
    let data = data.replace("\r\n", "\n").replace('\r', "\n");
    // Découper par blocs de tags + coups (séparés par lignes vides),
    // en ignorant les blocs vides issus de lignes vides consécutives
    let blocks: Vec<&str> = data
        .split("\n\n")
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .collect();
    let mut i = 0;
    while i < blocks.len() {
        let tag_block = blocks[i].trim();

        if tag_block.starts_with('[') {
            // Tout ce qui suit les tags JUSQU'AU PROCHAIN BLOC DE TAGS, et non
            // le seul bloc suivant.
            //
            // La spécification PGN autorise des commentaires entre l'en-tête
            // et les coups, et ChuShogiLite en met un : un diagramme du
            // plateau, entouré d'accolades et séparé par des lignes vides.
            // Apparier les tags avec le seul bloc suivant donnait donc, pour
            // ces fichiers, une partie faite des tags et du diagramme — sans
            // un seul coup — et le bloc de coups, qui ne commence pas par '[',
            // était ignoré comme n'appartenant à aucune partie. La fenêtre
            // Historique restait vide sans que rien ne le signale.
            //
            // Les commentaires ne sont pas retirés ici : ExtractMoves
            // (book-format.js) sait déjà le faire, et c'est là que la marque
            // {Tsume} est relue.
            let mut j = i + 1;
            while j < blocks.len() && !blocks[j].trim_start().starts_with('[') { j += 1; }
            let move_block = blocks[i + 1..j]
                .iter()
                .map(|b| b.trim())
                .collect::<Vec<_>>()
                .join("\n\n");
            let move_block = move_block.as_str();
            // Parser les tags
            let mut tags = serde_json::Map::new();
            for line in tag_block.lines() {
                let line = line.trim();
                if let (Some(key_start), Some(key_end)) = (line.find('['), line.find(' ')) {
                    let key = &line[key_start + 1..key_end];
                    let val = line[key_end + 1..].trim_matches(|c| c == '"' || c == ']').to_string();
                    tags.insert(key.to_string(), serde_json::Value::String(val));
                }
            }

            // Construire l'objet match
            let white  = tags.get("White").and_then(|v| v.as_str()).unwrap_or("?").to_string();
            let black  = tags.get("Black").and_then(|v| v.as_str()).unwrap_or("?").to_string();
            let result = tags.get("Result").and_then(|v| v.as_str()).unwrap_or("*").to_string();

            let mut label = format!("{} vs {}", white, black);
            if result != "*" { label = format!("{} - {}", label, result); }
            label = format!("{} #{}", label, matches.len() + 1);

            let block_len = tag_block.len() + 2 + move_block.len();
            matches.push(serde_json::json!({
                "label":   label,
                "text":    format!("{}\n\n{}", tag_block, move_block),
                "playerA": white,
                "playerB": black,
                "offset":  offset,
                "length":  block_len,
                "tags":    serde_json::Value::Object(tags),
            }));
            offset += block_len + 2;
            i = j; // reprendre au prochain bloc de tags
        } else {
            offset += tag_block.len() + 2;
            i += 1;
        }
    }

    Ok(matches)
}

/// Écrit un fichier texte (UTF-8) à un chemin absolu.
///
/// Utilisé par :
///   - play.js : bouton Save — le téléchargement `data:` URI + a.click()
///     d'Electron/JoclyBoard n'a pas d'équivalent dans la WebView Tauri
///     (pas de download manager) ; on passe par le dialogue natif du
///     plugin dialog pour choisir le chemin, puis cette commande écrit.
#[tauri::command]
pub fn save_text_file(path: String, contents: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_absolute() {
        return Err(format!("save_text_file: chemin non absolu: {path}"));
    }
    fs::write(p, contents).map_err(|e| format!("save_text_file: {e}"))
}

/// Écrit un data-URI image (PNG/JPEG base64) dans un fichier binaire.
///
/// Utilisé par play.js (bouton "Take snapshot") : viewControl('takeSnapshot')
/// retourne un data-URI, et le download `a.click()` d'Electron n'existe pas
/// dans la WebView Tauri — on passe par le dialogue natif + cette commande.
#[tauri::command]
pub fn save_data_uri_file(path: String, data_uri: String) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let p = Path::new(&path);
    if !p.is_absolute() {
        return Err(format!("save_data_uri_file: chemin non absolu: {path}"));
    }
    let b64 = data_uri
        .strip_prefix("data:image/png;base64,")
        .or_else(|| data_uri.strip_prefix("data:image/jpeg;base64,"))
        .ok_or("save_data_uri_file: data-URI attendu (image/png ou image/jpeg)")?;
    let bytes = STANDARD.decode(b64).map_err(|e| format!("save_data_uri_file: base64: {e}"))?;
    fs::write(p, bytes).map_err(|e| format!("save_data_uri_file: {e}"))
}

/// Indique à l'UI si un dist/ externe est chargé, son chemin, et s'il est
/// INSCRIPTIBLE (import/désinstallation d'extensions). Le test est une
/// écriture réelle : les métadonnées de permissions mentent avec les ACL,
/// les montages en lecture seule ou les dossiers système.
/// Utilisé par l'écran Extensions / le panneau About.
#[tauri::command]
pub fn get_dist_info() -> serde_json::Value {
    match crate::dist_override::external_dist() {
        Some(p) => {
            let probe = p.join(".tabulon-write-test");
            let writable = std::fs::write(&probe, b"").is_ok();
            if writable { let _ = std::fs::remove_file(&probe); }
            serde_json::json!({
                "external": true,
                "path": p.display().to_string(),
                "writable": writable,
            })
        }
        None => serde_json::json!({ "external": false, "path": null, "writable": false }),
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    fn moves_of(m: &serde_json::Value) -> String {
        m["text"].as_str().unwrap().splitn(2, "\n\n").nth(1).unwrap_or("").to_string()
    }

    /// Le cas qui a motivé la correction : ChuShogiLite intercale un diagramme
    /// du plateau entre l'en-tête et les coups. Apparier les tags avec le seul
    /// bloc suivant donnait une partie sans aucun coup, et l'Historique restait
    /// vide sans qu'aucune erreur ne le signale.
    #[test]
    fn commentaire_entre_les_tags_et_les_coups() {
        let pgn = "[Event \"x\"]\n[Variant \"chu\"]\n\n\
                   {--------------\n. . . k\n--------------}\n\n\
                   {Tsume C22} 1. Ql1 +Mxl1 *\n";
        let matches = parse_pjn(pgn.to_string()).unwrap();
        assert_eq!(matches.len(), 1, "une seule partie");
        let body = moves_of(&matches[0]);
        assert!(body.contains("1. Ql1"), "les coups sont rattaches a la partie : {body:?}");
        assert!(body.contains("{Tsume C22}"),
            "le commentaire est conserve : c'est lui qui porte la marque tsume");
        assert!(body.contains("--------------"), "le diagramme aussi, ExtractMoves le retirera");
    }

    /// Le cas ordinaire ne doit pas changer : coups collés aux tags.
    #[test]
    fn coups_directement_apres_les_tags() {
        let pgn = "[Event \"x\"]\n[Result \"0-1\"]\n\n1. d4 b6 2. e4 Bb7 0-1\n";
        let matches = parse_pjn(pgn.to_string()).unwrap();
        assert_eq!(matches.len(), 1);
        assert!(moves_of(&matches[0]).contains("2. e4"));
    }

    /// Plusieurs parties : chacune reprend a son propre bloc de tags, et le
    /// texte libre qui suit la derniere ne fabrique pas de partie fantome.
    #[test]
    fn plusieurs_parties_et_texte_libre() {
        let pgn = "[Event \"a\"]\n\n1. e4 *\n\n\
                   [Event \"b\"]\n\n{note}\n\n1. d4 *\n\n\
                   du texte libre apres la derniere partie\n";
        let matches = parse_pjn(pgn.to_string()).unwrap();
        assert_eq!(matches.len(), 2, "deux parties, pas trois");
        assert!(moves_of(&matches[0]).contains("1. e4"));
        assert!(moves_of(&matches[0]).find("[Event \"b\"]").is_none(),
            "la premiere partie ne deborde pas sur la seconde");
        let second = moves_of(&matches[1]);
        assert!(second.contains("{note}") && second.contains("1. d4"));
        assert!(second.contains("texte libre"),
            "le texte final reste rattache a la derniere partie plutot que de disparaitre");
    }

    /// Un fichier qui ne commence pas par des tags ne produit rien plutot que
    /// de prendre sa premiere ligne pour un en-tete.
    #[test]
    fn sans_tags_aucune_partie() {
        assert!(parse_pjn("1. e4 e5\n".to_string()).unwrap().is_empty());
        assert!(parse_pjn(String::new()).unwrap().is_empty());
    }
}
