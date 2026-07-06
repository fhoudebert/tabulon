// src-tauri/src/commands/template_cmds.rs
//
// Templates de partie (joueurs + horloge + options de vue sauvegardés sous un
// nom). Le SharedWorker ayant été supprimé (Jocly tourne directement dans
// chaque fenêtre play.html), les templates sont maintenant gérés directement
// via le store Tauri côté Rust, comme les favoris dans match_cmds.rs.
//
// Les données d'un template viennent de play.js via le protocole satellite
// (get-template-data) : save-template.html les récupère puis les passe ici.
// Forme : { gameName, gameData: <match.save()>, clock?, lastUsed }.
// Chaque mutation émet le push "updateTemplates" pour rafraîchir le hub.

use serde_json::Value;
use tauri::{AppHandle, Emitter};
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
    let _ = match_id; // l'id ne sert qu'au titre de la fenêtre ; les données font foi
    let value = data.ok_or("save_template: données du template manquantes (get-template-data)")?;
    templates.insert(name, value);
    store.set("templates", Value::Object(templates.clone()));
    store.save().map_err(|e| e.to_string())?;
    let _ = app.emit("updateTemplates", Value::Object(templates));
    Ok(())
}

#[tauri::command]
pub fn play_template(
    app: AppHandle,
    template_name: String,
) -> Result<Value, String> {
    let store = app.store("tabulon.json").map_err(|e| e.to_string())?;
    let mut templates = store.get("templates")
        .and_then(|v| if let Value::Object(m) = v { Some(m) } else { None })
        .unwrap_or_default();
    let mut tpl = templates.get(&template_name)
        .cloned()
        .ok_or_else(|| format!("Template not found: {template_name}"))?;
    // Marquer l'usage (tri "dernier utilisé" du hub) et notifier
    if let Value::Object(ref mut m) = tpl {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64).unwrap_or(0);
        m.insert("lastUsed".into(), Value::Number(serde_json::Number::from(now)));
        templates.insert(template_name, tpl.clone());
        store.set("templates", Value::Object(templates.clone()));
        let _ = store.save();
        let _ = app.emit("updateTemplates", Value::Object(templates));
    }
    Ok(tpl)
}

#[tauri::command]
pub fn remove_template(app: AppHandle, template_name: String) -> Result<(), String> {
    let store = app.store("tabulon.json").map_err(|e| e.to_string())?;
    let mut templates = store.get("templates")
        .and_then(|v| if let Value::Object(m) = v { Some(m) } else { None })
        .unwrap_or_default();
    templates.remove(&template_name);
    store.set("templates", Value::Object(templates.clone()));
    store.save().map_err(|e| e.to_string())?;
    let _ = app.emit("updateTemplates", Value::Object(templates));
    Ok(())
}
