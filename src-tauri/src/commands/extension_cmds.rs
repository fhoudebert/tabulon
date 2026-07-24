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

const FORMAT_VERSION: u64 = 2;
// v1 (sans champ "type") reste accepté en lecture : c'était le format des
// extensions de JEU avant l'ajout des extensions de MODULE.

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

/// Terser (`gulp build --prod` cote jocly) minifie les booleens : `false`
/// devient `!1` et `true` `!0`. C'est du JS valide, mais PAS du JSON5 : un
/// dist construit en mode prod faisait echouer la lecture de l'index avec
/// « index non parseable (json5) » -- constate en reel, reproduit ici sur un
/// build --prod ou 56 champs `obsolete:!1` suffisaient a tout bloquer.
/// On les retablit avant le parse, en laissant INTACT ce qui est dans une
/// chaine (un resume pourrait contenir « !1 »).
fn restore_minified_booleans(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut chars = src.chars().peekable();
    let mut quote: Option<char> = None;   // guillemet ouvrant courant
    let mut escaped = false;
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            out.push(c);
            if escaped { escaped = false; }
            else if c == '\\' { escaped = true; }
            else if c == q { quote = None; }
            continue;
        }
        match c {
            '"' | '\'' => { quote = Some(c); out.push(c); }
            '!' => match chars.peek() {
                Some('0') => { chars.next(); out.push_str("true"); }
                Some('1') => { chars.next(); out.push_str("false"); }
                _ => out.push(c),
            },
            _ => out.push(c),
        }
    }
    out
}

fn read_index(dist: &Path) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let p = index_path(dist);
    let raw = fs::read_to_string(&p).map_err(|e| format!("index illisible {}: {e}", p.display()))?;
    let start = raw.find("exports.games").ok_or("format d'index inattendu (exports.games absent)")?;
    let brace = raw[start..].find('{').ok_or("format d'index inattendu ('{' absent)")? + start;
    let end = raw.rfind('}').ok_or("format d'index inattendu ('}' absent)")?;
    let literal = &raw[brace..=end];
    let v: serde_json::Value = json5::from_str(&restore_minified_booleans(literal))
        .map_err(|e| format!("index non parseable (json5) : {e}"))?;
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

/// Resume d'un jeu tel qu'il figure dans son manifeste : soit une chaine,
/// soit un objet indexe par locale ({"en": "...", "fr": "..."}), comme le
/// champ "rules". Cote Rust on ne connait pas la langue de l'interface (ces
/// deux usages sont la liste des extensions et le manifeste d'un .tabulon-ext,
/// un artefact de distribution) : on prend l'anglais, sinon n'importe quelle
/// traduction presente -- mieux qu'une chaine vide, ce que donnait
/// `as_str()` seul sur un resume traduit. L'affichage localise se fait cote
/// interface (app/content/localized-field.js).
fn summary_text(decl: &serde_json::Value) -> String {
    match decl.get("summary") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Object(map)) => map
            .get("en")
            .and_then(|v| v.as_str())
            .or_else(|| map.values().find_map(|v| v.as_str()))
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    }
}

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
            // Resume BRUT (chaine ou objet {locale: texte}) : l'ecran
            // Extensions le localise lui-meme (pickLocalized), comme le hub.
            "summary": decl.get("summary").cloned().unwrap_or(serde_json::Value::Null),
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
        "type": "game",
        "game": game_name,
        "module": module,
        "title": declaration.get("title").and_then(|v| v.as_str()).unwrap_or(&game_name),
        "summary": summary_text(&declaration),
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
    if version == 0 || version > FORMAT_VERSION {
        return Err(format!("formatVersion {version} non supporté (max {FORMAT_VERSION})"));
    }
    // Extensions de MODULE (v2) : tout games/<module>/ + déclarations multiples.
    if manifest.get("type").and_then(|v| v.as_str()) == Some("module") {
        return import_module_extension(&dist, &mut zip, &manifest);
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
        return Err(format!("module '{module}' absent du dist externe — importer d'abord l'extension du module '{module}' (ou un dist le contenant)"));
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

/// Import d'une extension de MODULE : fusion (jamais de suppression préalable —
/// un jeu ajouté individuellement dans ce module survit, et un build
/// mono-module contient de toute façon tous les jeux du module). Le socle
/// (moteur, res/ racine, fairy-stockfish, scan/ — utile au seul checkers mais
/// maintenu au niveau jocly) n'est jamais concerné : extraction bornée au
/// PRÉFIXE games/<module>/, garde anti-traversée par entrée. Aucune exigence
/// « module présent » : le module EST la charge utile.
fn import_module_extension(
    dist: &Path,
    zip: &mut zip::ZipArchive<fs::File>,
    manifest: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let module = manifest.get("module").and_then(|v| v.as_str())
        .ok_or("manifeste module sans nom de module")?.to_string();
    if !is_safe_name(&module) {
        return Err(format!("nom de module invalide : {module}"));
    }
    let decls = manifest.get("games").and_then(|v| v.as_object())
        .ok_or("manifeste module sans table 'games'")?.clone();
    if decls.is_empty() { return Err("manifeste module : table 'games' vide".into()); }
    for (name, decl) in &decls {
        if !is_safe_name(name) { return Err(format!("nom de jeu invalide : {name}")); }
        if decl.get("module").and_then(|v| v.as_str()) != Some(module.as_str()) {
            return Err(format!("déclaration incohérente : le jeu {name} n'appartient pas au module {module}"));
        }
    }

    let prefix = format!("games/{module}/");
    let browser = dist.join("browser");
    let mut extracted = 0usize;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        let Some(rel) = name.strip_prefix(&prefix) else { continue };
        if rel.is_empty() || name.ends_with('/') { continue }
        if !is_safe_rel_path(rel) {
            return Err(format!("chemin non sûr dans l'archive : {name}"));
        }
        let dst = browser.join("games").join(&module).join(rel);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        fs::write(&dst, bytes).map_err(|e| format!("écriture {}: {e}", dst.display()))?;
        extracted += 1;
    }
    if extracted == 0 {
        return Err(format!("archive sans aucun fichier sous {prefix}"));
    }

    let mut games = read_index(dist)?;
    let mut added = 0usize;
    let mut updated = 0usize;
    for (name, decl) in decls {
        if games.insert(name, decl).is_some() { updated += 1; } else { added += 1; }
    }
    write_index(dist, &games)?;
    log::info!("module importé : {module} ({extracted} fichiers, {added} jeux ajoutés, {updated} mis à jour)");
    Ok(serde_json::json!({
        "type": "module", "module": module,
        "files": extracted, "added": added, "updated": updated,
    }))
}

/// Exporte le MODULE <module> entier vers destPath (.tabulon-ext).
#[tauri::command]
pub fn export_module(app: tauri::AppHandle, module_name: String, dest_path: String) -> Result<serde_json::Value, String> {
    let dist = external_dist_required()?;
    if !is_safe_name(&module_name) {
        return Err(format!("nom de module invalide : {module_name}"));
    }
    let index = read_index(&dist)?;
    let mut decls = serde_json::Map::new();
    for (name, decl) in &index {
        if decl.get("module").and_then(|v| v.as_str()) == Some(module_name.as_str()) {
            decls.insert(name.clone(), decl.clone());
        }
    }
    if decls.is_empty() {
        return Err(format!("aucun jeu du module '{module_name}' dans l'index externe"));
    }
    let module_dir = dist.join("browser").join("games").join(&module_name);
    if !module_dir.is_dir() {
        return Err(format!("dossier du module absent : {}", module_dir.display()));
    }

    let manifest = serde_json::json!({
        "formatVersion": FORMAT_VERSION,
        "type": "module",
        "module": module_name,
        "title": module_name,
        "games": decls,
        "exportedBy": format!("tabulon {}", app.package_info().version),
    });

    let out = fs::File::create(&dest_path).map_err(|e| format!("création {dest_path}: {e}"))?;
    let mut zip = zip::ZipWriter::new(out);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("extension.json", opts).map_err(|e| e.to_string())?;
    zip.write_all(serde_json::to_string_pretty(&manifest).unwrap().as_bytes())
        .map_err(|e| e.to_string())?;

    // Parcours récursif de games/<module>/ (tout le module-spécifique y vit).
    let mut count = 0usize;
    let mut stack = vec![module_dir.clone()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).map_err(|e| format!("lecture {}: {e}", dir.display()))? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.is_dir() { stack.push(path); continue; }
            let rel = path.strip_prefix(&module_dir).unwrap().to_string_lossy().replace('\\', "/");
            zip.start_file(format!("games/{module_name}/{rel}"), opts).map_err(|e| e.to_string())?;
            let bytes = fs::read(&path).map_err(|e| format!("lecture {}: {e}", path.display()))?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
            count += 1;
        }
    }
    zip.finish().map_err(|e| e.to_string())?;
    log::info!("module exporté : {module_name} → {dest_path} ({count} fichiers, {} jeux)", decls.len());
    Ok(serde_json::json!({ "module": module_name, "files": count, "games": decls.len(), "path": dest_path }))
}

/// Désinstalle le MODULE entier : dossier games/<module>/ + toutes les entrées
/// d'index de ses jeux. Le socle n'est jamais touché ; pas de préservation
/// croisée à calculer (tout le module-spécifique vit sous le dossier).
#[tauri::command]
pub fn remove_module(module_name: String) -> Result<serde_json::Value, String> {
    let dist = writable_dist_required()?;
    if !is_safe_name(&module_name) {
        return Err(format!("nom de module invalide : {module_name}"));
    }
    let mut games = read_index(&dist)?;
    let names: Vec<String> = games.iter()
        .filter(|(_, d)| d.get("module").and_then(|v| v.as_str()) == Some(module_name.as_str()))
        .map(|(n, _)| n.clone()).collect();
    if names.is_empty() {
        return Err(format!("aucun jeu du module '{module_name}' dans l'index externe"));
    }
    let module_dir = dist.join("browser").join("games").join(&module_name);
    fs::remove_dir_all(&module_dir)
        .map_err(|e| format!("suppression {}: {e}", module_dir.display()))?;
    for n in &names { games.remove(n); }
    write_index(&dist, &games)?;
    log::info!("module désinstallé : {module_name} ({} jeux)", names.len());
    Ok(serde_json::json!({ "module": module_name, "removed_games": names.len() }))
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

#[cfg(test)]
mod tests {
    use super::summary_text;
    use serde_json::json;
    use super::{read_index, restore_minified_booleans};

    /// Booleens minifies par terser : `!0`/`!1` -> true/false, mais JAMAIS
    /// a l'interieur d'une chaine.
    #[test]
    fn booleens_minifies_restaures() {
        assert_eq!(restore_minified_booleans("{obsolete:!1}"), "{obsolete:false}");
        assert_eq!(restore_minified_booleans("{a:!0,b:!1}"), "{a:true,b:false}");
        // contenu de chaine intact (un resume peut contenir "!1")
        assert_eq!(restore_minified_booleans(r#"{s:"prix !1 euro",o:!1}"#),
                   r#"{s:"prix !1 euro",o:false}"#);
        assert_eq!(restore_minified_booleans(r#"{s:'x !0 y'}"#), r#"{s:'x !0 y'}"#);
        // guillemet echappe : la chaine ne s'arrete pas la
        assert_eq!(restore_minified_booleans(r#"{s:"il dit \"!1\" ok",o:!0}"#),
                   r#"{s:"il dit \"!1\" ok",o:true}"#);
        // un '!' isole n'est pas touche
        assert_eq!(restore_minified_booleans("{a:!x}"), "{a:!x}");
        // rien a faire sur un index deja lisible
        assert_eq!(restore_minified_booleans(r#"{"a":false}"#), r#"{"a":false}"#);
    }

    fn index_temporaire(contenu: &str, tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tabulon-idx-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(dir.join("browser")).unwrap();
        std::fs::write(dir.join("browser/jocly-allgames.js"), contenu).unwrap();
        dir
    }

    /// Index d'un build DEV (non minifie) avec un resume traduit (objet).
    #[test]
    fn index_dev_avec_resume_traduit() {
        let dir = index_temporaire(r#""use strict";

exports.games = {
  "classic-chess": {
    "title": "Chess",
    "summary": "The most popular board game.",
    "module": "chessbase"
  },
  "rococo": {
    "title": "Rococo",
    "summary": {
      "en": "an Ultima cousin on a 10x10 board with an edge ring",
      "fr": "Un cousin de Ultima sur un tablier de 10x10 avec une bordure externe"
    },
    "module": "chessbase"
  }
};
"#, "dev");
        let r = read_index(&dir);
        std::fs::remove_dir_all(&dir).ok();
        let m = r.expect("index dev illisible");
        assert!(m.get("rococo").unwrap().get("summary").unwrap().is_object());
    }

    /// REGRESSION : index d'un build PROD (terser) -- `obsolete:!1`, clefs non
    /// quotees, tout sur une ligne. C'est ce qui provoquait « index non
    /// parseable » sur l'ecran Extensions.
    #[test]
    fn index_prod_minifie_lisible() {
        let dir = index_temporaire(
            "\"use strict\";exports.games={\"gardner-chess\":{title:\"Gardner MiniChess\",summary:\"Gardner 5x5 minichess (1969)\",module:\"chessbase\",obsolete:!1},rococo:{title:\"Rococo\",summary:{en:\"an Ultima cousin\",fr:\"Un cousin de Ultima\"},module:\"chessbase\",obsolete:!0}};", "prod");
        let r = read_index(&dir);
        std::fs::remove_dir_all(&dir).ok();
        let m = r.expect("index prod (terser) illisible");
        assert_eq!(m.get("gardner-chess").unwrap().get("obsolete").unwrap(), &json!(false));
        assert_eq!(m.get("rococo").unwrap().get("obsolete").unwrap(), &json!(true));
        assert_eq!(m.get("rococo").unwrap().get("summary").unwrap().get("fr").unwrap(),
                   &json!("Un cousin de Ultima"));
    }

    /// Resume en chaine simple : rendu tel quel (manifestes existants).
    #[test]
    fn summary_chaine_simple() {
        assert_eq!(summary_text(&json!({"summary": "an Ultima cousin"})), "an Ultima cousin");
    }

    /// Resume traduit : l'anglais est retenu cote Rust (artefact de
    /// distribution), pas une chaine vide comme avec as_str() seul.
    #[test]
    fn summary_objet_localise() {
        let decl = json!({"summary": {"en": "an Ultima cousin", "fr": "Un cousin de Ultima"}});
        assert_eq!(summary_text(&decl), "an Ultima cousin");
    }

    /// Pas d'anglais : n'importe quelle traduction plutot que rien.
    #[test]
    fn summary_objet_sans_anglais() {
        assert_eq!(summary_text(&json!({"summary": {"fr": "Un cousin"}})), "Un cousin");
    }

    /// Absent, vide ou d'un type inattendu : chaine vide, jamais de panique.
    #[test]
    fn summary_absent_ou_invalide() {
        assert_eq!(summary_text(&json!({})), "");
        assert_eq!(summary_text(&json!({"summary": {}})), "");
        assert_eq!(summary_text(&json!({"summary": 42})), "");
        assert_eq!(summary_text(&json!({"summary": null})), "");
    }
}
