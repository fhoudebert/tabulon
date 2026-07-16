// src-tauri/src/commands/peer_cmds.rs -- Jeu a distance en PAIR-A-PAIR, sans
// aucun serveur (ni relai de jeu, ni signalisation) : une connexion TCP
// directe entre les deux instances de Tabulon, portee ici cote Rust.
//
// Pourquoi Rust et pas la webview (decision verifiee empiriquement, voir
// README.md § Remote play) : RTCPeerConnection n'existe PAS dans la webview
// Linux (WebKitGTK des distributions est compile sans WebRTC), et sans
// serveur STUN/TURN WebRTC n'aurait de toute facon que des candidats *host*
// -- la meme joignabilite qu'un TCP direct. Cote Rust, le transport est
// identique sur les trois OS et ne depend pas du moteur webview. Bonus
// architectural : la connexion appartient a l'application (pas a une
// fenetre), donc la fenetre Invitation peut etablir la session et la
// fenetre de jeu la reprendre ensuite, sans transfert d'objet JS.
//
// Modele : UNE session a la fois (comme le canal relai unique de play.js).
//   - hote  : peer_host_start(token) -> ecoute sur un port ephemere,
//             renvoie {port, ips} pour construire le code d'invitation
//             (app/content/remote-peer-protocol.js).
//   - invite: peer_connect(addrs, port, token) -> essaie chaque adresse.
//   - handshake : l'invite envoie une ligne JSON {"tabulonPeer":1,"token":..},
//     l'hote verifie le jeton et repond {"ok":true} -- seule
//     "authentification", meme modele que le matchId secret du relai HTTP.
//   - ensuite : relai symetrique de LIGNES de texte (une ligne = une
//     enveloppe JSON du protocole 'tabulon' de remote-relay-protocol.js --
//     JSON.stringify n'emet jamais de saut de ligne litteral, le framing
//     par '\n' est donc sur).
//   - chaque ligne recue est emise vers les webviews (event
//     "tabulon-peer://message") ET conservee comme "dernier message"
//     (peer_last_message) : la fenetre de jeu s'abonne APRES l'etablissement
//     de la session, elle peut donc rattraper un coup arrive entre-temps --
//     un seul emplacement suffit, les plis alternent (meme semantique
//     "dernier etat gagne" que fileio.php).
//
// LIMITES (documentees, pas cachees -- README § Remote play) :
//   - joignabilite : l'invite doit pouvoir router vers une des adresses de
//     l'hote -- reseau local, VPN, ou IP publique/redirection de port. PAS
//     de traversee NAT (c'est le prix de "aucun serveur").
//   - flux en clair (pas de TLS) : seul le jeton protege l'acces a la
//     session ; ne pas considerer la partie comme confidentielle hors LAN
//     de confiance.
//   - pas de reconnexion automatique : si le lien tombe, la session est
//     terminee (event status connected:false) ; on recree un code.

use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};

pub const EVENT_MESSAGE: &str = "tabulon-peer://message";
pub const EVENT_STATUS: &str = "tabulon-peer://status";

const HANDSHAKE_TIMEOUT_SECS: u64 = 15;
const CONNECT_TIMEOUT_SECS: u64 = 4;

// ── Etat partage ─────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct PeerState {
    inner: Mutex<Option<Session>>,
}

struct Session {
    role: &'static str, // "host" | "guest"
    outgoing: mpsc::UnboundedSender<String>,
    shutdown: watch::Sender<bool>,
    shared: Arc<Shared>,
}

#[derive(Default)]
struct Shared {
    connected: Mutex<bool>,
    last_message: Mutex<Option<String>>,
}

/// Evenement interne du relai -- decouple de Tauri pour que les tests
/// (cfg(test) plus bas) puissent exercer une vraie session TCP localhost
/// sans AppHandle.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum PeerEvent {
    Status { connected: bool, role: &'static str, error: Option<String> },
    Message(String),
}

#[derive(Serialize, Clone)]
pub struct PeerStatusPayload {
    pub connected: bool,
    pub role: String,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct HostInfo {
    pub port: u16,
    pub ips: Vec<String>,
}

#[derive(Serialize)]
pub struct PeerStatus {
    pub active: bool,
    pub connected: bool,
    pub role: Option<String>,
}

// ── Coeur transport (sans Tauri, testable) ───────────────────────────────────

fn handshake_line(token: &str) -> String {
    // serde_json n'echoue pas sur une structure aussi simple.
    serde_json::json!({ "tabulonPeer": 1, "token": token }).to_string()
}

fn handshake_token(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("tabulonPeer")?.as_i64()? != 1 {
        return None;
    }
    Some(v.get("token")?.as_str()?.to_string())
}

/// Boucle de relai symetrique une fois la session etablie : lignes du socket
/// -> events, lignes de `outgoing` -> socket. Se termine sur deconnexion,
/// erreur, ou shutdown.
async fn relay_loop(
    mut lines: tokio::io::Lines<BufReader<tokio::net::tcp::OwnedReadHalf>>,
    mut write_half: tokio::net::tcp::OwnedWriteHalf,
    role: &'static str,
    events: mpsc::UnboundedSender<PeerEvent>,
    mut outgoing: mpsc::UnboundedReceiver<String>,
    mut shutdown: watch::Receiver<bool>,
) {
    // NOTE : on garde le MEME lecteur bufferise que le handshake -- un
    // BufReader::into_inner() jetterait les octets deja lus d'avance
    // (message envoye par le pair juste derriere sa ligne de handshake).
    let mut error: Option<String> = None;
    loop {
        tokio::select! {
            line = lines.next_line() => {
                match line {
                    Ok(Some(text)) => { let _ = events.send(PeerEvent::Message(text)); }
                    Ok(None) => break, // l'autre cote a ferme proprement
                    Err(e) => { error = Some(e.to_string()); break; }
                }
            }
            msg = outgoing.recv() => {
                match msg {
                    Some(mut text) => {
                        text.push('\n');
                        if let Err(e) = write_half.write_all(text.as_bytes()).await {
                            error = Some(e.to_string());
                            break;
                        }
                    }
                    None => break, // session droppee cote commande
                }
            }
            _ = shutdown.changed() => {
                if *shutdown.borrow() { break; }
            }
        }
    }
    let _ = events.send(PeerEvent::Status { connected: false, role, error });
}

/// Cote hote : accepte des connexions jusqu'a un handshake valide (un jeton
/// faux est refuse et l'ecoute CONTINUE), puis relaie. Une seule session.
pub(crate) async fn run_host(
    listener: TcpListener,
    token: String,
    events: mpsc::UnboundedSender<PeerEvent>,
    outgoing: mpsc::UnboundedReceiver<String>,
    mut shutdown: watch::Receiver<bool>,
) {
    let stream = loop {
        let accepted = tokio::select! {
            r = listener.accept() => r,
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    let _ = events.send(PeerEvent::Status { connected: false, role: "host", error: None });
                    return;
                }
                continue;
            }
        };
        let (stream, _addr) = match accepted {
            Ok(x) => x,
            Err(e) => {
                let _ = events.send(PeerEvent::Status { connected: false, role: "host", error: Some(e.to_string()) });
                return;
            }
        };
        // Handshake borne dans le temps : un client qui se connecte sans
        // jamais parler ne doit pas bloquer l'ecoute pour le vrai joueur.
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half).lines();
        let first = tokio::time::timeout(
            std::time::Duration::from_secs(HANDSHAKE_TIMEOUT_SECS),
            reader.next_line(),
        ).await;
        let ok = matches!(&first, Ok(Ok(Some(line))) if handshake_token(line).as_deref() == Some(token.as_str()));
        if !ok {
            let _ = write_half.write_all(b"{\"ok\":false}\n").await;
            continue; // jeton absent/faux : on refuse et on attend le suivant
        }
        if write_half.write_all(b"{\"ok\":true}\n").await.is_err() {
            continue;
        }
        break (reader, write_half);
    };
    let (reader, write_half) = stream;
    let _ = events.send(PeerEvent::Status { connected: true, role: "host", error: None });
    relay_loop(reader, write_half, "host", events, outgoing, shutdown).await;
}

/// Cote invite : handshake sur un stream deja connecte, puis relaie.
/// Renvoie Err si le handshake echoue (jeton refuse, timeout...).
pub(crate) type GuestHalves = (tokio::io::Lines<BufReader<tokio::net::tcp::OwnedReadHalf>>, tokio::net::tcp::OwnedWriteHalf);

pub(crate) async fn run_guest_handshake(stream: TcpStream, token: &str) -> Result<GuestHalves, String> {
    let (read_half, mut write_half) = stream.into_split();
    let mut line = handshake_line(token);
    line.push('\n');
    write_half.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(read_half).lines();
    let reply = tokio::time::timeout(
        std::time::Duration::from_secs(HANDSHAKE_TIMEOUT_SECS),
        reader.next_line(),
    ).await
        .map_err(|_| "handshake: pas de reponse de l'hote".to_string())?
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "handshake: connexion fermee par l'hote".to_string())?;
    let v: serde_json::Value = serde_json::from_str(&reply)
        .map_err(|_| "handshake: reponse illisible".to_string())?;
    if v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
        return Err("handshake refuse (jeton invalide ?)".to_string());
    }
    Ok((reader, write_half))
}

// ── Adresses locales ─────────────────────────────────────────────────────────

/// Adresses IPv4 locales non-loopback (a mettre dans le code d'invitation).
/// Sans dependance : on demande a l'OS quelle interface il choisirait pour
/// une destination externe (UDP connect, AUCUN paquet emis). Couvre le cas
/// courant (une interface active) ; les configurations multi-interfaces
/// n'exposent ici que la route par defaut -- limite documentee. 127.0.0.1
/// est toujours ajoutee en dernier recours (deux instances sur la meme
/// machine, utile aussi pour tester).
fn local_ips() -> Vec<String> {
    let mut ips = Vec::new();
    if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("192.0.2.1:9").is_ok() { // TEST-NET-1, jamais joignable: pas d'envoi
            if let Ok(addr) = sock.local_addr() {
                let ip = addr.ip().to_string();
                if ip != "0.0.0.0" && !ip.starts_with("127.") {
                    ips.push(ip);
                }
            }
        }
    }
    ips.push("127.0.0.1".to_string());
    ips
}

// ── Session / commandes ──────────────────────────────────────────────────────

fn stop_session(state: &PeerState) {
    if let Some(session) = state.inner.lock().unwrap().take() {
        let _ = session.shutdown.send(true);
    }
}

fn spawn_event_forwarder(app: AppHandle, shared: Arc<Shared>, mut events: mpsc::UnboundedReceiver<PeerEvent>) {
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = events.recv().await {
            match ev {
                PeerEvent::Message(text) => {
                    *shared.last_message.lock().unwrap() = Some(text.clone());
                    let _ = app.emit(EVENT_MESSAGE, text);
                }
                PeerEvent::Status { connected, role, error } => {
                    *shared.connected.lock().unwrap() = connected;
                    let _ = app.emit(EVENT_STATUS, PeerStatusPayload {
                        connected, role: role.to_string(), error,
                    });
                }
            }
        }
    });
}

fn install_session(
    app: &AppHandle,
    state: &PeerState,
    role: &'static str,
) -> (mpsc::UnboundedSender<PeerEvent>, mpsc::UnboundedReceiver<String>, watch::Receiver<bool>, Arc<Shared>) {
    stop_session(state);
    let (events_tx, events_rx) = mpsc::unbounded_channel();
    let (out_tx, out_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let shared = Arc::new(Shared::default());
    spawn_event_forwarder(app.clone(), shared.clone(), events_rx);
    *state.inner.lock().unwrap() = Some(Session {
        role,
        outgoing: out_tx,
        shutdown: shutdown_tx,
        shared: shared.clone(),
    });
    (events_tx, out_rx, shutdown_rx, shared)
}

/// Demarre l'ecoute cote hote. `token` est genere COTE JS
/// (generatePeerToken, remote-peer-protocol.js). Renvoie port + adresses
/// pour construire le code d'invitation.
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 6a1ac01 (ip+port)
///
/// `port` (optionnel, etape 8c) : port d'ecoute FIXE plutot qu'ephemere --
/// indispensable pour jouer a travers Internet via une redirection de port
/// sur la box de l'hote (la regle NAT cible un port precis ; avec un port
/// ephemere il faudrait la refaire a chaque partie). Vide/absent = port
/// ephemere choisi par l'OS, comme avant. Si le port demande est deja pris
/// (ou privilegie), l'erreur remonte telle quelle a l'UI plutot que de
/// retomber silencieusement sur un port ephemere -- un repli silencieux
/// rendrait la regle de redirection invalide sans que l'hote le sache.
<<<<<<< HEAD
=======
>>>>>>> 1a0dc58 (peer to peer via code)
=======
>>>>>>> 6a1ac01 (ip+port)
#[tauri::command]
pub async fn peer_host_start(
    app: AppHandle,
    state: State<'_, PeerState>,
    token: String,
<<<<<<< HEAD
<<<<<<< HEAD
    port: Option<u16>,
=======
>>>>>>> 1a0dc58 (peer to peer via code)
=======
    port: Option<u16>,
>>>>>>> 6a1ac01 (ip+port)
) -> Result<HostInfo, String> {
    if token.len() < 8 {
        return Err("jeton trop court".to_string());
    }
<<<<<<< HEAD
<<<<<<< HEAD
    let listener = TcpListener::bind(("0.0.0.0", port.unwrap_or(0))).await
        .map_err(|e| format!("bind port {} : {e}", port.unwrap_or(0)))?;
=======
    let listener = TcpListener::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?;
>>>>>>> 1a0dc58 (peer to peer via code)
=======
    let listener = TcpListener::bind(("0.0.0.0", port.unwrap_or(0))).await
        .map_err(|e| format!("bind port {} : {e}", port.unwrap_or(0)))?;
>>>>>>> 6a1ac01 (ip+port)
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let (events_tx, out_rx, shutdown_rx, _shared) = install_session(&app, &state, "host");
    tauri::async_runtime::spawn(run_host(listener, token, events_tx, out_rx, shutdown_rx));
    log::info!("pair-a-pair : hote en ecoute sur le port {port}");
    Ok(HostInfo { port, ips: local_ips() })
}

/// Cote invite : essaie chaque adresse du code dans l'ordre, handshake, et
/// installe la session sur la premiere qui repond. Ne rend la main qu'une
/// fois la session ETABLIE (ou en erreur) -- l'UI peut donc enchainer.
#[tauri::command]
pub async fn peer_connect(
    app: AppHandle,
    state: State<'_, PeerState>,
    addrs: Vec<String>,
    port: u16,
    token: String,
) -> Result<(), String> {
    let mut last_err = "aucune adresse fournie".to_string();
    for addr in &addrs {
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 6a1ac01 (ip+port)
        // Une adresse IPv6 litterale contient des ':' et doit etre crochetee
        // ([addr]:port) pour que la resolution "host:port" fonctionne. Les
        // noms d'hote (DNS/DynDNS) passent tels quels -- TcpStream::connect
        // resout via ToSocketAddrs, donc un code peut transporter un nom
        // plutot qu'une IP (utile derriere une IP publique dynamique).
        let target = if addr.contains(':') && !addr.starts_with('[') {
            format!("[{addr}]:{port}")
        } else {
            format!("{addr}:{port}")
        };
<<<<<<< HEAD
=======
        let target = format!("{addr}:{port}");
>>>>>>> 1a0dc58 (peer to peer via code)
=======
>>>>>>> 6a1ac01 (ip+port)
        let connected = tokio::time::timeout(
            std::time::Duration::from_secs(CONNECT_TIMEOUT_SECS),
            TcpStream::connect(&target),
        ).await;
        let stream = match connected {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => { last_err = format!("{target}: {e}"); continue; }
            Err(_) => { last_err = format!("{target}: delai depasse"); continue; }
        };
        match run_guest_handshake(stream, &token).await {
            Ok((reader, write_half)) => {
                let (events_tx, out_rx, shutdown_rx, shared) = install_session(&app, &state, "guest");
                *shared.connected.lock().unwrap() = true;
                let _ = events_tx.send(PeerEvent::Status { connected: true, role: "guest", error: None });
                tauri::async_runtime::spawn(relay_loop(reader, write_half, "guest", events_tx, out_rx, shutdown_rx));
                log::info!("pair-a-pair : connecte a {target}");
                return Ok(());
            }
            Err(e) => { last_err = format!("{target}: {e}"); }
        }
    }
    Err(last_err)
}

/// Envoie une ligne (une enveloppe JSON du protocole 'tabulon') au pair.
#[tauri::command]
pub fn peer_send(state: State<'_, PeerState>, line: String) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("aucune session pair-a-pair active")?;
    session.outgoing.send(line).map_err(|_| "session terminee".to_string())
}

/// Dernier message recu (rattrapage : la fenetre de jeu s'abonne apres
/// l'etablissement de la session). Le filtre nbTurns cote JS rend une
/// relecture inoffensive.
#[tauri::command]
pub fn peer_last_message(state: State<'_, PeerState>) -> Option<String> {
    let guard = state.inner.lock().unwrap();
    guard.as_ref().and_then(|s| s.shared.last_message.lock().unwrap().clone())
}

/// Etat de la session (la fenetre de jeu arrive apres coup et a besoin de
/// savoir si la session annoncee par l'invitation existe toujours).
#[tauri::command]
pub fn peer_status(state: State<'_, PeerState>) -> PeerStatus {
    let guard = state.inner.lock().unwrap();
    match guard.as_ref() {
        None => PeerStatus { active: false, connected: false, role: None },
        Some(s) => PeerStatus {
            active: true,
            connected: *s.shared.connected.lock().unwrap(),
            role: Some(s.role.to_string()),
        },
    }
}

/// Termine la session en cours (fermeture propre du socket cote tache).
#[tauri::command]
pub fn peer_stop(state: State<'_, PeerState>) {
    stop_session(&state);
}

// ── Tests (vraie session TCP localhost, sans Tauri) ──────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    async fn recv_until_status(rx: &mut mpsc::UnboundedReceiver<PeerEvent>) -> PeerEvent {
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await {
                Ok(Some(ev @ PeerEvent::Status { .. })) => return ev,
                Ok(Some(_)) => continue,
                _ => panic!("aucun event Status recu"),
            }
        }
    }

    async fn recv_message(rx: &mut mpsc::UnboundedReceiver<PeerEvent>) -> String {
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await {
                Ok(Some(PeerEvent::Message(m))) => return m,
                Ok(Some(_)) => continue,
                _ => panic!("aucun event Message recu"),
            }
        }
    }

    /// Session complete hote<->invite sur localhost : handshake, relai
    /// bidirectionnel de lignes, fermeture propre detectee des deux cotes.
    #[tokio::test]
    async fn session_complete_bidirectionnelle() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = "jeton-de-test-0123456789abcdef".to_string();

        let (h_events_tx, mut h_events) = mpsc::unbounded_channel();
        let (h_out_tx, h_out_rx) = mpsc::unbounded_channel::<String>();
        let (h_shut_tx, h_shut_rx) = watch::channel(false);
        tokio::spawn(run_host(listener, token.clone(), h_events_tx, h_out_rx, h_shut_rx));

        let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let (reader, write_half) = run_guest_handshake(stream, &token).await.expect("handshake invite");
        let (g_events_tx, mut g_events) = mpsc::unbounded_channel();
        let (g_out_tx, g_out_rx) = mpsc::unbounded_channel::<String>();
        let (_g_shut_tx, g_shut_rx) = watch::channel(false);
        let _ = g_events_tx.send(PeerEvent::Status { connected: true, role: "guest", error: None });
        tokio::spawn(relay_loop(reader, write_half, "guest", g_events_tx, g_out_rx, g_shut_rx));

        assert!(matches!(recv_until_status(&mut h_events).await,
            PeerEvent::Status { connected: true, role: "host", .. }));
        assert!(matches!(recv_until_status(&mut g_events).await,
            PeerEvent::Status { connected: true, role: "guest", .. }));

        // invite -> hote
        g_out_tx.send(r#"{"v":1,"nbTurns":1,"lastMove":"e2e4"}"#.to_string()).unwrap();
        assert_eq!(recv_message(&mut h_events).await, r#"{"v":1,"nbTurns":1,"lastMove":"e2e4"}"#);
        // hote -> invite
        h_out_tx.send(r#"{"v":1,"nbTurns":2,"lastMove":"e7e5"}"#.to_string()).unwrap();
        assert_eq!(recv_message(&mut g_events).await, r#"{"v":1,"nbTurns":2,"lastMove":"e7e5"}"#);

        // arret hote -> l'invite voit la deconnexion
        h_shut_tx.send(true).unwrap();
        assert!(matches!(recv_until_status(&mut h_events).await,
            PeerEvent::Status { connected: false, role: "host", .. }));
        assert!(matches!(recv_until_status(&mut g_events).await,
            PeerEvent::Status { connected: false, role: "guest", .. }));
    }

    /// Un jeton faux est refuse ET l'hote continue d'ecouter : le vrai
    /// joueur peut encore se connecter apres la tentative invalide.
    #[tokio::test]
    async fn jeton_faux_refuse_puis_bon_jeton_accepte() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = "le-bon-jeton-000000000000000000".to_string();

        let (h_events_tx, mut h_events) = mpsc::unbounded_channel();
        let (_h_out_tx, h_out_rx) = mpsc::unbounded_channel::<String>();
        let (_h_shut_tx, h_shut_rx) = watch::channel(false);
        tokio::spawn(run_host(listener, token.clone(), h_events_tx, h_out_rx, h_shut_rx));

        let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let err = run_guest_handshake(stream, "mauvais-jeton").await;
        assert!(err.is_err(), "un jeton faux doit etre refuse");

        let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        run_guest_handshake(stream, &token).await.expect("le bon jeton doit passer apres un refus");
        assert!(matches!(recv_until_status(&mut h_events).await,
            PeerEvent::Status { connected: true, role: "host", .. }));
    }

<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 6a1ac01 (ip+port)
    /// Port fixe (etape 8c) : le bind respecte le port demande, et un port
    /// deja occupe est une ERREUR visible -- pas un repli ephemere silencieux
    /// (qui invaliderait la regle de redirection de la box sans prevenir).
    #[tokio::test]
    async fn port_fixe_respecte_et_occupation_visible() {
        // Reserver un numero de port libre, le liberer, puis demander CE
        // port explicitement : le listener doit ecouter exactement dessus.
        let probe = TcpListener::bind(("0.0.0.0", 0)).await.unwrap();
        let fixed = probe.local_addr().unwrap().port();
        drop(probe);
        let l1 = TcpListener::bind(("0.0.0.0", fixed)).await
            .expect("bind sur un port fixe libre");
        assert_eq!(l1.local_addr().unwrap().port(), fixed, "ecoute exactement sur le port demande");
        // Le meme port demande une seconde fois est une ERREUR visible.
        let l2 = TcpListener::bind(("0.0.0.0", fixed)).await;
        assert!(l2.is_err(), "un port deja pris doit echouer, pas retomber en ephemere");
    }

<<<<<<< HEAD
=======
>>>>>>> 1a0dc58 (peer to peer via code)
=======
>>>>>>> 6a1ac01 (ip+port)
    /// Le code d'invitation transporte des adresses : verifie qu'on en
    /// produit toujours au moins une (127.0.0.1 en dernier recours).
    #[test]
    fn local_ips_jamais_vide() {
        let ips = local_ips();
        assert!(!ips.is_empty());
        assert_eq!(ips.last().map(String::as_str), Some("127.0.0.1"));
    }
}
