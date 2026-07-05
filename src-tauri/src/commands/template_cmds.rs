// src-tauri/src/commands/template_cmds.rs
//
// Templates de partie (joueurs + horloge + options de vue sauvegardés sous un
// nom). Le SharedWorker ayant été supprimé (Jocly tourne directement dans
// chaque fenêtre play.html), les templates sont maintenant gérés directement
// via le store Tauri côté Rust, comme les favoris dans match_cmds.rs.
//
// TODO : save_template doit recevoir les données à sauvegarder depuis play.js
// plutôt que d'essayer de lire l'état d'un match côté Rust — à câbler quand
// la fenêtre save-template.html sera connectée au nouveau flow.

use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

#[tauri::command]
pub fn is_template_name_valid(app: AppHandle, name: String) -> Result<bool, String> {
    let store = app.store("tabulon.json").map_err(|e| e.to_string())?;
    let templates = store.get("templates")
        .and_then(|v| if let Value::Object(m) = v { Some(m) } else { None })
        .unwrap_or_default();
    // Un nom est valide s'il n'est pas déjà pris
    Ok(!templates.contains_key(&name))
}

#[tauri::command]
pub fn save_template(
    app: AppHandle,
    match_id: u32,
    name: String,
    data: Option<Value>,
) -> Result<(), String> {
    let store = app.store("tabulon.json").map_err(|e| e.to_string())?;
    let mut templates = store.get("templates")
        .and_then(|v| if let Value::Object(m) = v { Some(m) } else { None })
        .unwrap_or_default();
    templates.insert(name, data.unwrap_or(serde_json::json!({ "matchId": match_id })));
    store.set("templates", Value::Object(templates));
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn play_template(
    app: AppHandle,
    template_name: String,
) -> Result<Value, String> {
    let store = app.store("tabulon.json").map_err(|e| e.to_string())?;
    let templates = store.get("templates")
        .and_then(|v| if let Value::Object(m) = v { Some(m) } else { None })
        .unwrap_or_default();
    templates.get(&template_name)
        .cloned()
        .ok_or_else(|| format!("Template not found: {template_name}"))
}

#[tauri::command]
pub fn remove_template(app: AppHandle, template_name: String) -> Result<(), String> {
    let store = app.store("tabulon.json").map_err(|e| e.to_string())?;
    let mut templates = store.get("templates")
        .and_then(|v| if let Value::Object(m) = v { Some(m) } else { None })
        .unwrap_or_default();
    templates.remove(&template_name);
    store.set("templates", Value::Object(templates));
    store.save().map_err(|e| e.to_string())
}
