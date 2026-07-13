// commands/extension_cmds.rs — export/import/désinstallation de jeux en
// « extensions » (<jeu>.tabulon-ext), UNIQUEMENT quand un dist externe est
// actif (l'embarqué est en lecture seule dans le binaire).
//
// Une extension contient STRICTEMENT ce que la config du jeu déclare : le code
// (<jeu>-config/-model/-view.js, bundles autonomes du dist), les pages rules/
// credits/description, le thumbnail et les visuels. Les ressources partagées
// du module (css, sons, res/<set>/* sprites/textures, res/rules/*/graphs/*,
// moteurs fairy-stockfish) restent liées au MODULE : jamais exportées, jamais
// supprimées, et l'import exige que le module existe déjà dans le dist cible.
//
// Cette logique est le MIROIR de scripts/make-extension.mjs (Node, testé par
// tests/test-extensions.mjs) — garder les deux synchronisés.
use std::collections::BTreeSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const FORMAT_VERSION: u64 = 1;

// ── Préconditions & gardes ────────────────────────────────────────────────────

fn external_dist_required() -> Result<PathBuf, String> {
    crate::dist_override::external_dist()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "extensions : dist externe requis (aucun dist/ externe actif)".into())
}

/// Import/désinstallation modifient le dist externe : vérifier par une
/// écriture RÉELLE (les métadonnées mentent avec ACL/montages ro) et produire
/// un message actionnable plutôt qu'un "Permission denied" au milieu d'une
/// copie partielle.
fn writable_dist_required() -> Result<PathBuf, String> {
    let dist = external_dist_required()?;
    let probe = dist.join(".tabulon-write-test");
    match std::fs::write(&probe, b"") {
        Ok(_) => { let _ = std::fs::remove_file(&probe); Ok(dist) }
        Err(e) => Err(format!(
            "dist externe en LECTURE SEULE ({}) : droits insuffisants pour modifier '{}' — \
             déplacer le dist dans un dossier accessible en écriture ou ajuster ses permissions",
            e.kind(), dist.display()
        )),
    }
}

fn is_safe_name(n: &str) -> bool {
    !n.is_empty()
        && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !n.starts_with('-')
}

fn is_safe_rel_path(p: &str) -> bool {
    !p.is_empty()
        && !p.starts_with('/')
        && !p.contains('\\')
        && p.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

// ── Index (jocly-allgames.js) ────────────────────────────────────────────────
// Lecture via json5 (le fichier d'origine du build jocly a des clés non
// quotées) ; réécriture en JSON STRICT — toujours un littéral JS valide pour
// le loader, et relisible ensuite en json5 comme en JSON.

fn index_path(dist: &Path) -> PathBuf {
    dist.join("browser").join("jocly-allgames.js")
}

fn read_index(dist: &Path) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let p = index_path(dist);
    let raw = fs::read_to_string(&p).map_err(|e| format!("index illisible {}: {e}", p.display()))?;
    let start = raw.find("exports.games").ok_or("format d'index inattendu (exports.games absent)")?;
    let brace = raw[start..].find('{').ok_or("format d'index inattendu ('{' absent)")? + start;
    let end = raw.rfind('}').ok_or("format d'index inattendu ('}' absent)")?;
    let literal = &raw[brace..=end];
    let v: serde_json::Value =
        json5::from_str(literal).map_err(|e| format!("index non parseable (json5) : {e}"))?;
    match v {
        serde_json::Value::Object(m) => Ok(m),
        _ => Err("index inattendu : exports.games n'est pas un objet".into()),
    }
}

fn write_index(dist: &Path, games: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let p = index_path(dist);
    if p.exists() {
        fs::copy(&p, p.with_extension("js.bak")).map_err(|e| format!("sauvegarde index : {e}"))?;
    }
    let body = serde_json::to_string(&serde_json::Value::Object(games.clone()))
        .map_err(|e| format!("sérialisation index : {e}"))?;
    fs::write(&p, format!("\"use strict\";exports.games={body};\n"))
        .map_err(|e| format!("écriture index : {e}"))
}

// ── Config d'un jeu (JSON pur après `exports.config =`) ─────────────────────

fn read_game_config(dist: &Path, module: &str, game: &str) -> Result<serde_json::Value, String> {
    let p = dist.join("browser").join("games").join(module).join(format!("{game}-config.js"));
    let raw = fs::read_to_string(&p).map_err(|e| format!("config illisible {}: {e}", p.display()))?;
    let start = raw.find('{').ok_or_else(|| format!("format de config inattendu : {}", p.display()))?;
    let end = raw.rfind('}').ok_or_else(|| format!("format de config inattendu : {}", p.display()))?;
    serde_json::from_str(&raw[start..=end]).map_err(|e| format!("config non JSON {}: {e}", p.display()))
}

// ── Collecte : STRICTEMENT le déclaré ────────────────────────────────────────

fn push_lang_map(out: &mut BTreeSet<String>, v: Option<&serde_json::Value>) {
    match v {
        Some(serde_json::Value::String(s)) => { out.insert(s.clone()); }
        Some(serde_json::Value::Object(m)) => {
            for x in m.values() {
                if let serde_json::Value::String(s) = x { out.insert(s.clone()); }
            }
        }
        _ => {}
    }
}

/// Fichiers déclarés (relatifs à games/<module>/), existants seulement.
fn collect_game_files(
    dist: &Path,
    game: &str,
    declaration: &serde_json::Value,
) -> Result<(String, Vec<String>), String> {
    let module = declaration.get("module").and_then(|v| v.as_str())
        .ok_or_else(|| format!("déclaration sans module pour {game}"))?.to_string();
    if !is_safe_name(game) || !is_safe_name(&module) {
        return Err(format!("nom de jeu/module invalide : {game}/{module}"));
    }
    let cfg = read_game_config(dist, &module, game)?;
    let model = cfg.get("model");
    let view = cfg.get("view");

    let mut wanted: BTreeSet<String> = BTreeSet::new();
    wanted.insert(format!("{game}-config.js"));
    wanted.insert(format!("{game}-model.js"));
    wanted.insert(format!("{game}-view.js"));
    push_lang_map(&mut wanted, model.and_then(|m| m.get("rules")));
    push_lang_map(&mut wanted, model.and_then(|m| m.get("credits")));
    push_lang_map(&mut wanted, model.and_then(|m| m.get("description")));
    if let Some(s) = model.and_then(|m| m.get("thumbnail")).and_then(|v| v.as_str()) {
        wanted.insert(s.to_string());
    }
    if let Some(s) = declaration.get("thumbnail").and_then(|v| v.as_str()) {
        wanted.insert(s.to_string());
    }
    if let Some(serde_json::Value::Object(vis)) = view.and_then(|v| v.get("visuals")) {
        for v in vis.values() {
            match v {
                serde_json::Value::String(s) => { wanted.insert(s.clone()); }
                serde_json::Value::Array(a) => {
                    for x in a {
                        if let serde_json::Value::String(s) = x { wanted.insert(s.clone()); }
                    }
                }
                _ => {}
            }
        }
    }
    // Volontairement RIEN d'autre (ni css, ni skins[].preload, ni sons).

    let module_dir = dist.join("browser").join("games").join(&module);
    let mut files = Vec::new();
    for f in wanted {
        if !is_safe_rel_path(&f) {
            return Err(format!("chemin déclaré non sûr dans la config : {f}"));
        }
        if module_dir.join(&f).exists() {
            files.push(f);
        }
    }
    Ok((module, files))
}

// ── Commandes ────────────────────────────────────────────────────────────────

/// Jeux de l'index du dist externe (pour l'écran Extensions).
#[tauri::command]
pub fn list_extension_games() -> Result<serde_json::Value, String> {
    let dist = external_dist_required()?;
    let games = read_index(&dist)?;
    let mut out = Vec::new();
    for (name, decl) in &games {
        let module = decl.get("module").and_then(|v| v.as_str()).unwrap_or("");
        out.push(serde_json::json!({
            "name": name,
            "title": decl.get("title").and_then(|v| v.as_str()).unwrap_or(name),
            "summary": decl.get("summary").and_then(|v| v.as_str()).unwrap_or(""),
            "module": module,
        }));
    }
    Ok(serde_json::json!({ "path": dist.display().to_string(), "games": out }))
}

/// Exporte <jeu> vers destPath (.tabulon-ext).
#[tauri::command]
pub fn export_extension(app: tauri::AppHandle, game_name: String, dest_path: String) -> Result<serde_json::Value, String> {
    let dist = external_dist_required()?;
    let games = read_index(&dist)?;
    let declaration = games.get(&game_name)
        .ok_or_else(|| format!("jeu absent de l'index externe : {game_name}"))?.clone();
    let (module, files) = collect_game_files(&dist, &game_name, &declaration)?;
    if files.len() < 3 {
        return Err(format!("collecte incomplète pour {game_name} (code manquant ?)"));
    }

    let manifest = serde_json::json!({
        "formatVersion": FORMAT_VERSION,
        "game": game_name,
        "module": module,
        "title": declaration.get("title").and_then(|v| v.as_str()).unwrap_or(&game_name),
        "summary": declaration.get("summary").and_then(|v| v.as_str()).unwrap_or(""),
        "declaration": declaration,
        "files": files,
        "exportedBy": format!("tabulon {}", app.package_info().version),
    });

    let out = fs::File::create(&dest_path).map_err(|e| format!("création {dest_path}: {e}"))?;
    let mut zip = zip::ZipWriter::new(out);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("extension.json", opts).map_err(|e| e.to_string())?;
    zip.write_all(serde_json::to_string_pretty(&manifest).unwrap().as_bytes())
        .map_err(|e| e.to_string())?;
    let module_dir = dist.join("browser").join("games").join(&module);
    for f in &files {
        zip.start_file(format!("games/{module}/{f}"), opts).map_err(|e| e.to_string())?;
        let bytes = fs::read(module_dir.join(f)).map_err(|e| format!("lecture {f}: {e}"))?;
        zip.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    log::info!("extension exportée : {game_name} → {dest_path} ({} fichiers)", files.len());
    Ok(serde_json::json!({ "game": game_name, "files": files.len(), "path": dest_path }))
}

/// Importe un .tabulon-ext dans le dist externe (ajout ou mise à jour).
#[tauri::command]
pub fn import_extension(src_path: String) -> Result<serde_json::Value, String> {
    let dist = writable_dist_required()?;
    let f = fs::File::open(&src_path).map_err(|e| format!("ouverture {src_path}: {e}"))?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| format!("archive invalide : {e}"))?;

    // 1. Manifeste
    let manifest: serde_json::Value = {
        let mut entry = zip.by_name("extension.json")
            .map_err(|_| "extension.json absent de l'archive")?;
        let mut s = String::new();
        entry.read_to_string(&mut s).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).map_err(|e| format!("manifeste invalide : {e}"))?
    };
    let version = manifest.get("formatVersion").and_then(|v| v.as_u64()).unwrap_or(0);
    if version != FORMAT_VERSION {
        return Err(format!("formatVersion {version} non supporté (attendu {FORMAT_VERSION})"));
    }
    let game = manifest.get("game").and_then(|v| v.as_str())
        .ok_or("manifeste sans nom de jeu")?.to_string();
    let module = manifest.get("module").and_then(|v| v.as_str())
        .ok_or("manifeste sans module")?.to_string();
    let declaration = manifest.get("declaration").cloned()
        .ok_or("manifeste sans déclaration d'index")?;
    if !is_safe_name(&game) || !is_safe_name(&module) {
        return Err(format!("nom de jeu/module invalide : {game}/{module}"));
    }
    let files: Vec<String> = manifest.get("files").and_then(|v| v.as_array())
        .ok_or("manifeste sans liste de fichiers")?
        .iter().filter_map(|v| v.as_str().map(String::from)).collect();
    if files.is_empty() { return Err("manifeste : liste de fichiers vide".into()); }
    for fpath in &files {
        if !is_safe_rel_path(fpath) { return Err(format!("chemin non sûr dans le manifeste : {fpath}")); }
    }

    // 2. Le MODULE doit déjà être présent (ressources partagées : css, sons,
    //    res/, moteurs). Une extension n'installe jamais un module.
    let module_dir = dist.join("browser").join("games").join(&module);
    if !module_dir.is_dir() {
        return Err(format!("module '{module}' absent du dist externe — installer d'abord un dist contenant ce module"));
    }

    // 3. Extraction, bornée aux fichiers du manifeste sous games/<module>/.
    let updated = read_index(&dist)?.contains_key(&game);
    for fpath in &files {
        let entry_name = format!("games/{module}/{fpath}");
        let mut entry = zip.by_name(&entry_name)
            .map_err(|_| format!("fichier du manifeste absent de l'archive : {entry_name}"))?;
        let dst = module_dir.join(fpath);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        fs::write(&dst, bytes).map_err(|e| format!("écriture {}: {e}", dst.display()))?;
    }

    // 4. Index : ajout/remplacement de la déclaration (avec .bak).
    let mut games = read_index(&dist)?;
    games.insert(game.clone(), declaration);
    write_index(&dist, &games)?;
    log::info!("extension importée : {game} (module {module}, {} fichiers, {})",
        files.len(), if updated { "mise à jour" } else { "ajout" });
    Ok(serde_json::json!({ "game": game, "module": module, "files": files.len(), "updated": updated }))
}

/// Désinstalle <jeu> : retrait de l'index + suppression de SES fichiers
/// déclarés. Les ressources partagées du module ne sont jamais touchées, et un
/// fichier encore déclaré par un AUTRE jeu du module est conservé.
#[tauri::command]
pub fn remove_extension(game_name: String) -> Result<serde_json::Value, String> {
    let dist = writable_dist_required()?;
    let mut games = read_index(&dist)?;
    let declaration = games.get(&game_name)
        .ok_or_else(|| format!("jeu absent de l'index externe : {game_name}"))?.clone();
    let (module, files) = collect_game_files(&dist, &game_name, &declaration)?;

    // Fichiers déclarés par les autres jeux du même module → à préserver.
    let mut kept_elsewhere: BTreeSet<String> = BTreeSet::new();
    for (other, decl) in &games {
        if other == &game_name { continue; }
        if decl.get("module").and_then(|v| v.as_str()) != Some(module.as_str()) { continue; }
        if let Ok((_, other_files)) = collect_game_files(&dist, other, decl) {
            kept_elsewhere.extend(other_files);
        }
    }

    let module_dir = dist.join("browser").join("games").join(&module);
    let mut removed = 0usize;
    for f in &files {
        if kept_elsewhere.contains(f) { continue; }
        if fs::remove_file(module_dir.join(f)).is_ok() { removed += 1; }
    }
    games.remove(&game_name);
    write_index(&dist, &games)?;
    log::info!("extension désinstallée : {game_name} ({removed} fichiers supprimés)");
    Ok(serde_json::json!({ "game": game_name, "removed": removed }))
}
