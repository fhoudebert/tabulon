// src-tauri/src/commands/video_cmds.rs
//
// Remplace mp4-mjpeg + ffmpeg-stream (Node.js) du package.json Electron.
//
// Fonctionnement original (joclyboard.js) :
//   1. startRecording  : dialog.showSaveDialog → chemin .mp4
//                        mjpeg({ fileName }) → ouvre un writer MP4
//   2. recordFrame     : videoRecorder.appendImageDataUrl(dataUri) à 30fps
//   3. stopRecording   : videoRecorder.finalize() → ferme le fichier MP4
//
// Implémentation Tauri :
//   1. startRecording  : tauri-plugin-dialog save_dialog → chemin .mp4
//                        spawn ffmpeg en sous-processus via tauri-plugin-shell
//                        pipe stdin = flux JPEG bruts concaténés
//   2. recordFrame     : décoder le data-URI JPEG → écrire les bytes sur stdin de ffmpeg
//   3. stopRecording   : fermer stdin → ffmpeg finalise le MP4
//
// Commande ffmpeg utilisée :
//   ffmpeg -f mjpeg -r 30 -i pipe:0 -vcodec libx264 -pix_fmt yuv420p <output.mp4>
//
// Prérequis : ffmpeg doit être dans le PATH (ou configuré dans tauri.conf.json
// comme external binary via tauri-plugin-shell sidecar).

use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::collections::HashMap;
use std::io::Write;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, State};

// ── État des enregistrements actifs ──────────────────────────────────────────

struct Recording {
    process: Child,
    stdin:   ChildStdin,
    path:    String,
}

pub struct VideoState {
    recordings: Mutex<HashMap<u32, Recording>>,
}

impl Default for VideoState {
    fn default() -> Self {
        Self { recordings: Mutex::new(HashMap::new()) }
    }
}

// ── Commandes Tauri ────────────────────────────────────────────────────────────

/// Ouvre un dialog "Enregistrer sous" et lance ffmpeg en pipe.
/// Équivalent de JBMatch.startRecording() + electron.dialog.showSaveDialog().
#[tauri::command]
pub async fn start_recording(
    app:      AppHandle,
    state:    State<'_, VideoState>,
    match_id: u32,
) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_store::StoreExt;

    // Récupérer le dossier de sortie précédent
    let default_dir: Option<String> = app
        .store("tabulon.json")
        .ok()
        .and_then(|s| s.get("video-path"))
        .and_then(|v| v.as_str().map(|s| s.to_string()));

    // Dialog de sauvegarde
    let output_path = {
        let mut builder = app.dialog().file()
            .set_title("Output video file")
            .add_filter("MP4 Video", &["mp4"]);
        if let Some(ref dir) = default_dir {
            builder = builder.set_directory(dir);
        }
        // Le dialog est bloquant — on l'appelle en async via le runtime Tauri
        let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
        builder.save_file(move |path| {
            let _ = tx.send(path.map(|p| p.to_string()));
        });
        match rx.await {
            Ok(Some(p)) => p,
            _ => return Err("Recording cancelled".into()),
        }
    };

    // Persister le dossier de sortie
    if let Ok(store) = app.store("tabulon.json") {
        if let Some(dir) = std::path::Path::new(&output_path).parent() {
            let _ = store.set("video-path", dir.to_string_lossy().to_string());
            let _ = store.save();
        }
    }

    // NB : les options de capture (ignoreIdenticalFrames, quality) sont
    // appliquées côté play.js, qui possède la pompe à frames — ffmpeg ne
    // reçoit que le flux JPEG final.

    // Lancer ffmpeg
    // Entrée : flux JPEG bruts sur stdin (format mjpeg)
    // Sortie : fichier MP4 H.264
    let mut child = Command::new("ffmpeg")
        .args([
            "-y",                    // écraser sans demander
            // -loglevel error : indispensable avec stderr pipé — le flux de
            // progression normal de ffmpeg remplirait le buffer du pipe
            // (64 Ko) et BLOQUERAIT l'encodage (deadlock classique Linux)
            "-loglevel", "error",
            "-f",    "mjpeg",        // format d'entrée : JPEG concaténés
            "-r",    "30",           // fréquence d'images
            "-i",    "pipe:0",       // lire depuis stdin
            "-vcodec", "libx264",
            "-pix_fmt", "yuv420p",   // compatible avec la plupart des lecteurs
            "-preset", "ultrafast",  // encodage rapide (enregistrement en temps réel)
            "-crf",  "23",           // qualité (0=lossless, 51=pire)
            &output_path,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())   // -loglevel error : seules les erreurs y passent
        .spawn()
        .map_err(|e| format!("Cannot start ffmpeg: {e}. Is ffmpeg installed?"))?;

    let stdin = child.stdin.take()
        .ok_or("Cannot get ffmpeg stdin")?;

    let mut recordings = state.recordings.lock().unwrap();
    recordings.insert(match_id, Recording { process: child, stdin, path: output_path });

    log::info!("startRecording match={match_id} → ffmpeg spawned");
    Ok(())
}

/// Reçoit un frame JPEG (data-URI) depuis play.js et l'envoie à ffmpeg via stdin.
/// Équivalent de videoRecorder.appendImageDataUrl(frame).
#[tauri::command]
pub fn record_frame(
    state:    State<'_, VideoState>,
    match_id: u32,
    snapshot: String,
) -> Result<(), String> {
    // Décoder le data-URI : "data:image/jpeg;base64,<b64>" ou "data:image/png;base64,<b64>"
    let b64 = snapshot
        .strip_prefix("data:image/jpeg;base64,")
        .or_else(|| snapshot.strip_prefix("data:image/png;base64,"))
        .ok_or("record_frame: invalid snapshot format (expected data-URI JPEG or PNG)")?;

    let bytes = STANDARD.decode(b64)
        .map_err(|e| format!("record_frame: base64 decode error: {e}"))?;

    let mut recordings = state.recordings.lock().unwrap();
    let rec = recordings.get_mut(&match_id)
        .ok_or_else(|| format!("record_frame: no active recording for match {match_id}"))?;

    // Écrire les bytes JPEG bruts sur stdin de ffmpeg
    // ffmpeg en mode mjpeg reconnaît la délimitation des frames par les marqueurs SOI/EOI
    rec.stdin.write_all(&bytes)
        .map_err(|e| format!("record_frame: write to ffmpeg stdin failed: {e}"))?;

    Ok(())
}

/// Finalise l'enregistrement d'un match : ferme stdin → ffmpeg écrit l'atome
/// moov et le MP4 devient lisible. Sans cette étape le fichier est corrompu
/// ("unrecognized file format") — c'est pourquoi elle est appelée à la fois
/// par la commande stop_recording ET par le hook de fermeture de fenêtre
/// (lib.rs, WindowEvent::Destroyed sur "play-{id}") : fermer la fenêtre de
/// jeu en cours d'enregistrement finalise quand même le fichier.
pub fn finalize_recording(state: &VideoState, match_id: u32) -> Result<String, String> {
    let mut recordings = state.recordings.lock().unwrap();
    let mut rec = recordings.remove(&match_id)
        .ok_or_else(|| format!("stop_recording: no active recording for match {match_id}"))?;

    // Fermer stdin → signal EOF pour ffmpeg
    drop(rec.stdin);

    // Récupérer stderr AVANT wait (les erreurs ffmpeg y sont, cf. -loglevel error)
    let stderr_pipe = rec.process.stderr.take();

    let exit_status = rec.process.wait()
        .map_err(|e| format!("stop_recording: ffmpeg wait error: {e}"))?;

    if exit_status.success() {
        log::info!("stopRecording match={match_id} → {}", rec.path);
        Ok(rec.path)
    } else {
        // Remonter la vraie cause (codec absent, disque plein, droits…) au
        // lieu d'un code de sortie opaque — c'était le point aveugle Linux.
        let mut err_out = String::new();
        if let Some(mut se) = stderr_pipe {
            use std::io::Read;
            let _ = se.read_to_string(&mut err_out);
        }
        let tail: String = err_out.lines().rev().take(4).collect::<Vec<_>>()
            .into_iter().rev().collect::<Vec<_>>().join(" | ");
        Err(format!("ffmpeg exited with status {exit_status}: {tail}"))
    }
}

/// Ferme le pipe stdin de ffmpeg → ffmpeg finalise le fichier MP4.
/// Équivalent de videoRecorder.finalize().
#[tauri::command]
pub fn stop_recording(
    state:    State<'_, VideoState>,
    match_id: u32,
) -> Result<String, String> {
    finalize_recording(&state, match_id)
}
