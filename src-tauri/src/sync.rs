//! Ingest: beobachtet den von Drive synchronisierten Ordner und spiegelt neue
//! Bounces nach R2 und D1.
//!
//! Ablauf pro Datei: stabil? -> hashen -> prepare -> (bekannt? fertig) ->
//! Bytes hochladen -> Peaks berechnen lassen -> complete.
//!
//! Der Dedup ueber den Hash ist der Grund, warum fuenf laufende Agents nicht
//! fuenfmal denselben Song hochladen: wer zuerst prepare aufruft, laedt hoch,
//! alle anderen bekommen known:true.

use crate::api::{Api, ApiError};
use crate::settings::{HashIndex, IndexEntry, Settings};
use notify_debouncer_full::notify::RecursiveMode;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot};

const AUDIO_EXTENSIONS: [&str; 2] = ["mp3", "wav"];
/// Drive schreibt in Schueben. Erst wenn die Groesse zwischen zwei Messungen
/// gleich bleibt, ist die Datei fertig kopiert.
const STABILITY_INTERVAL: Duration = Duration::from_millis(1000);
const STABILITY_MAX_CHECKS: u32 = 30;
/// Falls das Peaks-Fenster nicht antwortet, soll die Pipeline weiterlaufen.
const PEAKS_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PeaksRequest {
    pub version_id: String,
    pub path: String,
}

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PeaksResult {
    pub duration: f64,
    pub peaks: Vec<Vec<f32>>,
}

/// Vermittelt zwischen dem Rust-Ingest und dem versteckten Peaks-Fenster.
#[derive(Default)]
pub struct PeaksRegistry {
    waiting: Mutex<HashMap<String, oneshot::Sender<PeaksResult>>>,
}

impl PeaksRegistry {
    fn expect(&self, version_id: &str) -> oneshot::Receiver<PeaksResult> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut waiting) = self.waiting.lock() {
            waiting.insert(version_id.to_string(), tx);
        }
        rx
    }

    /// Wird vom Command peaks_ready aufgerufen.
    pub fn fulfill(&self, version_id: &str, result: PeaksResult) {
        if let Ok(mut waiting) = self.waiting.lock() {
            if let Some(tx) = waiting.remove(version_id) {
                let _ = tx.send(result);
            }
        }
    }

    fn forget(&self, version_id: &str) {
        if let Ok(mut waiting) = self.waiting.lock() {
            waiting.remove(version_id);
        }
    }
}

/// Gemeinsamer Zustand, den Tray, Commands und Ingest teilen.
pub struct SyncState {
    pub settings: Mutex<Settings>,
    pub index: HashIndex,
    pub peaks: PeaksRegistry,
    pub status: Mutex<String>,
    /// Belegt / Limit in Bytes, vom Feed-Poller fortgeschrieben. Zeigt im Tray,
    /// wie viel Luft bis zum R2-Freikontingent bleibt.
    pub storage: Mutex<Option<(u64, u64)>>,
    sender: Mutex<Option<mpsc::UnboundedSender<PathBuf>>>,
}

impl SyncState {
    pub fn new() -> Self {
        Self {
            settings: Mutex::new(Settings::load()),
            index: HashIndex::load(),
            peaks: PeaksRegistry::default(),
            status: Mutex::new("Nicht eingerichtet".to_string()),
            storage: Mutex::new(None),
            sender: Mutex::new(None),
        }
    }

    pub fn set_status(&self, text: impl Into<String>) {
        if let Ok(mut status) = self.status.lock() {
            *status = text.into();
        }
    }

    pub fn status_text(&self) -> String {
        self.status
            .lock()
            .map(|s| s.clone())
            .unwrap_or_else(|_| "unbekannt".into())
    }

    /// Statuszeile fuer das Tray-Menue, inklusive Speicherstand.
    pub fn tray_label(&self) -> String {
        let status = self.status_text();
        let storage = self.storage.lock().ok().and_then(|s| *s);
        match storage {
            Some((used, limit)) if limit > 0 => {
                let gib = |b: u64| b as f64 / 1024.0 / 1024.0 / 1024.0;
                format!("{status}  ·  {:.2} / {:.0} GiB", gib(used), gib(limit))
            }
            _ => status,
        }
    }

    pub fn settings_snapshot(&self) -> Settings {
        self.settings
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default()
    }

    fn enqueue(&self, path: PathBuf) {
        if let Ok(sender) = self.sender.lock() {
            if let Some(tx) = sender.as_ref() {
                let _ = tx.send(path);
            }
        }
    }
}

impl Default for SyncState {
    fn default() -> Self {
        Self::new()
    }
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Songname ist der Ordner, in dem die Datei liegt. Liegt sie direkt im
/// Wurzelverzeichnis, dient der Dateiname ohne Endung als Songname.
fn song_name_for(path: &Path, root: &Path) -> String {
    let parent = path.parent().unwrap_or(root);
    if parent == root {
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Unbenannt")
            .to_string()
    } else {
        parent
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Unbenannt")
            .to_string()
    }
}

/// Wartet, bis die Dateigroesse zwischen zwei Messungen gleich bleibt.
/// Ohne das laedt der Agent halb synchronisierte Dateien hoch - und weil der
/// Hash dann auch "stimmt", wuerde der Dedup diesen kaputten Stand fuer immer
/// als bekannt durchwinken.
fn wait_until_stable(path: &Path) -> Option<(u64, u64)> {
    let mut last = std::fs::metadata(path).ok()?.len();
    for _ in 0..STABILITY_MAX_CHECKS {
        std::thread::sleep(STABILITY_INTERVAL);
        let meta = std::fs::metadata(path).ok()?;
        let current = meta.len();
        if current == last && current > 0 {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            return Some((current, mtime));
        }
        last = current;
    }
    None
}

/// Streamend hashen - eine 40-MB-Datei muss nicht am Stueck in den Speicher.
fn hash_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Eine Datei komplett durch die Pipeline. Fehler werden gemeldet, nicht
/// weitergereicht - ein kaputter Song darf den Watcher nicht abreissen lassen.
async fn ingest_one(app: &AppHandle, path: PathBuf) {
    let state = app.state::<Arc<SyncState>>();
    let settings = state.settings_snapshot();
    if !settings.is_configured() {
        return;
    }
    let root = PathBuf::from(&settings.pre_pro_path);
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();

    let Some((size, mtime)) = wait_until_stable(&path) else {
        state.set_status(format!("{name}: Datei wurde nicht stabil, uebersprungen"));
        return;
    };

    let path_str = path.to_string_lossy().to_string();
    if state.index.is_current(&path_str, size, mtime) {
        return; // unveraendert seit dem letzten Lauf
    }

    state.set_status(format!("{name}: hashen"));
    let hash = match hash_file(&path) {
        Ok(hash) => hash,
        Err(err) => {
            state.set_status(format!("{name}: nicht lesbar ({err})"));
            return;
        }
    };

    let api = Api::new(&settings.api_base_url, &settings.device_token);
    let song = song_name_for(&path, &root);

    state.set_status(format!("{name}: anmelden"));
    let prepared = match api.prepare(&hash, &name, &song, size).await {
        Ok(prepared) => prepared,
        Err(ApiError::StorageLimit(message)) => {
            state.set_status(format!("Speicherlimit erreicht - {message}"));
            return;
        }
        Err(err) => {
            state.set_status(format!("{name}: {err}"));
            return;
        }
    };

    // Der Index wird in jedem Fall gepflegt, auch wenn ein anderer Agent die
    // Datei schon hochgeladen hat - er dient dem lokalen Abspielen.
    state.index.record(
        &hash,
        IndexEntry {
            path: path_str.clone(),
            size,
            mtime,
        },
    );

    if prepared.known {
        state.set_status(format!("{name}: war schon da"));
        return;
    }

    state.set_status(format!("{name}: hochladen"));
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) => {
            state.set_status(format!("{name}: nicht lesbar ({err})"));
            return;
        }
    };
    if let Err(err) = api.upload_blob(&prepared.version_id, bytes).await {
        state.set_status(format!("{name}: Upload fehlgeschlagen ({err})"));
        return;
    }

    state.set_status(format!("{name}: Wellenform berechnen"));
    let receiver = state.peaks.expect(&prepared.version_id);
    let request = PeaksRequest {
        version_id: prepared.version_id.clone(),
        path: path_str,
    };
    if app.emit("compute-peaks", request).is_err() {
        state.peaks.forget(&prepared.version_id);
        state.set_status(format!("{name}: Peaks-Fenster nicht erreichbar"));
        return;
    }

    let peaks = match tokio::time::timeout(PEAKS_TIMEOUT, receiver).await {
        Ok(Ok(result)) => result,
        _ => {
            state.peaks.forget(&prepared.version_id);
            // Die Version bleibt serverseitig auf ready = 0 stehen; der
            // naechste Versuch bekommt dieselbe versionId und macht weiter.
            state.set_status(format!("{name}: Wellenform fehlgeschlagen"));
            return;
        }
    };

    match api
        .complete(&prepared.version_id, peaks.duration, peaks.peaks)
        .await
    {
        Ok(()) => state.set_status(format!("{name}: fertig")),
        Err(err) => state.set_status(format!("{name}: Abschluss fehlgeschlagen ({err})")),
    }
}

/// Einmal den ganzen Ordner durchgehen. Holt nach, was bei ausgeschaltetem
/// Agent dazugekommen ist.
fn scan_all(state: &SyncState, root: &Path) {
    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.is_file() && is_audio(path) {
            state.enqueue(path.to_path_buf());
        }
    }
}

/// Startet Watcher und Verarbeitung. Wird beim App-Start und nach jeder
/// Aenderung der Einstellungen aufgerufen.
pub fn start(app: &AppHandle) {
    let state = app.state::<Arc<SyncState>>().inner().clone();
    let settings = state.settings_snapshot();

    if !settings.is_configured() {
        state.set_status("Nicht eingerichtet - Token und Ordner fehlen");
        return;
    }
    let root = PathBuf::from(&settings.pre_pro_path);
    if !root.is_dir() {
        state.set_status(format!("Ordner nicht gefunden: {}", root.display()));
        return;
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<PathBuf>();
    if let Ok(mut sender) = state.sender.lock() {
        *sender = Some(tx);
    }

    // Verarbeitung: bewusst seriell. Parallel waere schneller, wuerde aber die
    // API mit gleichzeitigen Uploads bewerfen und die Statusmeldung unlesbar
    // machen.
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut seen_recently: HashMap<PathBuf, std::time::Instant> = HashMap::new();
        while let Some(path) = rx.recv().await {
            // Der Debouncer meldet dieselbe Datei bei Kopiervorgaengen
            // mehrfach; kurz hintereinander reicht ein Durchlauf.
            let now = std::time::Instant::now();
            seen_recently.retain(|_, at| now.duration_since(*at) < Duration::from_secs(30));
            if seen_recently.contains_key(&path) {
                continue;
            }
            seen_recently.insert(path.clone(), now);
            ingest_one(&app_handle, path).await;
        }
    });

    let state_for_scan = state.clone();
    let scan_root = root.clone();
    std::thread::spawn(move || {
        state_for_scan.set_status("Startlauf");
        scan_all(&state_for_scan, &scan_root);
        state_for_scan.set_status("Beobachte Ordner");
    });

    let state_for_watch = state.clone();
    std::thread::spawn(move || {
        let (watch_tx, watch_rx) = std::sync::mpsc::channel();
        let mut debouncer = match notify_debouncer_full::new_debouncer(
            Duration::from_secs(2),
            None,
            watch_tx,
        ) {
            Ok(debouncer) => debouncer,
            Err(err) => {
                state_for_watch.set_status(format!("Watcher fehlgeschlagen: {err}"));
                return;
            }
        };
        if let Err(err) = debouncer.watch(&root, RecursiveMode::Recursive) {
            state_for_watch.set_status(format!("Ordner nicht beobachtbar: {err}"));
            return;
        }

        for events in watch_rx {
            let Ok(events) = events else { continue };
            for event in events {
                for path in &event.paths {
                    if path.is_file() && is_audio(path) {
                        state_for_watch.enqueue(path.clone());
                    }
                }
            }
        }
    });
}

/// Ermittelt die eigene Identitaet - gebraucht, um eigene Uploads aus den
/// Benachrichtigungen herauszuhalten.
pub async fn own_identity(settings: &Settings) -> Option<String> {
    Api::new(&settings.api_base_url, &settings.device_token)
        .bootstrap()
        .await
        .ok()
        .map(|b| b.identity)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tempdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("songou-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn erkennt_audiodateien_unabhaengig_von_der_schreibweise() {
        assert!(is_audio(Path::new("a/take3.mp3")));
        assert!(is_audio(Path::new("a/Take3.MP3")));
        assert!(is_audio(Path::new("a/roh.WAV")));
        assert!(!is_audio(Path::new("a/comments.json")));
        assert!(!is_audio(Path::new("a/cover.png")));
        assert!(!is_audio(Path::new("a/ohne-endung")));
    }

    #[test]
    fn songname_kommt_vom_ordner_sonst_vom_dateinamen() {
        let root = Path::new("/pre_pro");
        assert_eq!(
            song_name_for(Path::new("/pre_pro/Nordwind/take3.mp3"), root),
            "Nordwind"
        );
        // Direkt in der Wurzel gibt es keinen Ordner, der den Song benennt.
        assert_eq!(
            song_name_for(Path::new("/pre_pro/Skizze.mp3"), root),
            "Skizze"
        );
    }

    #[test]
    fn hash_entspricht_dem_bekannten_sha256() {
        let dir = tempdir("hash");
        let file = dir.join("a.mp3");
        std::fs::write(&file, b"abc").unwrap();
        // Bekannter SHA-256 von "abc".
        assert_eq!(
            hash_file(&file).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn hash_liest_ueber_die_puffergrenze_hinaus_korrekt() {
        // Der Streaming-Puffer ist 64 KiB. Eine groessere Datei deckt ab, dass
        // ueber mehrere Durchlaeufe korrekt weitergehasht wird.
        let dir = tempdir("hash-gross");
        let file = dir.join("gross.mp3");
        let payload = vec![7u8; 200 * 1024];
        std::fs::write(&file, &payload).unwrap();

        let mut expected = Sha256::new();
        expected.update(&payload);
        assert_eq!(hash_file(&file).unwrap(), format!("{:x}", expected.finalize()));
    }

    #[test]
    fn wartet_bis_eine_wachsende_datei_fertig_geschrieben_ist() {
        // Der wichtigste Test der Phase: Drive schreibt schubweise. Ohne den
        // Stabilitaetscheck laedt der Agent eine halbe MP3 hoch - und weil der
        // Hash davon "stimmt", wuerde der Dedup diesen kaputten Stand fuer
        // immer als bekannt durchwinken.
        let dir = tempdir("stabil");
        let file = dir.join("waechst.mp3");
        std::fs::write(&file, vec![0u8; 1024]).unwrap();

        let writer_path = file.clone();
        let writer = std::thread::spawn(move || {
            for _ in 0..3 {
                std::thread::sleep(Duration::from_millis(700));
                let mut handle = std::fs::OpenOptions::new()
                    .append(true)
                    .open(&writer_path)
                    .unwrap();
                handle.write_all(&vec![0u8; 1024]).unwrap();
            }
        });

        let (size, _mtime) = wait_until_stable(&file).expect("haette stabil werden muessen");
        writer.join().unwrap();

        // 1 KiB Start plus dreimal 1 KiB nachgeschoben. Ein zu frueher Abbruch
        // haette 1024, 2048 oder 3072 gemeldet.
        assert_eq!(size, 4096, "hat zu frueh abgebrochen und eine halbe Datei gemeldet");
    }

    #[test]
    fn meldet_verschwundene_datei_statt_ewig_zu_warten() {
        let dir = tempdir("weg");
        let file = dir.join("weg.mp3");
        std::fs::write(&file, b"x").unwrap();
        std::fs::remove_file(&file).unwrap();
        assert!(wait_until_stable(&file).is_none());
    }
}
