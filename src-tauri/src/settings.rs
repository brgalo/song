//! Einstellungen und lokaler Hash-Index.
//!
//! Zwei getrennte Dateien mit Absicht: der Index wird bei jedem Scan
//! fortgeschrieben, die Einstellungen sollen dabei nicht mitrotieren. Der Index
//! ist reiner Cache und darf jederzeit geloescht werden - beim naechsten
//! Startlauf baut er sich neu auf.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// Konfigurationsverzeichnis: %APPDATA%\BandTool unter Windows, sonst
/// ~/.config/BandTool. Uebernimmt das Muster der frueheren local_user_path().
fn config_dir() -> PathBuf {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default());
    let dir = base.join("BandTool");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

fn index_path() -> PathBuf {
    config_dir().join("index.json")
}

/// Die Adresse der Band-Installation. Oeffentlich und fuer alle gleich,
/// deshalb einkompiliert statt abgefragt - niemand soll sie beim ersten Start
/// abtippen muessen. Kein Geheimnis: ohne gueltiges Geraetetoken kommt an
/// dieser Adresse niemand weiter. Im Einrichtungsschritt ueberschreibbar.
pub const DEFAULT_API_BASE_URL: &str = "https://songou-api.andyrive6.workers.dev";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Oeffentliche URL, kein Geheimnis.
    #[serde(default = "default_api_base_url")]
    pub api_base_url: String,
    /// Geheim und geraetegebunden. Kommt zur Laufzeit aus /pair und wird
    /// bewusst NICHT einkompiliert - aus einer Binary waere es auslesbar.
    pub device_token: String,
    /// Wurzel des von Drive synchronisierten pre_pro-Ordners.
    pub pre_pro_path: String,
    pub notifications_enabled: bool,
    /// Zeitstempel des zuletzt gesehenen Feed-Eintrags.
    pub last_feed_seen: String,
}

fn default_api_base_url() -> String {
    DEFAULT_API_BASE_URL.to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            api_base_url: default_api_base_url(),
            device_token: String::new(),
            pre_pro_path: String::new(),
            notifications_enabled: true,
            last_feed_seen: "1970-01-01T00:00:00.000Z".to_string(),
        }
    }
}

impl Settings {
    pub fn load() -> Self {
        fs::read_to_string(settings_path())
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<(), String> {
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        write_atomic(&settings_path(), json.as_bytes())
    }

    /// Erst wenn beides gesetzt ist, kann der Agent ueberhaupt etwas tun.
    pub fn is_configured(&self) -> bool {
        !self.api_base_url.is_empty() && !self.device_token.is_empty()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct IndexEntry {
    pub path: String,
    pub size: u64,
    /// Sekunden seit Epoch. Zusammen mit size erkennt der Startlauf, ob eine
    /// bekannte Datei ersetzt wurde und neu gehasht werden muss.
    pub mtime: u64,
}

/// sha256 -> wo die Datei lokal liegt. Grundlage dafuer, dass die Oberflaeche
/// spaeter die Platte bevorzugt, statt aus R2 zu laden.
#[derive(Default)]
pub struct HashIndex {
    entries: Mutex<HashMap<String, IndexEntry>>,
}

impl HashIndex {
    pub fn load() -> Self {
        let entries = fs::read_to_string(index_path())
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self {
            entries: Mutex::new(entries),
        }
    }

    pub fn local_path_for(&self, sha256: &str) -> Option<String> {
        let entries = self.entries.lock().ok()?;
        let entry = entries.get(sha256)?;
        // Der Index kann veralten - eine geloeschte oder verschobene Datei
        // darf nicht als vorhanden gemeldet werden.
        std::path::Path::new(&entry.path)
            .is_file()
            .then(|| entry.path.clone())
    }

    /// Ist der Pfad mit exakt dieser Groesse und Zeit schon erfasst? Dann muss
    /// er nicht erneut gehasht werden - das spart beim Startlauf das Lesen
    /// jeder einzelnen Datei.
    pub fn is_current(&self, path: &str, size: u64, mtime: u64) -> bool {
        let Ok(entries) = self.entries.lock() else {
            return false;
        };
        entries
            .values()
            .any(|e| e.path == path && e.size == size && e.mtime == mtime)
    }

    pub fn record(&self, sha256: &str, entry: IndexEntry) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(sha256.to_string(), entry);
            if let Ok(json) = serde_json::to_string(&*entries) {
                let _ = write_atomic(&index_path(), json.as_bytes());
            }
        }
    }
}

/// Erst in eine Nebendatei schreiben, dann umbenennen. Verhindert, dass ein
/// Absturz mitten im Schreiben eine halbe JSON-Datei hinterlaesst, die beim
/// naechsten Start nicht mehr lesbar ist.
fn write_atomic(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}
