//! Effacer une partie terminee du relai, a la fermeture de sa fenetre.
//!
//! POURQUOI. Une partie a distance laisse deux fichiers sur le relai : son
//! etat et sa conversation. Une fois la partie finie, ils ne servent plus a
//! rien -- et la conversation, meme scellee, est une donnee qu'on n'a aucune
//! raison de laisser chez un tiers. Le relai a bien une duree de vie (30
//! jours), mais c'est le filet des parties abandonnees, pas le cas normal.
//!
//! QUI EFFACE. Celui qui a RECU le dernier coup : il sait que les deux cotes
//! ont vu la fin. Celui qui l'a joue ne le sait pas -- effacer aussitot
//! pourrait retirer le coup avant que l'autre l'ait lu. C'est play.js qui
//! decide et qui « arme » l'effacement ; ce fichier ne fait que l'executer.
//!
//! QUAND. A la fermeture de la fenetre de jeu, pas a la fin de la partie : les
//! mots echanges apres le dernier coup restent lisibles tant qu'elle est
//! ouverte.
//!
//! POURQUOI EN RUST. A la fermeture, la page est detruite : une requete
//! lancee depuis `beforeunload` peut ne jamais partir (meme constat que pour
//! la video, voir le crochet `WindowEvent::Destroyed` de lib.rs). Ici, la
//! requete part apres la destruction, d'un endroit qui lui survit.
//!
//! LIMITE CONNUE : si l'application entiere se ferme au meme moment, la
//! requete peut etre coupee. La duree de vie du relai fait alors le menage.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

/// Ce qu'il faudra effacer, et ou.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingDrop {
    pub relay_url: String,
    pub game_id: String,
}

/// Les effacements armes, par fenetre de jeu (`play-<id>`).
#[derive(Default)]
pub struct RelayDropState(Mutex<HashMap<u32, PendingDrop>>);

/// Valide ce que la page demande d'effacer.
///
/// La commande envoie une requete vers une adresse fournie par la page : on
/// la borne a ce qu'est un relai Tabulon -- un `fileio.php` en http(s), sans
/// parametres -- et a un identifiant de partie du format que les relais
/// acceptent eux-memes. Rien d'autre ne peut partir par ce chemin.
pub(crate) fn validate(relay_url: &str, game_id: &str) -> Result<PendingDrop, String> {
    let url = tauri::Url::parse(relay_url).map_err(|_| "adresse de relai invalide".to_string())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("adresse de relai : http ou https attendu".into());
    }
    if url.host_str().unwrap_or("").is_empty()
        || !url.path().ends_with("/fileio.php")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("adresse de relai : …/fileio.php attendu".into());
    }
    let ok_id = (6..=128).contains(&game_id.len())
        && game_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !ok_id {
        return Err("identifiant de partie invalide".into());
    }
    Ok(PendingDrop { relay_url: url.to_string(), game_id: game_id.to_string() })
}

/// Corps de la requete : le dialecte d'origine (joclymatch), que les deux
/// relais comprennent -- et que le `fileio.php` de mogichex traduit en
/// effacant AUSSI le fil de discussion.
pub(crate) fn drop_body(game_id: &str) -> String {
    format!("gameioaction=drop&gameid={}", urlencoding::encode(game_id))
}

/// Arme l'effacement de la partie de la fenetre `play-<match_id>`.
#[tauri::command]
pub fn arm_relay_drop(
    state: tauri::State<RelayDropState>,
    match_id: u32,
    relay_url: String,
    game_id: String,
) -> Result<(), String> {
    let drop = validate(&relay_url, &game_id)?;
    state.0.lock().map_err(|_| "etat indisponible".to_string())?.insert(match_id, drop);
    Ok(())
}

/// Desarme : la partie a repris (reprise de coup apres la fin, par exemple).
#[tauri::command]
pub fn disarm_relay_drop(state: tauri::State<RelayDropState>, match_id: u32) -> Result<(), String> {
    state.0.lock().map_err(|_| "etat indisponible".to_string())?.remove(&match_id);
    Ok(())
}

/// Retire l'effacement arme pour cette fenetre, s'il y en a un.
pub fn take(state: &RelayDropState, match_id: u32) -> Option<PendingDrop> {
    state.0.lock().ok()?.remove(&match_id)
}

/// Envoie l'effacement et rend le code HTTP. Separe de `send_drop` pour
/// pouvoir etre teste contre un vrai serveur local.
pub(crate) async fn post_drop(drop: &PendingDrop, timeout: Duration) -> Result<u16, String> {
    let client = tauri_plugin_http::reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(&drop.relay_url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(drop_body(&drop.game_id))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(res.status().as_u16())
}

/// Envoie l'effacement sans bloquer : appele depuis le crochet de
/// destruction de fenetre, qui tourne sur le fil principal.
pub fn send_drop(drop: PendingDrop) {
    tauri::async_runtime::spawn(async move {
        match post_drop(&drop, Duration::from_secs(10)).await {
            Ok(code) => log::info!("relai : partie {} effacee (HTTP {code})", drop.game_id),
            Err(e) => log::warn!("relai : effacement de {} impossible : {e}", drop.game_id),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn accepte_un_relai_et_un_identifiant_reels() {
        let d = validate("https://biscandine.fr/variantes/joclymatch/fileio.php",
                         "1754035200000-AbCdEfGhIjKlMn").unwrap();
        assert_eq!(d.relay_url, "https://biscandine.fr/variantes/joclymatch/fileio.php");
        // UUID v4, le format de generateMatchId
        assert!(validate("https://h.fr/fileio.php", "3f2b8c1e-7a4d-4e2b-9c1a-0d5e6f7a8b9c").is_ok());
    }

    #[test]
    fn refuse_ce_qui_n_est_pas_un_relai() {
        let id = "1754035200000-AbCdEfGhIjKlMn";
        for url in ["file:///etc/passwd", "ftp://h.fr/fileio.php", "https://h.fr/autre.php",
                    "https://h.fr/fileio.php?x=1", "https://h.fr/fileio.php#k", "pas une url"] {
            assert!(validate(url, id).is_err(), "{url} devrait etre refusee");
        }
    }

    #[test]
    fn refuse_un_identifiant_qui_sortirait_du_format() {
        let url = "https://h.fr/fileio.php";
        let long = "x".repeat(129);
        for id in ["", "court", "../../etc", "a b c d e f", "id&gameioaction=save", long.as_str()] {
            assert!(validate(url, id).is_err(), "{id:?} devrait etre refuse");
        }
    }

    #[test]
    fn le_corps_est_celui_que_comprennent_les_relais() {
        assert_eq!(drop_body("abc-123_XY"), "gameioaction=drop&gameid=abc-123_XY");
    }

    #[test]
    fn armer_puis_prendre_ne_sert_qu_une_fois() {
        let state = RelayDropState::default();
        let d = validate("https://h.fr/fileio.php", "partie-123456").unwrap();
        state.0.lock().unwrap().insert(7, d.clone());
        assert_eq!(take(&state, 8), None, "une autre fenetre n'a rien d'arme");
        assert_eq!(take(&state, 7), Some(d));
        assert_eq!(take(&state, 7), None, "deja parti : pas de second envoi");
    }

    /// La vraie requete, contre un serveur local : methode, type et corps.
    #[test]
    fn la_requete_part_vraiment() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            sock.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 1024];
            // Lire jusqu'a la fin du corps annonce.
            loop {
                let n = sock.read(&mut chunk).unwrap_or(0);
                if n == 0 { break; }
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf);
                if let Some(head_end) = text.find("\r\n\r\n") {
                    let len = text[..head_end].lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                        .unwrap_or(0);
                    if buf.len() >= head_end + 4 + len { break; }
                }
            }
            sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}").unwrap();
            String::from_utf8_lossy(&buf).to_string()
        });
        let drop = validate(&format!("http://127.0.0.1:{port}/relai/fileio.php"), "partie-123456").unwrap();
        let code = tauri::async_runtime::block_on(post_drop(&drop, Duration::from_secs(5))).unwrap();
        assert_eq!(code, 200);
        let req = server.join().unwrap();
        assert!(req.starts_with("POST /relai/fileio.php "), "requete : {req}");
        assert!(req.to_ascii_lowercase().contains("content-type: application/x-www-form-urlencoded"));
        assert!(req.ends_with("gameioaction=drop&gameid=partie-123456"), "corps : {req}");
    }
}
