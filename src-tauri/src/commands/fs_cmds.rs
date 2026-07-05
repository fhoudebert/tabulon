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
        let tag_block  = blocks[i].trim();
        let move_block = if i + 1 < blocks.len() { blocks[i + 1].trim() } else { "" };

        if tag_block.starts_with('[') {
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
            i += 2; // sauter le bloc coups
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
