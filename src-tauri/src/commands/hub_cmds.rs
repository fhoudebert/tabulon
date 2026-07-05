// src-tauri/src/commands/hub_cmds.rs
//
// Commandes liées à la fenêtre hub :
//   - get_app_info          remplace require('../package.json')
//   - notify_user_response  (réponse au pattern notifyUser Promise)
//
// Pattern notifyUser (le seul cas de réponse renderer→main bloquant) :
//
//   Rust                        hub.js
//   ────                        ──────
//   émet "notifyUser" + token   listen("notifyUser", handler)
//                          ←    affiche bannière, attend clic
//   attend sur channel     ←    invoke("notify_user_response", {token, result})
//   résout Future               ferme bannière
//
// NB: remove_engine / remove_template / load_board_state / book_history_view
// ne sont PAS gérées ici : ce sont des actions métier qui appartiennent au
// SharedWorker (controller.removeEngine, controller.removeTemplate, etc.
// dans match-worker.js), exposées via match_cmds.rs/template_cmds.rs et
// dispatch_to_worker(), pas dupliquées localement en Rust.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

// ── AppInfo ───────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct AppInfo {
    pub name:     String,
    pub version:  String,
    pub homepage: String,
}

/// Remplace require('../package.json') dans hub.js
#[tauri::command]
pub fn get_app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        name:     app.package_info().name.clone(),
        version:  app.package_info().version.to_string(),
        homepage: "https://github.com/fhoudebert/biscandine".into(),
    }
}

// ── notifyUser Promise pattern ────────────────────────────────────────────────
//
// Problème : hub.js fait rpc.listen({ notifyUser: fn }) où fn retourne une
// Promise. L'ancien rpc.js attendait cette Promise avant d'envoyer la réponse
// au main. Dans Tauri, les events sont fire-and-forget. On simule le pattern
// avec un token + channel oneshot stocké dans un état global.

/// Requête de confirmation envoyée à l'utilisateur via la bannière du hub.
/// `ok_text`/`ko_text` sont les libellés des deux boutons ; si l'un des deux
/// est `None`, le bouton correspondant n'est pas affiché côté hub.js.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyRequest {
    pub text: String,
    pub ok_text: Option<String>,
    pub ko_text: Option<String>,
}

pub struct NotifyChannels {
    pub pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

impl Default for NotifyChannels {
    fn default() -> Self {
        Self { pending: Mutex::new(HashMap::new()) }
    }
}

/// Appelé par le Rust interne pour déclencher une notification hub
/// et attendre la réponse utilisateur.
/// Émet l'event "notifyUser" + token vers la fenêtre main,
/// puis attend sur un channel oneshot.
pub async fn push_notify_user(
    app: &AppHandle,
    channels: &NotifyChannels,
    text: &str,
    ok_text: &str,
    ko_text: &str,
) -> bool {
    let token = format!("notify-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());

    let (tx, rx) = oneshot::channel::<bool>();
    {
        let mut pending = channels.pending.lock().unwrap();
        pending.insert(token.clone(), tx);
    }

    let _ = app.emit_to("main", "notifyUser", serde_json::json!({
        "token":   token,
        "text":    text,
        "okText":  ok_text,
        "koText":  ko_text
    }));

    rx.await.unwrap_or(false)
}

/// invoke("notify_user_response", { token, result })
/// Appelé par hub.js quand l'utilisateur clique OK ou Annuler.
#[tauri::command]
pub fn notify_user_response(
    channels: State<NotifyChannels>,
    token: String,
    result: bool,
) -> Result<(), String> {
    let mut pending = channels.pending.lock().unwrap();
    if let Some(tx) = pending.remove(&token) {
        let _ = tx.send(result);
    }
    Ok(())
}
