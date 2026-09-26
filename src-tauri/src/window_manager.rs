// src-tauri/src/window_manager.rs
//
// Ouverture/focus des fenêtres secondaires Tauri + persistance de leur
// géométrie dans le store, et vérification de mise à jour au démarrage.
//
// Toutes les fenêtres de Tabulon sont des WebviewWindow pointant vers une
// page de app/content/*.html (servie depuis frontendDist). Le SharedWorker
// (app/worker/match-worker.js) ne peut pas créer de fenêtre lui-même : il
// demande à Rust de le faire via les commandes de match_cmds.rs/window_cmds.rs,
// qui appellent open_window() ci-dessous.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const STORE_FILE: &str = "tabulon.json";

/// Paramètres d'ouverture d'une fenêtre. `persist_key` désigne la clé sous
/// laquelle la géométrie (position + taille) est sauvegardée/restaurée dans
/// le store ; `None` signifie "ne pas persister" (fenêtres ponctuelles comme
/// les dialogues players/view-options).
pub struct WindowOptions<'a> {
    pub label: &'a str,
    pub url: &'a str,
    pub title: &'a str,
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub min_height: f64,
    pub persist_key: Option<String>,
}

/// Géométrie persistée d'une fenêtre (position + taille).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct Geometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Réglages d'ouverture optionnels, hors du cas courant (fenêtre ouverte à la
/// demande de l'utilisateur, qui prend le focus et laisse le système la placer).
#[derive(Debug, Clone, Copy)]
pub struct OpenExtras {
    /// false : ne pas prendre le focus. Pour une fenêtre ouverte d'office
    /// (l'horloge d'une partie chronométrée) : le joueur doit pouvoir jouer
    /// sur le plateau sans recliquer dessus. Certains gestionnaires de
    /// fenêtres Linux l'ignorent -- ce n'est alors pas pire qu'avant.
    pub focused: bool,
    /// Position (logique) à prendre QUAND AUCUNE géométrie n'est mémorisée.
    pub default_position: Option<(f64, f64)>,
}

impl Default for OpenExtras {
    fn default() -> Self { Self { focused: true, default_position: None } }
}

/// Ouvre une fenêtre, ou la focus si elle existe déjà sous ce label.
/// Restaure sa géométrie persistée si `persist_key` est fourni et qu'une
/// entrée existe dans le store ; sinon utilise width/height par défaut.
pub fn open_window(app: &AppHandle, opts: WindowOptions) -> tauri::Result<WebviewWindow> {
    open_window_with(app, opts, OpenExtras::default())
}

/// open_window(), avec les réglages de `OpenExtras`.
pub fn open_window_with(app: &AppHandle, opts: WindowOptions, extras: OpenExtras) -> tauri::Result<WebviewWindow> {
    if let Some(existing) = app.get_webview_window(opts.label) {
        if extras.focused { existing.set_focus()?; }
        return Ok(existing);
    }

    let mut geometry: Option<Geometry> = None;
    if let Some(ref key) = opts.persist_key {
        geometry = read_geometry(app, key);
    }

    let (width, height) = geometry
        .map(|g| (g.width, g.height))
        .unwrap_or((opts.width, opts.height));

    let mut builder = WebviewWindowBuilder::new(app, opts.label, WebviewUrl::App(opts.url.into()))
        .title(opts.title)
        .inner_size(width, height)
        .min_inner_size(opts.min_width, opts.min_height)
        .focused(extras.focused);

    // Si un dist/ externe est actif, injecter la réécriture d'assets AVANT le
    // chargement de la page (donc avant le <script src="../browser/jocly.js">).
    if crate::dist_override::has_external_dist() {
        builder = builder.initialization_script(crate::ASSET_REWRITE_JS);
    }

    if let Some(g) = geometry {
        builder = builder.position(g.x, g.y);
    } else if let Some((x, y)) = extras.default_position {
        builder = builder.position(x, y);
    }

    let win = builder.build()?;

    // Persister la géométrie à la fermeture, si demandé.
    // On capture le label de la fenêtre elle-même (String, par valeur) pour
    // pouvoir la retrouver via l'AppHandle au moment de la fermeture, sans
    // avoir à capturer `win` dans son propre callback.
    if let Some(key) = opts.persist_key {
        let app_handle = app.clone();
        let label = win.label().to_string();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(w) = app_handle.get_webview_window(&label) {
                    let _ = save_geometry(&app_handle, &key, &w);
                }
            }
        });
    }

    Ok(win)
}

fn read_geometry(app: &AppHandle, key: &str) -> Option<Geometry> {
    use tauri_plugin_store::StoreExt;
    let store = app.store(STORE_FILE).ok()?;
    let value = store.get(key)?;
    serde_json::from_value(value).ok()
}

fn save_geometry(app: &AppHandle, key: &str, win: &WebviewWindow) -> tauri::Result<()> {
    use tauri_plugin_store::StoreExt;
    let size = win.inner_size()?;
    let pos = win.outer_position()?;
    let scale = win.scale_factor().unwrap_or(1.0);
    let geometry = Geometry {
        x: pos.x as f64,
        y: pos.y as f64,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
    };
    if let Ok(store) = app.store(STORE_FILE) {
        let _ = store.set(key.to_string(), serde_json::to_value(geometry).unwrap_or_default());
        let _ = store.save();
    }
    Ok(())
}

// ── Fenêtres liées à une partie ──────────────────────────────────────────────

/// Préfixes des fenêtres qui n'ont de sens qu'avec LEUR partie : leur label
/// est `<préfixe>-<matchId>` (voir window_cmds.rs). Les fenêtres liées à un
/// JEU plutôt qu'à une partie (info-, book-, invitation-, clock-setup-,
/// open-position-) servent à d'autres parties et restent ouvertes.
const MATCH_SATELLITES: &[&str] = &[
    "history", "clock", "chat", "players", "view-options", "camera",
    "save-template", "moves",
];

/// Ce label est-il une fenêtre liée à la partie `match_id` ?
///
/// Égalité exacte `<préfixe>-<id>` : `clock-12` n'est pas `clock-123`, et
/// `clock-setup-draughts8` n'est la fenêtre d'aucune partie. S'y ajoute
/// l'état du plateau, `board-state-<jeu>-<id>` (le nom du jeu peut contenir
/// des tirets, l'identifiant est toujours le dernier segment).
pub fn is_match_satellite(label: &str, match_id: u32) -> bool {
    let suffix = format!("-{match_id}");
    if MATCH_SATELLITES.iter().any(|p| label == format!("{p}{suffix}")) {
        return true;
    }
    label.starts_with("board-state-") && label.ends_with(&suffix)
        && label.len() > "board-state-".len() + suffix.len()
}

/// Ferme les fenêtres liées à la partie `match_id` -- appelé quand sa
/// fenêtre de jeu est détruite. `close()` plutôt que `destroy()` : les
/// fenêtres qui mémorisent leur géométrie (l'horloge) l'enregistrent en
/// passant.
pub fn close_match_satellites(app: &AppHandle, match_id: u32) {
    for (label, win) in app.webview_windows() {
        if is_match_satellite(&label, match_id) {
            if let Err(e) = win.close() {
                log::warn!("fermeture de {label} : {e}");
            }
        }
    }
}

/// Où placer une fenêtre de largeur `child_w` à côté d'une fenêtre
/// (x, y, largeur) : à sa droite, alignée en haut, séparée de `GAP` ; à sa
/// gauche si elle déborderait de l'écran [screen_x, screen_x + screen_w[ ;
/// et à défaut contre le bord droit de l'écran. Tout en unités logiques.
pub fn beside(parent: (f64, f64, f64), child_w: f64, screen: (f64, f64)) -> (f64, f64) {
    const GAP: f64 = 8.0;
    let (px, py, pw) = parent;
    let (sx, sw) = screen;
    let right = px + pw + GAP;
    if right + child_w <= sx + sw { return (right, py); }
    let left = px - GAP - child_w;
    if left >= sx { return (left, py); }
    ((sx + sw - child_w).max(sx), py)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fenetres_liees_a_une_partie() {
        for l in ["history-12", "clock-12", "chat-12", "players-12", "view-options-12",
                  "camera-12", "save-template-12", "moves-12", "board-state-classic-chess-12"] {
            assert!(is_match_satellite(l, 12), "{l} est liée à la partie 12");
        }
        for l in ["clock-123", "clock-1", "play-12", "main", "extensions",
                  "clock-setup-draughts12", "info-classic-chess", "book-go19",
                  "invitation-shogi", "board-state-classic-chess-112",
                  "board-state--12"] {
            assert!(!is_match_satellite(l, 12), "{l} n'est pas liée à la partie 12");
        }
    }

    #[test]
    fn placement_a_cote_de_la_partie() {
        let screen = (0.0, 1920.0);
        // Place à droite : à droite, alignée en haut.
        assert_eq!(beside((100.0, 50.0, 700.0), 400.0, screen), (808.0, 50.0));
        // Pas de place à droite : à gauche.
        assert_eq!(beside((1000.0, 50.0, 700.0), 400.0, screen), (592.0, 50.0));
        // Ni l'un ni l'autre (fenêtre de jeu très large) : contre le bord droit.
        assert_eq!(beside((10.0, 0.0, 1850.0), 400.0, screen), (1520.0, 0.0));
        // Second écran à droite du premier : les bornes sont celles de l'écran.
        assert_eq!(beside((2000.0, 30.0, 700.0), 400.0, (1920.0, 1920.0)), (2708.0, 30.0));
    }
}
