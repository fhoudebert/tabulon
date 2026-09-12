//! Sceller et ouvrir un message de discussion.
//!
//! POURQUOI ICI ET PAS DANS LA WEBVIEW. `crypto.subtle` exige un contexte
//! securise, et rien ne garantit que le schema `tauri://` en soit un sous
//! WebKitGTK -- le projet a deja paye ce pari avec WebRTC (voir
//! remote-peer-protocol.js, dont tout le transport TCP existe pour cette
//! raison). `crypto.getRandomValues`, lui, est disponible partout, d'ou le
//! partage : le JS tire les cles, le Rust les emploie.
//!
//! CE QUE CELA PROTEGE, ET DE QUI. Les relais de parties n'ont aucune
//! authentification : ce qu'on y depose est lisible par qui tient le serveur
//! et par qui devine un identifiant de partie. La cle, elle, ne part jamais
//! vers le relai -- elle voyage dans le FRAGMENT du lien d'invitation, que le
//! navigateur ne transmet pas (voir buildInvitationUrl). Le serveur ne voit
//! donc que des octets opaques.
//!
//! CE QUE CELA NE PROTEGE PAS, et qu'il faut savoir : le serveur voit toujours
//! qui ecrit, quand, et combien. Et comme rien ne l'authentifie, quiconque
//! connait l'identifiant de partie peut ECRIRE dans le fil. Le sceau
//! authentifie (AEAD), donc ce bruit sera rejete a l'ouverture plutot
//! qu'affiche -- c'est le bon comportement, mais ce n'est pas la meme chose
//! qu'empecher d'ecrire.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Key, XChaCha20Poly1305, XNonce,
};

/// Taille du nonce de XChaCha20-Poly1305, en octets.
///
/// XChaCha PLUTOT QUE ChaCha, et c'est la seule decision de conception de ce
/// fichier : le nonce est tire au hasard a chaque message, et sur 96 bits
/// (ChaCha) la probabilite d'en retirer deux fois le meme cesse d'etre
/// negligeable avant qu'une conversation ne soit longue. Sur 192 bits elle ne
/// l'est jamais. Le prix est de 12 octets par message.
const NONCE_LEN: usize = 24;

/// La cle attendue : 32 octets, ecrits en hexadecimal.
///
/// C'est la forme que le lien d'invitation transporte et que
/// `generateChatKey()` produit cote JS ; les deux bouts doivent s'accorder
/// dessus, d'ou la validation ici plutot qu'une confiance.
fn key_from_hex(hex: &str) -> Result<Key, String> {
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("cle de discussion mal formee (32 octets hexadecimaux attendus)".into());
    }
    let mut bytes = [0u8; 32];
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
        let s = std::str::from_utf8(chunk).map_err(|_| "cle non ASCII".to_string())?;
        bytes[i] = u8::from_str_radix(s, 16).map_err(|_| "cle non hexadecimale".to_string())?;
    }
    // `Key::from_slice` PANIQUE si la longueur ne convient pas ; la garde
    // ci-dessus est donc ce qui evite de faire tomber le processus sur une
    // saisie de l'utilisateur.
    Ok(*Key::from_slice(&bytes))
}

/// Scelle un texte. Rend `base64(nonce || chiffre)`.
///
/// Le nonce voyage EN CLAIR avec le message, ce qui est sa nature : il n'a pas
/// a etre secret, seulement a ne jamais servir deux fois. Le coller devant le
/// chiffre evite un second champ a transporter, et la longueur etant fixe la
/// separation est sans ambiguite.
#[tauri::command]
pub fn seal_text(key: String, text: String) -> Result<String, String> {
    let cipher = XChaCha20Poly1305::new(&key_from_hex(&key)?);
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let mut out = cipher
        .encrypt(&nonce, text.as_bytes())
        .map_err(|_| "scellement impossible".to_string())?;
    let mut framed = nonce.to_vec();
    framed.append(&mut out);
    Ok(STANDARD.encode(framed))
}

/// Ouvre un texte scelle.
///
/// Toute erreur -- base64 illisible, message tronque, sceau qui ne correspond
/// pas -- rend la MEME erreur, sans dire laquelle. La distinction n'aiderait
/// que celui qui cherche a deviner la cle, et l'appelant, lui, n'en fait rien :
/// remote-chat-protocol.js affiche un message verrouille dans tous les cas.
#[tauri::command]
pub fn open_text(key: String, sealed: String) -> Result<String, String> {
    let cipher = XChaCha20Poly1305::new(&key_from_hex(&key)?);
    let raw = STANDARD
        .decode(sealed.as_bytes())
        .map_err(|_| "message illisible".to_string())?;
    if raw.len() <= NONCE_LEN {
        return Err("message illisible".to_string());
    }
    let (nonce, body) = raw.split_at(NONCE_LEN);
    let clear = cipher
        .decrypt(XNonce::from_slice(nonce), body)
        .map_err(|_| "message illisible".to_string())?;
    String::from_utf8(clear).map_err(|_| "message illisible".to_string())
}

/// Derive la cle d'une partie a partir de la cle de communaute.
///
/// POURQUOI DERIVER PLUTOT QU'ENVOYER. Une cle de partie enveloppee dans la
/// cle de communaute et deposee sur le relai serait ouvrable par TOUT membre
/// de la communaute qui sait quelle partie regarder. Derivee, elle ne transite
/// jamais : les deux joueurs la recalculent chacun de leur cote a partir de ce
/// qu'ils ont deja -- la cle partagee une fois -- et de l'identifiant de
/// partie, que le relai connait de toute facon puisque c'est sa cle de
/// stockage. Rien de nouveau ne circule, et il n'y a rien a perdre a la copie.
///
/// HMAC-SHA256 et non un simple hachage de la concatenation : `H(cle || info)`
/// se prolonge (length extension) sur les constructions de type Merkle-Damgard,
/// et HMAC est precisement la reponse a ce probleme. La cle fait 32 octets,
/// la sortie aussi, donc une extraction HKDF complete n'apporterait rien ici.
///
/// `info` est l'identifiant de partie. Prefixe d'une etiquette pour que la
/// meme cle de communaute puisse servir a derive autre chose demain sans que
/// les deux usages se rencontrent.
#[tauri::command]
pub fn derive_chat_key(master: String, info: String) -> Result<String, String> {
    let key = key_from_hex(&master)?;
    Ok(hex(&hmac_sha256(key.as_slice(), b"tabulon/chat/v1:", info.as_bytes())))
}

/// L'empreinte publique d'une cle de communaute.
///
/// LE PROBLEME QU'ELLE RESOUT : avec plusieurs cles -- un club, une famille,
/// une competition -- l'invitation doit dire LAQUELLE employer, sans dire
/// laquelle c'est a qui n'en fait pas partie. Le nom ne convient pas : chacun
/// nomme ses cles comme il veut, et deux installations ne s'accorderaient pas.
///
/// L'empreinte se calcule depuis la cle elle-meme, donc les deux bouts
/// trouvent la meme sans s'etre concertes, quel que soit le nom donne de part
/// et d'autre. Elle est tronquee a 8 octets : assez pour designer une cle
/// parmi quelques-unes, trop court pour servir a deviner la cle -- et de toute
/// facon HMAC ne se remonte pas.
#[tauri::command]
pub fn chat_key_id(master: String) -> Result<String, String> {
    let key = key_from_hex(&master)?;
    let full = hmac_sha256(key.as_slice(), b"tabulon/chat-id/v1", b"");
    Ok(hex(&full[..8]))
}

fn hmac_sha256(key: &[u8], label: &[u8], info: &[u8]) -> [u8; 32] {
    use hmac::{Hmac, KeyInit, Mac};
    use sha2::Sha256;
    // Qualifie par KeyInit, et non par Mac : depuis hmac 0.13 / digest 0.11,
    // `new_from_slice` n'appartient plus au trait Mac. Le qualifier reste
    // necessaire, les deux traits etant tous deux en portee.
    //
    // L'erreur ne peut pas survenir -- HMAC accepte n'importe quelle longueur
    // de cle, et celle-ci vient de key_from_hex, qui en garantit 32 octets.
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key)
        .expect("HMAC accepte toute longueur de cle");
    mac.update(label);
    mac.update(info);
    mac.finalize().into_bytes().into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const OTHER: &str = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

    #[test]
    fn seals_and_opens() {
        let sealed = seal_text(KEY.into(), "bien joue".into()).unwrap();
        assert_eq!(open_text(KEY.into(), sealed).unwrap(), "bien joue");
    }

    // Ce qui est depose sur le relai ne doit rien laisser voir du texte.
    #[test]
    fn the_text_does_not_show_through() {
        let sealed = seal_text(KEY.into(), "rendez-vous a 18h".into()).unwrap();
        assert!(!sealed.contains("rendez"));
        assert!(!sealed.contains("18h"));
    }

    // Deux sceaux du MEME texte different : le nonce est tire a chaque
    // message. Sans cela, un observateur verrait qu'une phrase se repete, ce
    // qui en dit deja beaucoup sur une conversation courte.
    #[test]
    fn the_same_text_seals_differently_twice() {
        let a = seal_text(KEY.into(), "a toi".into()).unwrap();
        let b = seal_text(KEY.into(), "a toi".into()).unwrap();
        assert_ne!(a, b);
        assert_eq!(open_text(KEY.into(), a).unwrap(), "a toi");
        assert_eq!(open_text(KEY.into(), b).unwrap(), "a toi");
    }

    #[test]
    fn another_key_does_not_open_it() {
        let sealed = seal_text(KEY.into(), "secret".into()).unwrap();
        assert!(open_text(OTHER.into(), sealed).is_err());
    }

    // AEAD : le sceau authentifie. N'importe qui connaissant l'identifiant de
    // partie peut ECRIRE dans le fil sur un relai sans authentification ; ce
    // bruit doit etre rejete a l'ouverture, pas affiche.
    #[test]
    fn a_tampered_message_is_rejected() {
        let sealed = seal_text(KEY.into(), "je fais une pause".into()).unwrap();
        let mut raw = STANDARD.decode(sealed).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0x01;
        assert!(open_text(KEY.into(), STANDARD.encode(raw)).is_err());
    }

    // Une cle mal formee doit ECHOUER, pas faire tomber le processus :
    // Key::from_slice panique sur une longueur inattendue, et la valeur vient
    // d'un lien colle par l'utilisateur.
    #[test]
    fn a_malformed_key_is_refused_without_panicking() {
        for bad in ["", "trop court", &"z".repeat(64), &"aa".repeat(16)] {
            assert!(seal_text(bad.into(), "x".into()).is_err());
            assert!(open_text(bad.into(), "x".into()).is_err());
        }
    }

    #[test]
    fn a_truncated_message_is_refused() {
        assert!(open_text(KEY.into(), STANDARD.encode([0u8; 8])).is_err());
        assert!(open_text(KEY.into(), "pas du base64 !!".into()).is_err());
        assert!(open_text(KEY.into(), String::new()).is_err());
    }

    // L'accentuation et les emoji survivent : un message est de l'UTF-8, et le
    // chiffre travaille sur des octets.
    // Les deux bouts calculent la MEME cle sans s'etre concertes : c'est toute
    // la raison de deriver plutot que d'envoyer.
    #[test]
    fn both_sides_derive_the_same_key() {
        let a = derive_chat_key(KEY.into(), "match-42".into()).unwrap();
        let b = derive_chat_key(KEY.into(), "match-42".into()).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        // Et la cle derivee est utilisable telle quelle par le scellement.
        let sealed = seal_text(a.clone(), "salut".into()).unwrap();
        assert_eq!(open_text(a, sealed).unwrap(), "salut");
    }

    // Deux parties ne partagent pas de cle : c'est ce qui fait qu'un membre de
    // la communaute qui lit une partie ne lit pas les autres pour autant.
    #[test]
    fn two_games_get_different_keys() {
        assert_ne!(
            derive_chat_key(KEY.into(), "match-42".into()).unwrap(),
            derive_chat_key(KEY.into(), "match-43".into()).unwrap()
        );
    }

    #[test]
    fn two_communities_get_different_keys() {
        assert_ne!(
            derive_chat_key(KEY.into(), "match-42".into()).unwrap(),
            derive_chat_key(OTHER.into(), "match-42".into()).unwrap()
        );
    }

    // L'empreinte designe la cle sans la donner : elle sert a choisir parmi
    // plusieurs, et voyage dans le fragment de l'invitation.
    #[test]
    fn the_fingerprint_names_a_key_without_giving_it() {
        let id = chat_key_id(KEY.into()).unwrap();
        assert_eq!(id.len(), 16);
        assert_eq!(chat_key_id(KEY.into()).unwrap(), id);
        assert_ne!(chat_key_id(OTHER.into()).unwrap(), id);
        assert!(!KEY.contains(&id));
    }

    // L'empreinte n'est pas la cle derivee : deux usages de la meme cle
    // maitresse ne doivent pas se rencontrer, d'ou les etiquettes distinctes.
    #[test]
    fn fingerprint_and_derived_key_do_not_collide() {
        let id = chat_key_id(KEY.into()).unwrap();
        assert!(!derive_chat_key(KEY.into(), String::new()).unwrap().starts_with(&id));
    }

    #[test]
    fn a_malformed_master_is_refused() {
        assert!(derive_chat_key("".into(), "m".into()).is_err());
        assert!(chat_key_id("trop court".into()).is_err());
    }

    #[test]
    fn text_survives_intact() {
        let text = "à tout à l'heure 👋 — ça va être long";
        let sealed = seal_text(KEY.into(), text.into()).unwrap();
        assert_eq!(open_text(KEY.into(), sealed).unwrap(), text);
    }
}
