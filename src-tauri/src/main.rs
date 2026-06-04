#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::env;
use std::path::PathBuf;
use serde::Serialize;

#[derive(Serialize)]
struct AudioVersion {
    name: String,
    path: String,
}

#[derive(Serialize)]
struct SongFolder {
    name: String,
    versions: Vec<AudioVersion>,
}

// Gibt den Pfad zur lokalen user.json zurück (%APPDATA%\BandTool\user.json)
// Fällt auf das aktuelle Verzeichnis zurück wenn APPDATA nicht gesetzt ist.
fn local_user_path() -> PathBuf {
    let base = env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::current_dir().unwrap_or_default());
    let dir = base.join("BandTool");
    let _ = fs::create_dir_all(&dir); // Ordner anlegen falls nicht vorhanden
    dir.join("user.json")
}

/// Liest den lokal gespeicherten Usernamen.
/// Gibt "" zurück wenn noch nichts gespeichert wurde.
#[tauri::command]
fn read_local_user() -> String {
    let path = local_user_path();
    fs::read_to_string(&path).unwrap_or_default()
}

/// Speichert den Usernamen lokal in %APPDATA%\BandTool\user.json
#[tauri::command]
fn save_local_user(username: String) -> Result<(), String> {
    let path = local_user_path();
    fs::write(&path, &username).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_config() -> Result<String, String> {
    if let Ok(content) = fs::read_to_string("config.json") {
        return Ok(content);
    }
    match fs::read_to_string("../config.json") {
        Ok(content) => Ok(content),
        Err(err) => Err(format!("Config weder hier noch drüber gefunden: {}", err)),
    }
}

#[tauri::command]
fn load_audio_file(path: String) -> Result<Vec<u8>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(bytes),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn read_comments(folder_path: String) -> Result<String, String> {
    let mut path = PathBuf::from(&folder_path);
    path.push("comments.json");
    println!("Lese Kommentare aus: {:?}", path);
    match fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(_) => {
            println!("Keine comments.json gefunden.");
            Ok("[]".to_string())
        },
    }
}

#[tauri::command]
fn save_comments(folder_path: String, comments_json: String) -> Result<(), String> {
    let mut path = PathBuf::from(&folder_path);
    path.push("comments.json");
    println!("SPEICHERE KOMMENTARE NACH: {:?}", path);
    match fs::write(&path, comments_json) {
        Ok(_) => { println!("Speichern erfolgreich!"); Ok(()) },
        Err(err) => { println!("FEHLER BEIM SPEICHERN: {}", err); Err(err.to_string()) },
    }
}

#[tauri::command]
fn scan_directory() -> Result<Vec<SongFolder>, String> {
    let root_dir = env::current_dir().map_err(|e| e.to_string())?;
    println!("Scanne Ordner: {:?}", root_dir);
    let mut songs = Vec::new();
    let entries = fs::read_dir(&root_dir).map_err(|e| e.to_string())?;

    for entry in entries {
        if let Ok(entry) = entry {
            let path = entry.path();
            if path.is_dir() {
                let folder_name = entry.file_name().into_string().unwrap_or_default();
                if folder_name.starts_with('.') || folder_name == "src"
                    || folder_name == "src-tauri" || folder_name == "node_modules" {
                    continue;
                }
                let mut versions = Vec::new();
                if let Ok(sub_entries) = fs::read_dir(&path) {
                    for sub_entry in sub_entries {
                        if let Ok(sub_entry) = sub_entry {
                            let sub_path = sub_entry.path();
                            if sub_path.is_file() {
                                if let Some(ext) = sub_path.extension().and_then(|e| e.to_str()) {
                                    if ext == "wav" || ext == "mp3" {
                                        versions.push(AudioVersion {
                                            name: sub_entry.file_name().into_string().unwrap_or_default(),
                                            path: sub_path.to_string_lossy().replace('\\', "/"),
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
                if !versions.is_empty() {
                    songs.push(SongFolder { name: folder_name, versions });
                }
            }
        }
    }
    Ok(songs)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            read_config,
            load_audio_file,
            scan_directory,
            read_comments,
            save_comments,
            read_local_user,
            save_local_user,
        ])
        .run(tauri::generate_context!())
        .expect("Fehler beim Starten der Tauri App");
}
