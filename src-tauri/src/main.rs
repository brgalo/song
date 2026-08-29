#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! songou - Desktop-App und Sync-Agent in einem.
//!
//! Verhaelt sich wie Google Drive: startet mit Windows, sitzt im Tray,
//! beobachtet den pre_pro-Ordner und spiegelt neue Bounces nach R2 und D1.
//! Das Fenster ist nur die Oberflaeche dazu - Schliessen beendet nichts.

mod api;
mod settings;
mod sync;

use std::sync::Arc;
use sync::{PeaksResult, SyncState};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_notification::NotificationExt;

const FEED_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(300);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    api_base_url: String,
    pre_pro_path: String,
    notifications_enabled: bool,
    /// Das Token selbst verlaesst den Rust-Teil nicht - die Oberflaeche muss
    /// nur wissen, ob eines hinterlegt ist.
    has_token: bool,
}

#[tauri::command]
fn get_settings(state: tauri::State<Arc<SyncState>>) -> SettingsView {
    let settings = state.settings_snapshot();
    SettingsView {
        api_base_url: settings.api_base_url.clone(),
        pre_pro_path: settings.pre_pro_path.clone(),
        notifications_enabled: settings.notifications_enabled,
        has_token: !settings.device_token.is_empty(),
    }
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    state: tauri::State<Arc<SyncState>>,
    api_base_url: Option<String>,
    device_token: Option<String>,
    pre_pro_path: String,
) -> Result<(), String> {
    {
        let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
        // Leer gelassen heisst "die uebliche Adresse" - so muss beim ersten
        // Start niemand eine URL abtippen.
        let url = api_base_url.unwrap_or_default();
        let url = url.trim().trim_end_matches('/');
        settings.api_base_url = if url.is_empty() {
            settings::DEFAULT_API_BASE_URL.to_string()
        } else {
            url.to_string()
        };
        settings.pre_pro_path = pre_pro_path.trim().to_string();
        // Ein leeres Feld bedeutet "unveraendert lassen", nicht "loeschen" -
        // sonst wirft ein Speichern der Ordnereinstellung das Token weg.
        if let Some(token) = device_token {
            if !token.trim().is_empty() {
                settings.device_token = token.trim().to_string();
            }
        }
        settings.save()?;
    }
    sync::start(&app);
    Ok(())
}

#[tauri::command]
fn sync_status(state: tauri::State<Arc<SyncState>>) -> String {
    state.tray_label()
}

/// Nimmt das Ergebnis aus dem versteckten Peaks-Fenster entgegen.
#[tauri::command]
fn peaks_ready(
    state: tauri::State<Arc<SyncState>>,
    version_id: String,
    duration: f64,
    peaks: Vec<Vec<f32>>,
) {
    state.peaks.fulfill(&version_id, PeaksResult { duration, peaks });
}

/// Durchreiche fuer die Oberflaeche. Sie schickt Methode, Pfad und Body;
/// Token und Basis-URL ergaenzt Rust. Die Antwort kommt als geparstes JSON
/// zurueck, damit die Oberflaeche nicht zweimal parsen muss.
#[tauri::command]
async fn api_request(
    state: tauri::State<'_, Arc<SyncState>>,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<serde_json::Value, String> {
    // Erst kopieren, dann awaiten - ein MutexGuard darf keinen await ueberleben.
    let settings = state.settings_snapshot();
    if !settings.is_configured() {
        return Err("Noch nicht eingerichtet".to_string());
    }
    let text = api::Api::new(&settings.api_base_url, &settings.device_token)
        .raw(&method, &path, body)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Audio aus R2 holen, wenn die Datei lokal nicht vorliegt.
#[tauri::command]
async fn fetch_audio(
    state: tauri::State<'_, Arc<SyncState>>,
    version_id: String,
) -> Result<Vec<u8>, String> {
    let settings = state.settings_snapshot();
    api::Api::new(&settings.api_base_url, &settings.device_token)
        .audio(&version_id)
        .await
        .map_err(|e| e.to_string())
}

/// Ordnerauswahl. Bewusst in Rust statt ueber die JS-Seite des Dialog-Plugins:
/// die Oberflaeche laeuft ohne Bundler, und so braucht sie kein npm-Paket.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path.map(|p| p.to_string()));
    });
    rx.await.ok().flatten()
}

/// Oeffnet die Kopplungsseite im Systembrowser.
#[tauri::command]
fn open_pair_page(app: AppHandle, url: String) -> Result<(), String> {
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Bleibt aus der frueheren Fassung erhalten: das Peaks-Fenster liest die
/// Datei darueber, und die Oberflaeche spielt lokale Dateien damit ab.
#[tauri::command]
fn load_audio_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|err| err.to_string())
}

/// Wo liegt die Datei mit diesem Hash lokal? Grundlage dafuer, dass die
/// Oberflaeche die Platte bevorzugt, statt aus R2 zu laden.
#[tauri::command]
fn local_path_for(state: tauri::State<Arc<SyncState>>, sha256: String) -> Option<String> {
    state.index.local_path_for(&sha256)
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn toggle_notifications(app: &AppHandle) {
    let state = app.state::<Arc<SyncState>>().inner().clone();
    // Bewusst ein explizites let statt `if let ... .lock()`: in Edition 2021
    // lebt der Temporary des if-let bis zum Blockende und ueberlebt damit das
    // Arc, aus dem er geborgt ist.
    let Ok(mut settings) = state.settings.lock() else {
        return;
    };
    settings.notifications_enabled = !settings.notifications_enabled;
    let _ = settings.save();
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<Arc<SyncState>>();
    let notifications_on = state.settings_snapshot().notifications_enabled;

    let open = MenuItem::with_id(app, "open", "Öffnen", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", "Status …", false, None::<&str>)?;
    let folder = MenuItem::with_id(app, "folder", "Ordner wählen …", true, None::<&str>)?;
    let notify = CheckMenuItem::with_id(
        app,
        "notify",
        "Benachrichtigungen",
        true,
        notifications_on,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &status,
            &PredefinedMenuItem::separator(app)?,
            &folder,
            &notify,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let status_item = status.clone();
    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().cloned().unwrap())
        .tooltip("songou")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| {
            match event.id().as_ref() {
                "open" => show_main_window(app),
                "folder" => {
                    let _ = app.emit("choose-folder", ());
                    show_main_window(app);
                }
                "notify" => toggle_notifications(app),
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .build(app)?;

    // Der Statuseintrag zeigt, was der Ingest gerade tut.
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let state = app_handle.state::<Arc<SyncState>>();
            let _ = status_item.set_text(state.tray_label());
        }
    });

    Ok(())
}

/// Pollt den Feed und meldet neue Versionen. Eigene Uploads werden
/// uebersprungen - niemand will erfahren, dass er selbst etwas hochgeladen hat.
fn start_feed_poller(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut identity: Option<String> = None;
        loop {
            tokio::time::sleep(FEED_POLL_INTERVAL).await;

            let state = app.state::<Arc<SyncState>>();
            let settings = state.settings_snapshot();
            if !settings.is_configured() {
                continue;
            }
            if identity.is_none() {
                identity = sync::own_identity(&settings).await;
            }

            let client = api::Api::new(&settings.api_base_url, &settings.device_token);

            if let Ok(usage) = client.usage().await {
                if let Ok(mut storage) = state.storage.lock() {
                    *storage = Some((usage.bytes, usage.limit_bytes));
                }
            }

            let Ok(feed) = client.feed(&settings.last_feed_seen).await else {
                continue;
            };

            let fresh: Vec<_> = feed
                .versions
                .iter()
                .filter(|v| identity.as_deref() != Some(v.uploaded_by.as_str()))
                .collect();

            if settings.notifications_enabled && !fresh.is_empty() {
                let body = if fresh.len() <= 2 {
                    fresh
                        .iter()
                        .map(|v| format!("{} — {}", v.song_name, v.filename))
                        .collect::<Vec<_>>()
                        .join("\n")
                } else {
                    format!("{} neue Versionen", fresh.len())
                };
                let _ = app
                    .notification()
                    .builder()
                    .title("Neuer Song zum Kommentieren")
                    .body(body)
                    .show();
            }

            // Auch ohne Benachrichtigung fortschreiben, sonst staut sich der
            // Feed und meldet beim Wiedereinschalten alles auf einmal.
            if let Ok(mut stored) = state.settings.lock() {
                stored.last_feed_seen = feed.now.clone();
                let _ = stored.save();
            }
            drop(state);
            let _ = app.emit("feed-updated", ());
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(Arc::new(SyncState::new()))
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            sync_status,
            peaks_ready,
            load_audio_file,
            local_path_for,
            api_request,
            fetch_audio,
            open_pair_page,
            pick_folder,
        ])
        .on_window_event(|window, event| {
            // Schliessen versteckt nur. Der Agent soll weiterlaufen, sonst
            // kommen bei den anderen keine neuen Songs an.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let handle = app.handle();
            build_tray(handle)?;

            let configured = {
                let state = app.state::<Arc<SyncState>>();
                state.settings_snapshot().is_configured()
            };
            // Eingerichtet -> unsichtbar ins Tray. Noch nicht eingerichtet ->
            // Fenster zeigen, sonst findet niemand die Einrichtung.
            if !configured {
                show_main_window(handle);
            }

            sync::start(handle);
            start_feed_poller(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Fehler beim Starten der Tauri App");
}
